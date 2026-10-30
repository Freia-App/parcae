import { isDeepStrictEqual } from "node:util";
import { log } from "./logger";

/**
 * Client frames reach socket listeners exactly as sent: any argument can be
 * any JSON value, and an ack is a function only when the client asked for
 * one. These guards are the one place that knows it.
 */

interface ListenerTarget {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Register a socket listener whose throw or rejection is logged instead of
 * escaping. Socket.IO discards a listener's return value, so a rejected
 * promise from an async listener is an unhandled rejection, and Node exits
 * on the first one.
 */
export function listenSafely(
  socket: ListenerTarget,
  event: string,
  listener: (...args: any[]) => unknown,
): void {
  const fail = (err: unknown) => {
    log.error(`[socket] ${event} handler failed:`, err);
  };
  socket.on(event, (...args: any[]) => {
    try {
      const result = listener(...args);
      if (result instanceof Promise) result.catch(fail);
    } catch (err) {
      fail(err);
    }
  });
}

/** The client's ack, or a no-op when the frame carried none. */
export function ackOf(callback: unknown): (response: unknown) => void {
  return typeof callback === "function"
    ? (response) => callback(response)
    : () => {};
}

// socket.io refuses to emit these names, so a reply under one throws.
const RESERVED_EVENTS = new Set([
  "connect",
  "connect_error",
  "disconnect",
  "disconnecting",
  "newListener",
  "removeListener",
]);

/**
 * A `call` frame's id is the event name its reply goes out on. The SDK's
 * ids are short alphanumeric strings; anything else cannot be answered.
 */
export function isReplyableRequestId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
    !RESERVED_EVENTS.has(id)
  );
}

// Fields that change on every token without changing what the session may
// do: the expiry itself, and Clerk's factor-verification age, which ticks
// every minute (the SDK's VOLATILE_CLAIMS skips it for the same reason).
function authorizationOf(session: { user?: unknown; [key: string]: unknown }) {
  const { expiresAt: _expiresAt, user, ...rest } = session;
  const { fva: _fva, ...stableUser } = (user ?? {}) as Record<string, unknown>;
  return { ...rest, user: stableUser };
}

/**
 * True when two resolved sessions grant the same access: same user, org,
 * role and claims, differing only in when their credentials expire.
 */
export function sameAuthorization(
  a: { user?: unknown; [key: string]: unknown },
  b: { user?: unknown; [key: string]: unknown },
): boolean {
  return isDeepStrictEqual(authorizationOf(a), authorizationOf(b));
}
