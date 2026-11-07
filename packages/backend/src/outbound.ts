/**
 * One `outbound` line per HTTP call the process makes, from Node's
 * diagnostics channels: `undici:request:*` for `fetch` (Clerk, OpenRouter,
 * Terra, Stripe, Bedrock through the AI SDK) and `http.client.*` for the
 * `http`/`https` modules (the AWS SDK, firebase-admin). No service wraps
 * its own fetch.
 *
 * Response events fire outside the caller's async frame, so the frame is
 * taken when the request is created and kept beside it in a WeakMap.
 */

import diagnostics from "node:diagnostics_channel";
import { currentFrame, log, runWithFrame } from "./log";

const PROVIDERS: Array<[RegExp, string]> = [
  [/(^|\.)clerk\.(com|accounts\.dev)$/, "clerk"],
  [/(^|\.)openrouter\.ai$/, "openrouter"],
  [/(^|\.)tryterra\.co$/, "terra"],
  [/(^|\.)stripe\.com$/, "stripe"],
  [/^bedrock(-runtime)?\.[a-z0-9-]+\.amazonaws\.com$/, "bedrock"],
  [/(^|\.)s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/, "s3"],
  [/^email\.[a-z0-9-]+\.amazonaws\.com$/, "ses"],
  [/^logs\.[a-z0-9-]+\.amazonaws\.com$/, "cloudwatch-logs"],
  [/^transcribe(streaming)?\.[a-z0-9-]+\.amazonaws\.com$/, "transcribe"],
  [/^(sts|secretsmanager|ssm|textract|sns|sqs|monitoring|ce)\.([a-z0-9-]+\.)?amazonaws\.com$/, "aws"],
  [/^fcm\.googleapis\.com$/, "fcm"],
  [/-aiplatform\.googleapis\.com$/, "vertex"],
  [/-documentai\.googleapis\.com$/, "documentai"],
  [/(^|\.)googleapis\.com$/, "google"],
  [/(^|\.)deepgram\.com$/, "deepgram"],
  [/(^|\.)telnyx\.com$/, "telnyx"],
  [/(^|\.)slack\.com$/, "slack"],
  [/(^|\.)search\.brave\.com$/, "brave"],
  [/(^|\.)rebateright\.com\.au$/, "rebateright"],
  [/(^|\.)gofax\.com\.au$/, "gofax"],
  [/(^|\.)bunny\.net$/, "bunny"],
  [/^exp\.host$/, "expo"],
];

export function providerOf(host: string): string {
  const bare = host.replace(/:\d+$/, "").toLowerCase();
  for (const [pattern, name] of PROVIDERS) {
    if (pattern.test(bare)) return name;
  }
  return "other";
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path segment that names a record rather than a route becomes `:id`:
 * numbers, uuids, hex, prefixed ids (`user_…`, `org_…`, `cus_…`), long
 * mixed-case ids, and anything percent-encoded or carrying an `@`, which
 * is how a name or file name would arrive.
 */
function templateSegment(segment: string): string {
  if (!segment) return segment;
  if (/^\d+$/.test(segment)) return ":id";
  if (UUID.test(segment)) return ":id";
  if (/^[0-9a-f]{8,}$/i.test(segment)) return ":id";
  if (/^[a-z]{2,8}_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6,}$/.test(segment)) {
    return ":id";
  }
  if (/[%@]/.test(segment)) return ":id";
  if (
    segment.length >= 16 &&
    /^[A-Za-z0-9_-]+$/.test(segment) &&
    /[A-Z0-9]/.test(segment)
  ) {
    return ":id";
  }
  if (segment.length > 64 || /\s/.test(segment)) return ":id";
  return segment;
}

/** The path with record ids replaced by `:id` and the query dropped. */
export function templatePath(path: string): string {
  const pathname = (path.split("?")[0] ?? "").split("#")[0] ?? "";
  return pathname.split("/").map(templateSegment).join("/") || "/";
}

function endpointOf(provider: string, path: string): string {
  // An S3 path is an object key, which can carry a file's name.
  return provider === "s3" ? "/:key" : templatePath(path);
}

interface Pending {
  frame: ReturnType<typeof currentFrame>;
  started: number;
  host: string;
  method: string;
  path: string;
  done: boolean;
}

const pending = new WeakMap<object, Pending>();

function start(request: object, host: string, method: unknown, path: unknown) {
  pending.set(request, {
    frame: currentFrame(),
    started: performance.now(),
    host,
    method: typeof method === "string" ? method.toUpperCase() : "GET",
    path: typeof path === "string" ? path : "/",
    done: false,
  });
}

function finish(request: object, status: number | null, error?: unknown) {
  const call = pending.get(request);
  if (!call || call.done) return;
  call.done = true;
  const provider = providerOf(call.host);
  const fields = {
    provider,
    host: call.host.replace(/:\d+$/, "").toLowerCase(),
    method: call.method,
    endpoint: endpointOf(provider, call.path),
    status,
    durationMs: Math.round(performance.now() - call.started),
    ...(error instanceof Error ? { error } : {}),
  };
  runWithFrame(call.frame, () => {
    if (error || (status !== null && status >= 500)) {
      log.warn("outbound", fields);
    } else {
      log.info("outbound", fields);
    }
  });
}

function hostOfOrigin(origin: unknown): string {
  if (typeof origin !== "string") {
    return String((origin as URL | undefined)?.host ?? "");
  }
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const INSTALLED = Symbol.for("freia.log.outbound");

/** Subscribe once per process; later calls are no-ops. */
export function observeOutboundCalls(): void {
  const flag = globalThis as typeof globalThis & { [INSTALLED]?: boolean };
  if (flag[INSTALLED]) return;
  flag[INSTALLED] = true;

  diagnostics.subscribe("undici:request:create", (message: any) => {
    const request = message?.request;
    if (!request) return;
    start(request, hostOfOrigin(request.origin), request.method, request.path);
  });
  diagnostics.subscribe("undici:request:headers", (message: any) => {
    if (message?.request) {
      finish(message.request, message.response?.statusCode ?? null);
    }
  });
  diagnostics.subscribe("undici:request:error", (message: any) => {
    if (message?.request) finish(message.request, null, message.error);
  });

  diagnostics.subscribe("http.client.request.start", (message: any) => {
    const request = message?.request;
    if (!request) return;
    const host =
      (typeof request.getHeader === "function" && request.getHeader("host")) ||
      request.host ||
      "";
    start(request, String(host), request.method, request.path);
  });
  diagnostics.subscribe("http.client.response.finish", (message: any) => {
    if (message?.request) {
      finish(message.request, message.response?.statusCode ?? null);
    }
  });
  diagnostics.subscribe("http.client.request.error", (message: any) => {
    if (message?.request) finish(message.request, null, message.error);
  });
}
