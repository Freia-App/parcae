/**
 * Every line names who and what it is about from the frame it was written
 * in, and a caller field cannot carry prose. The frame paths are driven
 * through the seams that open them: the HTTP middleware, a socket
 * listener, a job enqueued from a request, a cron tick, and an outbound
 * call; plus the callback that leaves its frame.
 */
import { EventEmitter } from "node:events";
import { AsyncResource } from "node:async_hooks";
import http from "node:http";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireCron, runJob } from "../app";
import {
  captureLogs,
  type Line,
  log,
  socketFrameOf,
  withLogContext,
} from "../log";
import { observeOutboundCalls, providerOf, templatePath } from "../outbound";
import { createServer_, listenServer, type ServerContext } from "../server";
import { _clearServices, _setServices, enqueue } from "../services/context";
import { shutdownResources } from "../shutdown";
import { listenSafely } from "../socket-guards";

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.stop();
});

const lines = (msg: string) => logs.lines.filter((l) => l.msg === msg);
const UUID = /^[0-9a-f-]{36}$/;

describe("the field rule", () => {
  it("drops prose and keeps identifiers, counting what it dropped", () => {
    log.warn("x", { note: "patient said their knee hurts" });
    log.warn("y", { connectionId: "conn_8fK2", status: 424 });
    const [dropped, kept] = logs.lines;
    expect(dropped).not.toHaveProperty("note");
    expect(dropped!.droppedFields).toBe(1);
    expect(kept).toMatchObject({ connectionId: "conn_8fK2", status: 424 });
    expect(kept).not.toHaveProperty("droppedFields");
  });

  it("drops long strings, arrays, objects and email addresses", () => {
    log.info("z", {
      long: "a".repeat(81),
      edge: "b".repeat(80),
      list: ["a"],
      nested: { a: 1 },
      email: "jane@example.com",
    });
    expect(logs.lines[0]).toMatchObject({ edge: "b".repeat(80), droppedFields: 4 });
  });

  it("keeps an error's name, code and status, never its message", () => {
    const err = Object.assign(new Error("Key (email)=(jane@example.com) exists"), {
      code: "23505",
      status: 409,
    });
    log.error("[db] write failed", { error: err });
    log.error("[db] whole error", err as never);
    const [a, b] = logs.lines;
    expect(a).toMatchObject({
      tag: "db",
      msg: "write failed",
      errorName: "Error",
      errorCode: "23505",
      errorStatus: 409,
    });
    expect(JSON.stringify(logs.lines)).not.toContain("jane");
    expect(b).toMatchObject({ errorName: "Error", errorCode: "23505" });
  });

  it("lets a field fill a context key nobody set, never override one", () => {
    withLogContext({ user: "user_A", org: null }, () => {
      log.info("[cron] per clinic", { user: "user_B", org: "org_9" });
    });
    expect(logs.lines[0]).toMatchObject({ user: "user_A", org: "org_9" });
  });

  it("writes every key of the line shape, null when unknown", () => {
    log.info("bare");
    expect(Object.keys(logs.lines[0]!).sort()).toEqual(
      [
        "schema", "at", "level", "msg", "tag", "service", "environment",
        "deployment", "lane", "task", "user", "org", "role", "ip", "app",
        "appVersion", "platform", "requestId", "operationId", "parentId",
        "trigger", "job",
      ].sort(),
    );
    expect(logs.lines[0]!.schema).toBe("freia.log.v2");
  });
});

describe("the request frame", () => {
  let server: ServerContext | null = null;
  afterEach(async () => {
    if (server) await shutdownResources(server);
    server = null;
  });

  async function start(): Promise<string> {
    server = createServer_({ config: {} as never, version: "v1" });
    server.polka.get("/v1/health", (_req: any, res: any) => res.end("ok"));
    // Identity lands on the request after the frame opened, as the API's
    // auth middleware sets it per route.
    server.polka.get("/v1/patients/:id", (req: any, res: any) => {
      req.userId = "user_2xyzABC";
      req.orgId = "org_2clinic";
      req.role = "clinician";
      res.end("{}");
    });
    server.polka.get("/v1/slow", (req: any) => {
      req.userId = "user_2xyzABC";
    });
    await listenServer(server.httpServer, 0);
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return `http://127.0.0.1:${address.port}`;
  }

  it("writes one line naming the user, clinic and app, and no IP", async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/patients/AbCdEf1234567890XyZ0?tab=x`, {
      headers: {
        "X-Freia-Client": "dashboard/2026.11.07/web",
        "X-Forwarded-For": "203.0.113.9",
      },
    });
    expect(res.status).toBe(200);
    const [line] = lines("request responded");
    expect(line).toMatchObject({
      user: "user_2xyzABC",
      org: "org_2clinic",
      role: "clinician",
      app: "dashboard",
      appVersion: "2026.11.07",
      platform: "web",
      route: "/v1/patients/:id",
      method: "GET",
      status: 200,
      transport: "http",
      trigger: "interactive",
      ip: null,
    });
    expect(line!.requestId).toMatch(UUID);
    expect(line!.operationId).toBe(line!.requestId);
    expect(res.headers.get("x-freia-operation-id")).toBe(line!.requestId);
    expect(typeof line!.durationMs).toBe("number");
  });

  it("writes no line for the health check", async () => {
    const base = await start();
    await fetch(`${base}/v1/health`);
    expect(lines("request responded")).toEqual([]);
  });

  it("answers preflight allowing the client header", async () => {
    server = createServer_({
      config: { TRUSTED_ORIGINS: "https://app.example.com" } as never,
      version: "v1",
    });
    await listenServer(server.httpServer, 0);
    const address = server.httpServer.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/x`, {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "X-Freia-Client",
    );
  });

  it("keeps the frame for a request the client abandons", async () => {
    const base = await start();
    const abort = new AbortController();
    const pending = fetch(`${base}/v1/slow`, { signal: abort.signal }).catch(
      () => null,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    abort.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [line] = lines("request responded");
    expect(line).toMatchObject({ aborted: true, user: "user_2xyzABC" });
    expect(line!.requestId).toMatch(UUID);
  });
});

describe("a callback that leaves its frame", () => {
  it("loses the frame unless bound, which is why the seams bind", () => {
    const events = new EventEmitter();
    withLogContext({ requestId: "req-1", user: "user_A" }, () => {
      events.on("unbound", () => log.info("unbound"));
      events.on(
        "bound",
        AsyncResource.bind(() => log.info("bound")),
      );
    });
    events.emit("unbound");
    events.emit("bound");
    expect(lines("unbound")[0]).toMatchObject({ requestId: null, user: null });
    expect(lines("bound")[0]).toMatchObject({ requestId: "req-1", user: "user_A" });
  });
});

describe("the socket frame", () => {
  it("restores the connection's frame on every listener", async () => {
    const socket = new EventEmitter();
    Object.assign(socketFrameOf(socket), {
      trigger: "socket",
      ip: "203.0.113.9",
      user: "user_2xyzABC",
      app: "mobile",
      appVersion: "2.47.0",
    });
    listenSafely(socket, "resync", () => log.info("[socket] resync served"));
    listenSafely(socket, "renew", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw new Error("boom");
    });
    // Emitted from outside any frame, as socket.io's IO does.
    setImmediate(() => {
      socket.emit("resync");
      socket.emit("renew");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const line of [...lines("resync served"), ...lines("handler failed")]) {
      expect(line).toMatchObject({
        trigger: "socket",
        ip: "203.0.113.9",
        user: "user_2xyzABC",
        app: "mobile",
      });
    }
    expect(lines("handler failed")[0]).toMatchObject({ event: "renew", errorName: "Error" });
  });
});

describe("the job frame", () => {
  const added: Array<{ name: string; data: any }> = [];
  beforeEach(() => {
    added.length = 0;
    const queue = {
      add: async (name: string, data: any) => {
        added.push({ name, data });
        return { id: "1" };
      },
    };
    _setServices(
      { queueNameFor: (n: string) => n, get: () => queue } as never,
      {} as never,
    );
  });
  afterEach(() => _clearServices());

  it("runs a job enqueued from a request under the request, with a fresh operation", async () => {
    const req = { userId: "user_2xyzABC", orgId: "org_2clinic", headers: {} };
    await withLogContext(
      {
        req,
        requestId: "11111111-1111-4111-8111-111111111111",
        operationId: "11111111-1111-4111-8111-111111111111",
        trigger: "interactive",
        app: "portal",
      },
      () => enqueue("results:notify-patient", { resultId: "r1" }),
    );
    const [{ data }] = added as [{ name: string; data: any }];
    expect(data.resultId).toBe("r1");

    await runJob(
      {
        name: "results:notify-patient",
        options: {},
        handler: async () => log.info("[results] notified"),
      },
      { data, attemptsMade: 0 } as unknown as Job,
    );
    const [line] = lines("notified");
    expect(line).toMatchObject({
      requestId: "11111111-1111-4111-8111-111111111111",
      parentId: "11111111-1111-4111-8111-111111111111",
      user: "user_2xyzABC",
      org: "org_2clinic",
      app: "portal",
      trigger: "interactive",
      job: "results:notify-patient",
      ip: null,
    });
    expect(line!.operationId).toMatch(UUID);
    expect(line!.operationId).not.toBe(line!.parentId);
  });

  it("gives a cron tick a scheduled frame that what it enqueues names as parent", async () => {
    await fireCron(
      {
        name: "results:digest",
        pattern: "0 7 * * *",
        options: {},
        handler: async () => {
          log.info("[results] digest tick");
          await enqueue("results:digest-one", { org: "org_2clinic" });
        },
      },
      { tryLock: async () => true },
    );
    const [tick] = lines("digest tick");
    expect(tick).toMatchObject({ trigger: "scheduled", job: "results:digest" });
    expect(tick!.operationId).toMatch(UUID);
    expect(added[0]!.data._ctx).toMatchObject({
      operationId: tick!.operationId,
      trigger: "scheduled",
    });
  });
});

describe("outbound calls", () => {
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    observeOutboundCalls();
    server = http.createServer((req, res) => {
      res.statusCode = req.url?.startsWith("/fail") ? 503 : 200;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("writes one line per fetch and http call, in the caller's frame", async () => {
    await withLogContext({ user: "user_2xyzABC", requestId: "req-7" }, async () => {
      await fetch(`${base}/v2/userInfo/AbCdEf1234567890XyZ0?user_id=x`).then((r) =>
        r.text(),
      );
      await new Promise<void>((resolve) => {
        http.get(`${base}/fail/123`, (res) => {
          res.resume();
          res.on("end", resolve);
        });
      });
    });
    const outbound = lines("outbound");
    expect(outbound.map((l: Line) => [l.endpoint, l.status, l.user, l.requestId])).toEqual([
      ["/v2/userInfo/:id", 200, "user_2xyzABC", "req-7"],
      ["/fail/:id", 503, "user_2xyzABC", "req-7"],
    ]);
    expect(outbound[0]).toMatchObject({ provider: "other", method: "GET", level: "info" });
    expect(outbound[1]!.level).toBe("warn");
    expect(typeof outbound[0]!.durationMs).toBe("number");
  });

  it("names providers by host and keeps record ids and file names out of the endpoint", () => {
    expect(
      [
        "api.tryterra.co",
        "api.clerk.com",
        "bedrock-runtime.ap-southeast-2.amazonaws.com",
        "freia-files.s3.ap-southeast-2.amazonaws.com",
        "openrouter.ai",
        "example.org",
      ].map(providerOf),
    ).toEqual(["terra", "clerk", "bedrock", "s3", "openrouter", "other"]);
    expect(templatePath("/v1/users/user_2abcDEF9/organization_memberships")).toBe(
      "/v1/users/:id/organization_memberships",
    );
    expect(templatePath("/v1/customers/cus_P1aBcDeF?expand=x")).toBe("/v1/customers/:id");
    expect(templatePath("/model/au.anthropic.claude-haiku-5-5%3A0/converse")).toBe(
      "/model/:id/converse",
    );
    expect(templatePath("/files/Jane%20Smith%20bloods.pdf")).toBe("/files/:id");
  });
});
