/**
 * @parcae/backend — log
 *
 * One JSON line per call (`freia.log.v2`), carrying who and what the line
 * is about from the async frame it was written in. Four seams open frames:
 * the request middleware (`server.ts`), the socket hello (`app.ts`),
 * `job()` from the `_ctx` that `enqueue()` stamps, and `cron()`.
 *
 * Caller fields are identifiers and codes. A string with whitespace, an
 * `@`, `%` or `+`, or over 80 characters is dropped and counted, as are
 * dates, arrays and objects, so
 * clinical text (notes, names, results, model output) cannot reach a log
 * line through a field. An Error keeps its name, code, status, a Postgres
 * error's table, constraint and column, and where it was thrown (`<key>At`,
 * file:line frames in app code); never its message.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { parseBoolString } from "./config";

export { clientIp } from "./client-identity";

export type Field = string | number | boolean | null | undefined | Error;
export type Fields = Record<string, Field>;
/**
 * What a call may pass. Values outside `Field` are dropped at runtime and
 * counted in `droppedFields`, so a mechanical call site passing a whole
 * object still writes its line.
 */
export type LogFields = Readonly<Record<string, unknown>>;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogApp = "dashboard" | "portal" | "mobile" | "persona";
export type LogTrigger =
  | "interactive"
  | "scheduled"
  | "manual"
  | "socket"
  | "none";

export interface LogContext {
  user: string | null;
  org: string | null;
  role: string | null;
  ip: string | null;
  app: LogApp | null;
  appVersion: string | null;
  platform: string | null;
  requestId: string | null;
  operationId: string | null;
  parentId: string | null;
  trigger: LogTrigger | null;
  job: string | null;
  /**
   * The live request. `user`, `org` and `role` are read from it when a
   * line is written, so auth middleware order does not matter.
   */
  req: unknown;
}

// Request-context state rides the same frame (`services/context.ts`).
type Frame = Partial<LogContext> & {
  requestUser?: { id: string; [key: string]: any } | null;
  refLoader?: unknown;
};

export interface Line {
  schema: "freia.log.v2";
  at: string;
  level: LogLevel;
  msg: string;
  tag: string | null;
  [key: string]: string | number | boolean | null;
}

// ─── Shared state ────────────────────────────────────────────────────────────

// The API loads this module twice (the submodule's source and the built
// package), so the frame, the capture sinks and the stdout state live on
// globalThis under registered symbols, and both copies use one of each.
const FRAME_KEY = Symbol.for("freia.log.ctx");
const CAPTURE_KEY = Symbol.for("freia.log.capture");
const STATE_KEY = Symbol.for("freia.log.state");

interface CaptureSink {
  lines: Line[];
}
interface SharedState {
  backpressured: boolean;
  dropped: number;
  captures: Set<CaptureSink>;
}

const shared = globalThis as typeof globalThis & {
  [FRAME_KEY]?: AsyncLocalStorage<Frame>;
  [CAPTURE_KEY]?: AsyncLocalStorage<CaptureSink>;
  [STATE_KEY]?: SharedState;
};
const frames = (shared[FRAME_KEY] ??= new AsyncLocalStorage<Frame>());
const captureScope = (shared[CAPTURE_KEY] ??=
  new AsyncLocalStorage<CaptureSink>());
const state = (shared[STATE_KEY] ??= {
  backpressured: false,
  dropped: 0,
  captures: new Set(),
});

/** @internal The current frame, for the seams that stamp or copy it. */
export function currentFrame(): Readonly<Frame> | undefined {
  return frames.getStore();
}

/**
 * The frame the caller runs in, read-only: its operation and request ids,
 * trigger and job. A nested frame is a new object with the same ids, so
 * key per-operation state on `operationId`, not on the object.
 */
export const currentLogContext: () =>
  | Readonly<Partial<LogContext>>
  | undefined = currentFrame;

/** @internal Run `fn` in a frame built from the current one plus `patch`. */
export function runInFrame<T>(patch: Frame, fn: () => T): T {
  return frames.run({ ...frames.getStore(), ...patch }, fn);
}

/**
 * @internal Run `fn` in exactly `frame` (an empty one when absent). A
 * socket's frame is one object for the connection, so a hello that names
 * the user is seen by every later listener.
 */
export function runWithFrame<T>(frame: Frame | undefined, fn: () => T): T {
  return frames.run(frame ?? {}, fn);
}

export function withLogContext<T>(patch: Partial<LogContext>, fn: () => T): T;
export function withLogContext(patch: Partial<LogContext>): void;
export function withLogContext<T>(
  patch: Partial<LogContext>,
  fn?: () => T,
): T | void {
  if (fn) return runInFrame(patch, fn);
  const current = frames.getStore();
  if (current) Object.assign(current, patch);
}

const SOCKET_FRAME = Symbol.for("freia.log.socketFrame");

/** @internal The one frame object a socket's listeners run in. */
export function socketFrameOf(socket: object): Frame {
  const holder = socket as { [SOCKET_FRAME]?: Frame };
  holder[SOCKET_FRAME] ??= {};
  return holder[SOCKET_FRAME];
}

/** A fresh operation id. */
export function newOperationId(): string {
  return randomUUID();
}

// ─── Process identity ────────────────────────────────────────────────────────

function processFields() {
  const env = process.env;
  const workload = env.FREIA_AI_WORKLOAD;
  const deployment = env.GIT_COMMIT_SHA;
  // The v4 metadata URI ends in "<task id>-<container number>".
  const metadata = env.ECS_CONTAINER_METADATA_URI_V4 ?? "";
  const task = /\/v4\/([0-9a-f]{32})-/.exec(metadata)?.[1] ?? null;
  return {
    // RUN_SERVER read as config.ts reads it: unset serves, "0" or "off"
    // is a daemon as much as "false".
    service: env.FREIA_EVAL_PROFILE
      ? "eval"
      : env.RUN_SERVER?.trim() && parseBoolString(env.RUN_SERVER.trim()) === false
        ? "daemon"
        : "api",
    environment:
      workload === "production" || workload === "staging"
        ? workload
        : env.NODE_ENV === "development"
          ? "local"
          : env.NODE_ENV === "test" || env.VITEST
            ? "test"
            : "unknown",
    deployment:
      deployment && /^[a-f0-9]{7,40}$/i.test(deployment) ? deployment : null,
    lane: env.FREIA_LANE_SLOT && /^\d{1,3}$/.test(env.FREIA_LANE_SLOT)
      ? env.FREIA_LANE_SLOT
      : null,
    task,
  };
}

// ─── The field rule ──────────────────────────────────────────────────────────

const MAX_STRING = 80;
const IP = /^[0-9A-Fa-f:.]{2,45}$/;
const CONTEXT_KEYS = [
  "user",
  "org",
  "role",
  "ip",
  "app",
  "appVersion",
  "platform",
  "requestId",
  "operationId",
  "parentId",
  "trigger",
  "job",
] as const;
// The keys every line opens with, before the context and caller fields.
const HEADER_KEYS = [
  "schema",
  "at",
  "level",
  "msg",
  "tag",
  "service",
  "environment",
  "deployment",
  "lane",
  "task",
] as const;

/** Keys the line owns: a caller field can fill one nobody set, never more. */
export const RESERVED_LOG_KEYS: ReadonlySet<string> = new Set<string>([
  ...HEADER_KEYS,
  ...CONTEXT_KEYS,
  "droppedFields",
  "appInferred",
]);

/**
 * A frame with every context key cleared, for a seam that starts its own
 * operation (a request, a job, a cron tick) inside whatever frame called it.
 * The request context (`requestUser`, `refLoader`) is left as it was.
 */
export const BLANK_CONTEXT: Readonly<Partial<LogContext>> = Object.freeze({
  ...Object.fromEntries(CONTEXT_KEYS.map((key) => [key, null])),
  req: undefined,
});

/** An id from outside the process (a job's `_ctx`, a token's `sub`) as a log value. */
export function isLogId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
}

/**
 * A string survives when it reads as an identifier or code: no whitespace,
 * at most 80 characters, and no `@`, `%` or `+`, so an email address, a
 * phone number and URL-encoded prose stay out too.
 */
function keepString(value: string): boolean {
  return value.length <= MAX_STRING && !/[\s@%+]/.test(value);
}

type Scalar = string | number | boolean | null;

const CODE_FILE = /^[A-Za-z0-9_.-]{1,60}\.(?:[cm]?[jt]sx?)$/;

/**
 * Where an error was thrown, never what it said: the top five frames in app
 * code as `file.ts:line` joined by `>`, skipping Node internals and
 * node_modules. The stack's first lines repeat the message, so they are
 * skipped before any frame is read.
 */
function stackAt(err: Error): string | null {
  if (typeof err.stack !== "string") return null;
  const messageLines = String(err.message).split("\n").length;
  const frames: string[] = [];
  for (const line of err.stack.split("\n").slice(messageLines)) {
    const frame = /^\s+at (?:.*?\()?(.+?):(\d+):\d+\)?$/.exec(line);
    if (!frame) continue;
    const path = frame[1]!;
    if (path.startsWith("node:") || path.includes("node_modules")) continue;
    const file = path.split(/[\\/]/).pop()!;
    if (!CODE_FILE.test(file)) continue;
    frames.push(`${file}:${frame[2]}`);
    if (frames.length === 5) break;
  }
  return frames.length ? frames.join(">").slice(0, 200) : null;
}

/**
 * Project one caller value onto the line. Returns the entries to write and
 * how many values were dropped.
 */
function project(key: string, value: unknown): [Array<[string, Scalar]>, number] {
  if (value === undefined) return [[], 0];
  if (value === null || typeof value === "boolean") return [[[key, value]], 0];
  if (typeof value === "number") {
    return Number.isFinite(value) ? [[[key, value]], 0] : [[[key, null]], 0];
  }
  if (typeof value === "string") {
    return keepString(value) ? [[[key, value]], 0] : [[], 1];
  }
  if (value instanceof Error) {
    const out: Array<[string, Scalar]> = [];
    let dropped = 0;
    const err = value as Error & {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      table?: unknown;
      constraint?: unknown;
      column?: unknown;
    };
    // A Postgres error's schema names; its detail quotes row values and stays out.
    const parts: Array<[string, unknown]> = [
      [`${key}Name`, err.name],
      [`${key}Code`, err.code],
      [`${key}Status`, err.status ?? err.statusCode],
      [`${key}Table`, err.table],
      [`${key}Constraint`, err.constraint],
      [`${key}Column`, err.column],
    ];
    for (const [k, v] of parts) {
      if (typeof v === "string") {
        if (keepString(v)) out.push([k, v]);
        else dropped++;
      } else if (typeof v === "number" && Number.isFinite(v)) {
        out.push([k, v]);
      }
    }
    const at = stackAt(err);
    if (at) out.push([`${key}At`, at]);
    return [out, dropped];
  }
  return [[], 1];
}

// ─── Request-derived identity ────────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * @internal Who a request (or a socket's resolved session, as `{ session }`)
 * is: the API's auth middleware fields first, else the session's.
 */
export function requestIdentity(req: any): {
  user: string | null;
  org: string | null;
  role: string | null;
} {
  if (!req || typeof req !== "object") {
    return { user: null, org: null, role: null };
  }
  const sessionUser = req.session?.user;
  const rawRole = str(req.role) ?? str(sessionUser?.orgRole);
  return {
    user: str(req.userId) ?? str(sessionUser?.id),
    org: str(req.orgId) ?? str(sessionUser?.orgId),
    role: rawRole ? rawRole.replace(/^org:/, "") : null,
  };
}

const MOBILE_AGENT = /Expo|okhttp|CFNetwork|Darwin|ReactNative/i;
const BROWSER_AGENT = /Mozilla|Chrome|Safari|Firefox|Edge/i;
const PATIENT_ROLES = new Set(["patient", "member"]);

/** The app a client without `X-Freia-Client` most likely is. */
function inferApp(
  userAgent: unknown,
  role: string | null,
): LogApp | null {
  if (typeof userAgent !== "string" || !userAgent) return null;
  if (MOBILE_AGENT.test(userAgent)) return "mobile";
  if (!BROWSER_AGENT.test(userAgent)) return null;
  if (!role) return null;
  return PATIENT_ROLES.has(role) ? "portal" : "dashboard";
}

// ─── Building a line ─────────────────────────────────────────────────────────

const TAG = /^\[([^\]\s]{1,60})\]\s+/;

function buildLine(level: LogLevel, rawMsg: string, fields?: LogFields): Line {
  const frame = frames.getStore() ?? {};

  let msg = String(rawMsg);
  let tag: string | null = null;
  const tagged = TAG.exec(msg);
  if (tagged) {
    tag = tagged[1]!;
    msg = msg.slice(tagged[0].length);
  }

  const fromReq = requestIdentity(frame.req);
  const context: Record<(typeof CONTEXT_KEYS)[number], Scalar> = {
    user: fromReq.user ?? frame.user ?? null,
    org: fromReq.org ?? frame.org ?? null,
    role: fromReq.role ?? frame.role ?? null,
    ip: typeof frame.ip === "string" && IP.test(frame.ip) ? frame.ip : null,
    app: frame.app ?? null,
    appVersion: frame.appVersion ?? null,
    platform: frame.platform ?? null,
    requestId: frame.requestId ?? null,
    operationId: frame.operationId ?? null,
    parentId: frame.parentId ?? null,
    trigger: frame.trigger ?? null,
    job: frame.job ?? null,
  };
  let appInferred = false;
  if (context.app === null && frame.req) {
    const guessed = inferApp(
      (frame.req as any)?.headers?.["user-agent"],
      context.role as string | null,
    );
    if (guessed) {
      context.app = guessed;
      appInferred = true;
    }
  }

  const line: Line = {
    schema: "freia.log.v2",
    at: new Date().toISOString(),
    level,
    msg,
    tag,
    // Read per line: a line written before the env loads must not fix them.
    ...processFields(),
    ...context,
  };

  let dropped = 0;
  // An Error passed as the whole second argument keeps its name and code.
  if (fields instanceof Error) fields = { error: fields };
  if (fields && typeof fields === "object") {
    for (const [key, value] of Object.entries(fields)) {
      const [entries, lost] = project(key, value);
      dropped += lost;
      for (const [k, v] of entries) {
        if (RESERVED_LOG_KEYS.has(k)) {
          // A caller fills a context key nobody set; it never overrides one.
          const fits = k !== "ip" || (typeof v === "string" && IP.test(v));
          if (line[k] === null && fits) line[k] = v;
          continue;
        }
        line[k] = v;
      }
    }
  }
  if (appInferred && line.app !== null) line.appInferred = true;
  if (dropped > 0) line.droppedFields = dropped;
  return line;
}

// ─── Sinks ───────────────────────────────────────────────────────────────────

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};
const LEVEL_COLOUR: Record<LogLevel, string> = {
  debug: "\x1b[2m",
  info: "\x1b[34m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const PRETTY_SKIP = new Set<string>(HEADER_KEYS);

/** A terminal reads `HH:MM:SS LVL [tag] msg key=value ...`. */
function prettyLine(line: Line): string {
  const time = line.at.slice(11, 19);
  const fields = Object.entries(line)
    .filter(([k, v]) => v !== null && !PRETTY_SKIP.has(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join(" ");
  return (
    `\x1b[2m${time}\x1b[0m ${LEVEL_COLOUR[line.level]}${LEVEL_LABEL[line.level]}\x1b[0m ` +
    `${line.tag ? `[${line.tag}] ` : ""}${line.msg}${fields ? ` \x1b[2m${fields}\x1b[0m` : ""}`
  );
}

let stdoutWatched = false;

function writeStdout(text: string): void {
  if (state.backpressured) {
    state.dropped++;
    return;
  }
  if (!stdoutWatched) {
    stdoutWatched = true;
    // A broken pipe must not turn a log line into an application crash.
    process.stdout.on("error", () => {
      state.backpressured = true;
    });
  }
  try {
    const flushed = process.stdout.write(`${text}\n`, (err) => {
      if (err) state.dropped++;
    });
    if (!flushed) {
      // No private buffer: while stdout is full, lines are dropped and counted.
      state.backpressured = true;
      process.stdout.once("drain", () => {
        state.backpressured = false;
      });
    }
  } catch {
    state.dropped++;
  }
}

const jsonSink = (line: Line) => writeStdout(JSON.stringify(line));
const prettySink = (line: Line) => writeStdout(prettyLine(line));

function emit(line: Line): void {
  if (state.captures.size > 0) {
    const scoped = captureScope.getStore();
    if (scoped && state.captures.has(scoped)) {
      scoped.lines.push(line);
      return;
    }
    // A line from a callback outside every capture (a server's IO, a timer
    // set before the test) goes to each open capture rather than to stdout.
    for (const capture of state.captures) capture.lines.push(line);
    return;
  }
  (process.stdout.isTTY ? prettySink : jsonSink)(line);
}

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  if (level === "debug" && !process.env.PARCAE_DEBUG) return;
  if (state.captures.size === 0 && consoleSinkInTests()) {
    // biome-ignore lint/suspicious/noConsole: the test sink is the console by design
    if (fields === undefined) console[level](msg);
    // biome-ignore lint/suspicious/noConsole: the test sink is the console by design
    else console[level](msg, fields);
    return;
  }
  try {
    emit(buildLine(level, msg, fields));
  } catch {
    state.dropped++;
  }
}

/**
 * Under vitest with PARCAE_LOG_SINK=console, a line no capture holds goes
 * to console[level] as the call site wrote it, so a suite written against
 * console spies reads the call. Never outside a test runner.
 */
function consoleSinkInTests(): boolean {
  return Boolean(process.env.VITEST) && process.env.PARCAE_LOG_SINK === "console";
}

export const log = {
  debug: (msg: string, fields?: LogFields) => write("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => write("error", msg, fields),
};

/**
 * Collect the lines written in the calling async context (and any written
 * outside every capture) instead of printing them. For tests.
 */
export function captureLogs(): { lines: Line[]; stop(): void } {
  const capture: CaptureSink = { lines: [] };
  state.captures.add(capture);
  captureScope.enterWith(capture);
  return {
    lines: capture.lines,
    stop: () => {
      state.captures.delete(capture);
    },
  };
}

/** Whether stdout is refusing lines, and how many have been dropped. */
export function logHealth(): { backpressured: boolean; dropped: number } {
  return { backpressured: state.backpressured, dropped: state.dropped };
}
