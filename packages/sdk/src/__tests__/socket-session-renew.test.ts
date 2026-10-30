/**
 * SocketTransport — renewing the server's socket session before its token
 * expires.
 *
 * The server ends a socket session at the token's expiry and reports the
 * time left in the hello ack. A pure rotation must extend the session in
 * place (no new hello, so no resync of every query); a refused renew means
 * the authorization moved and a full hello takes over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function emitsOf(event: string) {
  return currentSocket.emits.filter((e) => e.event === event);
}

function ackLatest(event: string, response: Record<string, unknown>): void {
  const emit = emitsOf(event).at(-1);
  if (!emit) throw new Error(`no ${event} emit found`);
  (emit.args[1] as (resp: any) => void)(response);
}

async function connected(tokens: string[]) {
  let index = 0;
  const transport = new SocketTransport({
    url: "http://localhost:0",
    getToken: async () => tokens[Math.min(index++, tokens.length - 1)]!,
  });
  currentSocket.connect();
  await vi.advanceTimersByTimeAsync(0);
  return transport;
}

describe("SocketTransport — session renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews in place before the expiry the server reported, then keeps renewing", async () => {
    const transport = await connected(["t1", "t2", "t3"]);
    ackLatest("hello", { userId: "u1", expiresInMs: 60_000 });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(emitsOf("renew")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(emitsOf("renew").map((e) => e.args[0])).toEqual([{ token: "t2" }]);
    ackLatest("renew", { success: true, userId: "u1", expiresInMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.lastConfirmedToken()).toBe("t2");

    await vi.advanceTimersByTimeAsync(45_000);
    expect(emitsOf("renew").map((e) => e.args[0])).toEqual([
      { token: "t2" },
      { token: "t3" },
    ]);
    expect(emitsOf("hello")).toHaveLength(1);
    expect(transport.session.state).toMatchObject({
      status: "authenticated",
      userId: "u1",
    });
    transport.dispose();
  });

  it("waits for the auth provider to mint a new token rather than renewing with the old one", async () => {
    const transport = await connected(["t1", "t1", "t1", "t2"]);
    ackLatest("hello", { userId: "u1", expiresInMs: 60_000 });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(emitsOf("renew")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(emitsOf("renew").map((e) => e.args[0])).toEqual([{ token: "t2" }]);
    transport.dispose();
  });

  it("says hello again when the server refuses the renew", async () => {
    const transport = await connected(["t1", "t2", "t3"]);
    ackLatest("hello", { userId: "u1", expiresInMs: 20_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    ackLatest("renew", { success: false, code: "session_changed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(emitsOf("hello").map((e) => e.args[0])).toEqual([
      { token: "t1" },
      { token: "t3" },
    ]);
    transport.dispose();
  });

  it("never renews against a server that reports no expiry", async () => {
    const transport = await connected(["t1", "t2"]);
    ackLatest("hello", { userId: "u1" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(emitsOf("renew")).toHaveLength(0);
    transport.dispose();
  });

  it("stops renewing once the socket drops; the reconnect hello starts over", async () => {
    const transport = await connected(["t1", "t2", "t3"]);
    ackLatest("hello", { userId: "u1", expiresInMs: 60_000 });
    currentSocket.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emitsOf("renew")).toHaveLength(0);
    transport.dispose();
  });
});
