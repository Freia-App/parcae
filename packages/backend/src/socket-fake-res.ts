import pako from "pako";
import { compress } from "compress-json";

/**
 * Minimal Socket.IO target abstraction. Real `socket.io` `Socket`
 * instances implement this; tests can pass a mock with a `vi.fn()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: socket.io Socket payload is unknown
export interface SocketEmitter {
  emit(event: string, payload: any): unknown;
}

/**
 * Construct the fake `res` object used to bridge Socket.IO RPC frames
 * through Polka's HTTP middleware chain.
 *
 * Polka middleware (and the `onAuthenticatedRequest` hook) inspects
 * `res.writableEnded` to decide whether to short-circuit. We mirror
 * that contract here so a step-up gate that calls `error(res, 403, …)`
 * actually halts dispatch instead of being silently overwritten by
 * the route handler that runs next. Both `writeHead` and `end` are
 * idempotent — a late write from a downstream handler can't clobber
 * the first response.
 *
 * Exported as a standalone factory so the contract is unit-testable
 * without spinning up a server.
 */
// biome-ignore lint/suspicious/noExplicitAny: returns a minimal Node res shape
export function createSocketFakeRes(
  socket: SocketEmitter,
  requestId: string,
  isSessionCurrent: () => boolean = () => true,
  onEnd?: () => void,
): any {
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON of any shape
  let responseBody: any = null;
  return {
    statusCode: 200,
    writableEnded: false,
    // biome-ignore lint/suspicious/noExplicitAny: Node res shape
    writeHead(code: number, _headers?: any) {
      if (this.writableEnded) return this;
      this.statusCode = code;
      return this;
    },
    setHeader() {
      return this;
    },
    // A streaming (SSE) route has no stream to write to over the socket;
    // its chunks are dropped and only `end()` answers the call. Without
    // these a heartbeat timer calling `res.write` throws outside any
    // handler and exits the process.
    flushHeaders() {},
    write() {
      return !this.writableEnded;
    },
    end(body?: string) {
      if (this.writableEnded) return;
      this.writableEnded = true;
      onEnd?.();
      // A response computed under a prior session must never reach the
      // socket after an auth boundary; the state flip above still lets
      // middleware short-circuit checks observe a finished response.
      if (!isSessionCurrent()) return;
      if (body) {
        try {
          responseBody = JSON.parse(body);
        } catch {
          responseBody = body;
        }
      }
      if (
        this.statusCode >= 400 &&
        responseBody &&
        typeof responseBody === "object" &&
        !Array.isArray(responseBody)
      ) {
        responseBody = { ...responseBody, status: this.statusCode };
      }
      const compressed = pako.gzip(
        JSON.stringify(compress(responseBody ?? { result: null, success: true })),
      );
      socket.emit(requestId, compressed);
    },
  };
}

/**
 * The `close` event of the fake request a socket call runs as. Routes
 * register `req.on("close")` to stop work when the client goes away; it
 * fires when the call's response ends or the socket disconnects. Any other
 * request event (a body stream) does not exist over the socket and throws
 * inside the handler, where the route's own error path answers it.
 */
export function createSocketRequestEvents() {
  const listeners = new Set<() => void>();
  let closed = false;
  const on = (event: string, listener: () => void) => {
    if (event !== "close") {
      throw new Error(`A socket call has no "${event}" request event`);
    }
    if (!closed) listeners.add(listener);
    return methods;
  };
  const off = (_event: string, listener: () => void) => {
    listeners.delete(listener);
    return methods;
  };
  const methods = { on, once: on, off, removeListener: off };
  return {
    methods,
    close() {
      if (closed) return;
      closed = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}
