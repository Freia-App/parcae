/**
 * CORS: the static `TRUSTED_ORIGINS` list plus the optional runtime
 * `isTrustedOrigin` check.
 *
 * Both transports are driven over a real listening server: the HTTP CORS
 * middleware via plain requests and preflights, and the Socket.IO handshake
 * via an Engine.IO polling request on `/ws`, which runs the `cors.origin`
 * callback. Each case asserts the two transports reach the same decision.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createServer_,
  listenServer,
  type ServerContext,
  type TrustedOriginCheck,
} from "../server";
import { shutdownResources } from "../shutdown";
import { log } from "../logger";

const STATIC = "https://app.example.com";
const CLINIC = "https://portal.clinic.example";
const STRANGER = "https://evil.example";

let server: ServerContext | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await shutdownResources(server);
  server = null;
});

async function start(isTrustedOrigin?: TrustedOriginCheck): Promise<string> {
  server = createServer_({
    config: { TRUSTED_ORIGINS: STATIC } as any,
    version: "v1",
    isTrustedOrigin,
  });
  server.polka.get("/ping", (_req: any, res: any) => res.end("pong"));
  await listenServer(server.httpServer, 0);
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}`;
}

/** Decision as seen by the HTTP middleware on a real GET. */
async function httpAllows(base: string, origin: string): Promise<boolean> {
  const res = await fetch(`${base}/ping`, { headers: { Origin: origin } });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("pong");
  return readAllowed(res, origin);
}

/** Decision as seen by the HTTP middleware on an OPTIONS preflight. */
async function preflightAllows(base: string, origin: string): Promise<boolean> {
  const res = await fetch(`${base}/ping`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  expect(res.status).toBe(204);
  return readAllowed(res, origin);
}

/** Decision as seen by the Socket.IO handshake (Engine.IO polling open). */
async function socketAllows(base: string, origin: string): Promise<boolean> {
  const res = await fetch(`${base}/ws/?EIO=4&transport=polling`, {
    headers: { Origin: origin },
  });
  await res.text();
  if (res.status === 400) {
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    return false;
  }
  expect(res.status).toBe(200);
  return readAllowed(res, origin);
}

function readAllowed(res: Response, origin: string): boolean {
  const allowOrigin = res.headers.get("access-control-allow-origin");
  if (allowOrigin === null) return false;
  // Never a wildcard: credentials require the specific origin echoed back.
  expect(allowOrigin).toBe(origin);
  expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  return true;
}

async function decisions(base: string, origin: string) {
  return {
    http: await httpAllows(base, origin),
    preflight: await preflightAllows(base, origin),
    socket: await socketAllows(base, origin),
  };
}

const ALLOWED = { http: true, preflight: true, socket: true };
const DENIED = { http: false, preflight: false, socket: false };

describe("CORS origins", () => {
  it("allows the static list and denies everything else without a callback", async () => {
    const base = await start();

    expect(await decisions(base, STATIC)).toEqual(ALLOWED);
    expect(await decisions(base, CLINIC)).toEqual(DENIED);
  });

  it("does not consult the callback for origins the static list allows", async () => {
    const check = vi.fn(() => false);
    const base = await start(check);

    expect(await decisions(base, STATIC)).toEqual(ALLOWED);
    expect(check).not.toHaveBeenCalled();
  });

  it("allows an origin the callback accepts", async () => {
    const check = vi.fn((origin: string) => origin === CLINIC);
    const base = await start(check);

    expect(await decisions(base, CLINIC)).toEqual(ALLOWED);
    expect(check).toHaveBeenCalledWith(CLINIC);
  });

  it("denies an origin the callback rejects", async () => {
    const base = await start((origin) => origin === CLINIC);

    expect(await decisions(base, STRANGER)).toEqual(DENIED);
  });

  it("supports an async callback", async () => {
    const base = await start(async (origin) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return origin === CLINIC;
    });

    expect(await decisions(base, CLINIC)).toEqual(ALLOWED);
    expect(await decisions(base, STRANGER)).toEqual(DENIED);
  });

  it("denies, and keeps serving, when the callback throws", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    const base = await start(() => {
      throw new Error("lookup failed");
    });

    expect(await decisions(base, CLINIC)).toEqual(DENIED);
    expect(logged).toHaveBeenCalled();
    // The static list still works after a failing runtime check.
    expect(await decisions(base, STATIC)).toEqual(ALLOWED);
  });

  it("denies when the callback rejects", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    const base = await start(async () => {
      throw new Error("db down");
    });

    expect(await decisions(base, CLINIC)).toEqual(DENIED);
  });

  it("treats a truthy non-boolean result as a denial", async () => {
    const base = await start(() => "yes" as unknown as boolean);

    expect(await decisions(base, CLINIC)).toEqual(DENIED);
  });

  it("logs a failing origin without its query string", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    const base = await start(() => {
      throw new Error("lookup failed");
    });

    // Browsers never send one, but a hand-crafted header can.
    await httpAllows(base, `${CLINIC}?token=secret`);

    const line = logged.mock.calls.flat().map(String).join(" ");
    expect(line).toContain(CLINIC);
    expect(line).not.toContain("secret");
  });

  it("asks the callback fresh each time, so origins added at runtime take effect", async () => {
    const verified = new Set<string>();
    const base = await start((origin) => verified.has(origin));

    expect(await decisions(base, CLINIC)).toEqual(DENIED);
    verified.add(CLINIC);
    expect(await decisions(base, CLINIC)).toEqual(ALLOWED);
  });
});
