/**
 * @parcae/backend — HTTP + WebSocket Server
 *
 * Polka (Express-compatible) for HTTP, Socket.IO for WebSocket.
 * Both share the same route registry via Trouter.
 */

import { AsyncResource } from "node:async_hooks";
import { createServer } from "node:http";
import { parse as parseQuery } from "node:querystring";
import polka from "polka";
import { Server as SocketServer } from "socket.io";
import bodyParser, { type OptionsJson } from "body-parser";
import type { Config } from "./config";
import { ClientError, error } from "./helpers";
import { parseClientIdentity } from "./client-identity";
import {
  BLANK_CONTEXT,
  currentFrame,
  log,
  newOperationId,
  runInFrame,
} from "./log";
import { templatePath } from "./outbound";

export interface ServerContext {
  polka: ReturnType<typeof polka>;
  io: SocketServer;
  httpServer: ReturnType<typeof createServer>;
}

/**
 * Runtime CORS check for origins the static `TRUSTED_ORIGINS` list does not
 * cover, e.g. customer domains added after boot. Resolve `true` to allow.
 * Anything else, including a throw or rejection, denies the origin.
 *
 * `path` is the HTTP request's path (no query), the same for a preflight and
 * the request it precedes, so an app can admit an origin on chosen routes
 * only. The Socket.IO handshake passes none.
 */
export type TrustedOriginCheck = (
  origin: string,
  path?: string,
) => boolean | Promise<boolean>;

export interface ServerOptions {
  config: Config;
  version: string;
  /** See `AppConfig.isTrustedOrigin`. */
  isTrustedOrigin?: TrustedOriginCheck;
}

/**
 * Create and configure the HTTP + WebSocket server.
 * Does NOT start listening — call server.listen() separately.
 */
/**
 * JSON body-parser options for every app this factory builds. Exported so the
 * regression test exercises the real configuration instead of a copy that can
 * silently drift away from it.
 */
export const JSON_BODY_PARSER_OPTIONS: OptionsJson = {
  limit: "50mb",
  // Webhook senders routinely use an RFC 6839 structured suffix instead of
  // plain application/json: LiveKit posts application/webhook+json.
  // body-parser's default matches application/json exactly, so without this
  // those requests skip the parser, arrive with an empty body and an unset
  // rawBody, and every signature check fails closed.
  type: ["application/json", "application/*+json"],
  // Stash the unparsed body so webhook handlers can verify HMAC signatures
  // (Stripe, GitHub, Svix, etc.) against the exact bytes the sender signed.
  // body-parser discards the raw stream once it parses, and a re-serialised
  // object is not byte-identical to the original, so verification needs the
  // buffer captured here.
  verify: (req, _res, buf) => {
    (req as unknown as { rawBody?: Buffer }).rawBody = buf;
  },
};

const HEALTH_PATH = /^\/v\d+\/health\/?$/;

/**
 * Open the request's log frame and write one `request responded` line when
 * it ends. The frame holds the request itself: user, org and role are read
 * from it as each line is written, after whatever auth ran. A socket call
 * keeps its socket's app and links to its session as the parent; the IP
 * goes only on connection and auth lines, never on a request's.
 */
function openRequestFrame(req: any, res: any, next: () => void): void {
  const id = newOperationId();
  const parent = currentFrame();
  const client = parseClientIdentity(req.headers?.["x-freia-client"]);
  runInFrame(
    {
      ...BLANK_CONTEXT,
      // A socket call without its own header keeps its socket's app.
      ...(req._socketRpc
        ? {
            app: parent?.app ?? null,
            appVersion: parent?.appVersion ?? null,
            platform: parent?.platform ?? null,
          }
        : {}),
      ...client,
      req,
      requestId: id,
      operationId: id,
      parentId: req._socketRpc ? (parent?.operationId ?? null) : null,
      trigger: "interactive",
    },
    () => {
      const path = req.path ?? String(req.url ?? "").split("?")[0] ?? "";
      // Preflights and health checks carry no one's request.
      if (req.method !== "OPTIONS" && !HEALTH_PATH.test(path)) {
        recordRequest(req, res, id, path);
      }
      next();
    },
  );
}

function recordRequest(req: any, res: any, id: string, path: string): void {
  const started = performance.now();
  res.setHeader?.("X-Freia-Operation-Id", id);
  let recorded = false;
  // Bound to the request's frame: whoever calls end() (another request
  // fanning out to parked responses, a timer) the line is this request's.
  const record = AsyncResource.bind((aborted: boolean) => {
    if (recorded) return;
    recorded = true;
    const status =
      aborted && !res.headersSent
        ? null
        : typeof res.statusCode === "number"
          ? res.statusCode
          : null;
    const fields = {
      // The pattern the route was registered under, else the path's shape.
      route: req._parcaeRoute ?? templatePath(path),
      method: req.method,
      status,
      durationMs: Math.round(performance.now() - started),
      transport: req._socketRpc ? "socket" : "http",
      ...(aborted ? { aborted: true } : {}),
    };
    if (status !== null && status >= 500) log.error("request responded", fields);
    else log.info("request responded", fields);
  });
  // Socket calls answer on a fake response with no events, so the line is
  // written from end(); a real response that closes first records too.
  const end = res.end;
  res.end = function (this: unknown, ...args: unknown[]) {
    const result = end.apply(this, args);
    record(false);
    return result;
  };
  if (typeof res.once === "function") res.once("close", () => record(true));
}

export function createServer_(options: ServerOptions): ServerContext {
  const { config } = options;

  // Parse trusted origins
  const trustedOrigins = config.TRUSTED_ORIGINS
    ? config.TRUSTED_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:*", "https://localhost:*"];
  // The HTTP middleware and the Socket.IO handshake both ask this one
  // function, so the two transports cannot disagree about an origin.
  const allowOrigin = createOriginPolicy(
    trustedOrigins,
    options.isTrustedOrigin,
  );

  // Create Polka app with body parsing + query string parsing
  const app = polka({
    onError: (err: unknown, req: any, res: any) => {
      if (res.writableEnded || res.finished) return;
      // http-errors (body-parser: malformed JSON, oversize body, abort)
      // carries a numeric 4xx status; collapsing those to 500 would make
      // client garbage retryable and page whoever watches 5xx rates.
      const httpStatus = (err as { status?: unknown })?.status;
      const status =
        err instanceof ClientError
          ? err.status
          : typeof httpStatus === "number" &&
              httpStatus >= 400 &&
              httpStatus < 500
            ? httpStatus
            : 500;
      const message =
        err instanceof ClientError
          ? err.message
          : status < 500
            ? "Bad request"
            : "An error occurred while processing your request";
      log.error("[http] request failed", {
        method: req.method,
        route: req._parcaeRoute ?? templatePath(String(req.url ?? "")),
        status,
        error: err,
      });
      error(res, status, message);
    },
    onNoMatch: (req: any, res: any) => {
      log.warn("[http] no route", {
        method: req.method,
        route: templatePath(String(req.url ?? "")),
      });
      error(res, 404, "Not found");
    },
  });
  // First in the chain, so a body the parser refuses still has a frame.
  app.use(openRequestFrame);
  app.use(bodyParser.json(JSON_BODY_PARSER_OPTIONS));
  app.use(bodyParser.urlencoded({ extended: true }));

  // Polka's handler unconditionally sets req.query = querystring.parse(info.query),
  // which flattens complex objects from socket RPC data. Restore the original
  // structured query for socket calls, and fall back to URL parsing for HTTP.
  app.use((req: any, _res: any, next: any) => {
    if (req._socketQuery) {
      req.query = req._socketQuery;
    } else if (!req.query || Object.keys(req.query).length === 0) {
      // What url.parse(url, true).query gave, without the deprecated
      // url.parse: the text after the first "?", before any "#".
      const search = String(req.url ?? "").split("#")[0]!.split("?").slice(1).join("?");
      req.query = parseQuery(search);
    }
    next();
  });

  // CORS middleware. Preflight (OPTIONS) and the real request run the same
  // check, so a browser never sees a preflight pass that the request fails.
  app.use((req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    const finish = (allowed: boolean) => {
      if (allowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Freia-Client",
        );
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      next();
    };

    if (!origin) return finish(false);
    // Static-list hits stay synchronous; only a runtime check awaits.
    const path = req.path ?? String(req.url ?? "").split("?")[0] ?? "";
    const decision = allowOrigin(origin, path);
    if (typeof decision === "boolean") return finish(decision);
    decision.then(finish);
  });

  // Create HTTP server from Polka's handler
  const httpServer = createServer(app.handler as any);

  // Create Socket.IO server
  const io = new SocketServer(httpServer, {
    path: "/ws",
    cors: {
      origin: (origin, callback) => {
        const decide = (allowed: boolean) => {
          if (allowed) callback(null, true);
          else callback(new Error("Not allowed by CORS"));
        };
        if (!origin) return decide(true);
        const decision = allowOrigin(origin);
        if (typeof decision === "boolean") decide(decision);
        else decision.then(decide);
      },
      credentials: true,
    },
    maxHttpBufferSize: 50e6, // 50 MB
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  return { polka: app, io, httpServer };
}

/** Start listening and reject startup on bind/runtime listen errors. */
export function listenServer(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off("error", handleError);
      server.off("listening", handleListening);
    };
    const handleError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const handleListening = () => {
      cleanup();
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    try {
      server.listen(port);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Build the single CORS decision shared by HTTP and Socket.IO.
 *
 * The static list answers first and synchronously. Only an origin it does not
 * allow reaches `isTrustedOrigin`, and that check fails closed: a throw, a
 * rejection, or any result other than `true` denies the origin. The returned
 * promise never rejects.
 */
export function createOriginPolicy(
  trustedOrigins: string[],
  isTrustedOrigin?: TrustedOriginCheck,
): (origin: string, path?: string) => boolean | Promise<boolean> {
  return (origin, path) => {
    if (isOriginAllowed(origin, trustedOrigins)) return true;
    if (!isTrustedOrigin) return false;
    return (async () => {
      try {
        return (await isTrustedOrigin(origin, path)) === true;
      } catch (err) {
        log.error("[cors] isTrustedOrigin failed, denying origin", {
          origin: stripQuery(origin),
          error: err,
        });
        return false;
      }
    })();
  };
}

/** Drop any query string or fragment so a log line never carries one. */
function stripQuery(origin: string): string {
  return origin.split(/[?#]/, 1)[0] ?? "";
}

/**
 * Check if an origin matches any of the allowed patterns.
 * Supports wildcard matching (e.g. "http://localhost:*").
 */
function isOriginAllowed(origin: string, allowed: string[]): boolean {
  for (const pattern of allowed) {
    if (pattern === origin) return true;
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" +
          pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
          "$",
      );
      if (regex.test(origin)) return true;
    }
  }
  return false;
}
