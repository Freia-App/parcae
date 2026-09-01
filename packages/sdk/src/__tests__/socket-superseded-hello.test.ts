/**
 * SocketTransport — REST calls across a superseded hello.
 *
 * A new handshake generation (token rotation via refreshSession, or a
 * reconnect) must not silently fail REST traffic that was issued under
 * the generation it replaced:
 *
 *   - a call parked on `helloReady` follows the superseding handshake
 *     instead of rejecting, with the cold load (no hello resolved yet)
 *     as the exposed case;
 *   - a call already sent on a socket that never dropped keeps waiting
 *     for its response instead of being rejected or re-emitted;
 *   - the identity boundary stays closed: a call issued under one user
 *     never executes or resolves under another, and a refusal the
 *     server issued on purpose is never retried.
 */
import { describe, expect, it, vi } from "vitest";
import { compress } from "compress-json";
import pako from "pako";

class FakeSocket {
  connected = false;
  disconnectCalls = 0;
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  public emits: { event: string; args: any[] }[] = [];

  on(event: string, handler: (...args: any[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }

  once(event: string, handler: (...args: any[]) => void): this {
    const wrapped = (...args: any[]) => {
      this.off(event, wrapped);
      handler(...args);
    };
    (wrapped as any).__original = handler;
    this.on(event, wrapped);
    return this;
  }

  off(event: string, handler?: (...args: any[]) => void): this {
    const set = this.handlers.get(event);
    if (!set) return this;
    if (!handler) {
      set.clear();
      return this;
    }
    for (const h of set) {
      if (h === handler || (h as any).__original === handler) set.delete(h);
    }
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    this.emits.push({ event, args });
    return true;
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }

  _fire(event: string, ...args: any[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) h(...args);
  }

  connect(): void {
    this.connected = true;
    this._fire("connect");
  }

  disconnect(): void {
    this.disconnectCalls++;
    this.connected = false;
    this._fire("disconnect");
  }
}

let currentSocket: FakeSocket;

vi.mock("socket.io-client", () => ({
  default: vi.fn(() => {
    currentSocket = new FakeSocket();
    return currentSocket;
  }),
}));

// eslint-disable-next-line import/first
import { SocketTransport } from "../transports/socket";

function makeTransport(getToken: () => Promise<string | null>) {
  return new SocketTransport({ url: "http://localhost:0", getToken });
}

/** Ack the most recent `hello` emit. Older generations' callbacks are
 * generation-guarded in the transport, so acking only the latest is
 * exactly what a live server racing a rotation does. */
function ackHello(userId: string | null): void {
  const hello = [...currentSocket.emits]
    .reverse()
    .find((e) => e.event === "hello");
  if (!hello) throw new Error("no hello emit found");
  const cb = hello.args[1] as (resp: any) => void;
  cb({ userId });
}

function refuseHello(error: string): void {
  const hello = [...currentSocket.emits]
    .reverse()
    .find((e) => e.event === "hello");
  if (!hello) throw new Error("no hello emit found");
  const cb = hello.args[1] as (resp: any) => void;
  cb({ success: false, error });
}

function callEmits(): { event: string; args: any[] }[] {
  return currentSocket.emits.filter((e) => e.event === "call");
}

function respondToLatestCall(response: Record<string, unknown>): void {
  const call = callEmits().at(-1);
  if (!call) throw new Error("no call emit found");
  const requestId = call.args[0] as string;
  currentSocket._fire(
    requestId,
    pako.gzip(JSON.stringify(compress(response))),
  );
}

/** Drain the microtask queue far enough for the transport's await
 * chains (token resolution, helloReady, dedupe) to settle. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("SocketTransport — REST calls across a superseded hello", () => {
  it("a call parked on a cold-load hello follows the superseding handshake", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await flush();
    expect(
      currentSocket.emits.filter((e) => e.event === "hello"),
    ).toHaveLength(1);

    // Cold load: first hello still unacked, REST call parks.
    const call = transport.get("/posts");
    await flush();
    expect(callEmits()).toHaveLength(0);

    // The auth adapter's first token change supersedes the handshake.
    const refresh = transport.refreshSession();
    await flush();
    expect(
      currentSocket.emits.filter((e) => e.event === "hello"),
    ).toHaveLength(2);

    ackHello("user-1");
    await flush();
    await refresh;

    // The parked call went out under the new generation and resolves.
    expect(callEmits()).toHaveLength(1);
    respondToLatestCall({ success: true, result: [{ id: "p1" }] });
    await expect(call).resolves.toEqual([{ id: "p1" }]);
  });

  it("an in-flight call on a socket that never dropped survives a same-user refresh without a re-emit", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await flush();
    ackHello("user-1");
    await flush();

    const call = transport.get("/posts");
    await flush();
    expect(callEmits()).toHaveLength(1);

    const refresh = transport.refreshSession();
    await flush();
    ackHello("user-1");
    await flush();
    await refresh;

    // Same socket, same user: the original frame is still answerable.
    // A re-emit would trip the server's replay guard on a mutation, so
    // the frame must not go out twice.
    expect(callEmits()).toHaveLength(1);
    respondToLatestCall({ success: true, result: { ok: true } });
    await expect(call).resolves.toEqual({ ok: true });
  });

  it("a parked call issued under one user rejects when the superseding hello resolves another", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await flush();
    ackHello("user-1");
    await flush();

    // Mid-rotation: a second hello is pending, so the call parks while
    // the session still belongs to user-1.
    const refresh1 = transport.refreshSession();
    await flush();
    const call = transport.get("/posts");
    await flush();
    expect(callEmits()).toHaveLength(0);

    const refresh2 = transport.refreshSession();
    await flush();
    ackHello("user-2");
    await flush();

    await expect(call).rejects.toThrow("Session changed");
    expect(callEmits()).toHaveLength(0);
    await expect(refresh1).rejects.toThrow();
    await refresh2;
  });

  it("an in-flight call rejects when the superseding hello resolves a different user", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await flush();
    ackHello("user-1");
    await flush();

    const call = transport.post("/notes", { text: "mine" });
    await flush();
    expect(callEmits()).toHaveLength(1);

    const refresh = transport.refreshSession();
    await flush();
    ackHello("user-2");
    await flush();

    await expect(call).rejects.toThrow("Hello superseded");
    // Never replayed under the new identity.
    expect(callEmits()).toHaveLength(1);
    await refresh;
  });

  it("a refusal in flight when the handshake is superseded still reaches its caller and is never replayed", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await flush();
    ackHello("user-1");
    await flush();

    const call = transport.post("/notes", { text: "mine" });
    await flush();
    expect(callEmits()).toHaveLength(1);

    const refresh = transport.refreshSession();
    await flush();
    // The server's deliberate refusal lands while the frame sits
    // suspended. It must reach the caller as sent, and the settled
    // frame must not be re-emitted when the hello resolves.
    respondToLatestCall({
      success: false,
      error: { message: "Forbidden", status: 403 },
    });
    await expect(call).rejects.toMatchObject({
      message: "Forbidden",
      status: 403,
    });

    ackHello("user-1");
    await flush();
    await refresh;
    expect(callEmits()).toHaveLength(1);
  });

  it("a server refusal of the superseding hello still fails the parked call", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await flush();

    const call = transport.get("/posts");
    await flush();

    const refresh = transport.refreshSession();
    await flush();
    refuseHello("Invalid token");
    await flush();

    await expect(call).rejects.toThrow("Invalid token");
    await expect(refresh).rejects.toThrow("Invalid token");
    expect(callEmits()).toHaveLength(0);
  });

  it("a call the server refused on purpose stays refused across a refresh", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await flush();
    ackHello("user-1");
    await flush();

    const call = transport.post("/notes", { text: "mine" });
    await flush();
    expect(callEmits()).toHaveLength(1);
    respondToLatestCall({
      success: false,
      error: { message: "Forbidden", status: 403 },
    });
    await expect(call).rejects.toMatchObject({
      message: "Forbidden",
      status: 403,
    });

    const refresh = transport.refreshSession();
    await flush();
    ackHello("user-1");
    await flush();
    await refresh;

    expect(callEmits()).toHaveLength(1);
  });

  it("terminateSession still rejects a parked call", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await flush();

    const call = transport.get("/posts");
    await flush();

    const termination = transport.terminateSession();
    await expect(call).rejects.toThrow("Session terminated");
    ackHello(null);
    await termination;
    expect(callEmits()).toHaveLength(0);
  });

  it("a disconnect during a refresh-suspended call re-sends the frame after the reconnect hello", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await flush();
    ackHello("user-1");
    await flush();

    const call = transport.get("/posts");
    await flush();
    expect(callEmits()).toHaveLength(1);
    const requestId = callEmits()[0]!.args[0] as string;

    const refresh = transport.refreshSession();
    await flush();
    // The socket drops before the fresh hello resolves: the original
    // frame died with it and must be re-sent, unlike the same-socket
    // case above.
    currentSocket.disconnect();
    await expect(refresh).rejects.toThrow();
    currentSocket.connect();
    await flush();
    ackHello("user-1");
    await flush();

    const resent = callEmits();
    expect(resent).toHaveLength(2);
    expect(resent[1]!.args[0]).toBe(requestId);
    respondToLatestCall({ success: true, result: [{ id: "p1" }] });
    await expect(call).resolves.toEqual([{ id: "p1" }]);
  });

  it("a refresh after a reconnect resend cycle still leaves live frames un-replayed", async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport(async () => "token");
      currentSocket.connect();
      await vi.advanceTimersByTimeAsync(0);
      ackHello("user-1");
      await vi.advanceTimersByTimeAsync(0);

      // A full disconnect cycle, whose suspended frame is legitimately
      // re-sent. It must not leave the transport primed to re-send the
      // next suspension's frames too.
      const first = transport.get("/posts");
      await vi.advanceTimersByTimeAsync(0);
      currentSocket.disconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      currentSocket.connect();
      await vi.advanceTimersByTimeAsync(0);
      ackHello("user-1");
      await vi.advanceTimersByTimeAsync(0);
      expect(callEmits()).toHaveLength(2);
      respondToLatestCall({ success: true, result: { first: true } });
      await expect(first).resolves.toEqual({ first: true });

      const second = transport.get("/comments");
      await vi.advanceTimersByTimeAsync(0);
      expect(callEmits()).toHaveLength(3);

      const refresh = transport.refreshSession();
      await vi.advanceTimersByTimeAsync(0);
      ackHello("user-1");
      await vi.advanceTimersByTimeAsync(0);
      await refresh;

      expect(callEmits()).toHaveLength(3);
      respondToLatestCall({ success: true, result: { second: true } });
      await expect(second).resolves.toEqual({ second: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a parked call stops following generations once its own timeout budget is spent", async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport(async () => "token");
      currentSocket.connect();
      await vi.advanceTimersByTimeAsync(0);

      const call = transport.get("/posts", {}, { timeout: 1_000 });
      const rejection = expect(call).rejects.toThrow("Hello superseded");
      await vi.advanceTimersByTimeAsync(0);

      void transport.refreshSession().catch(() => {});
      await vi.advanceTimersByTimeAsync(1_500);
      void transport.refreshSession().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      await rejection;
      expect(callEmits()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
