/**
 * The transport asks the auth adapter for a fresh token only to renew.
 *
 * Clerk runs its session listeners whenever it mints a token, before the
 * minted token reaches the caller, and the Provider answers those through
 * `onChange`. During a hello the session is not yet authenticated, so that
 * callback starts another hello before the first one's ack: a hello that
 * minted would mint again forever and never authenticate.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClientAdapter } from "../auth-adapter";
import type { ParcaeClient } from "../client";
import { ParcaeProvider } from "../react/Provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeSocket {
  connected = false;
  emits: { event: string; args: any[] }[] = [];
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  io = { on() {}, off() {}, opts: {}, engine: { on() {} } };

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
    return this.on(event, wrapped);
  }

  off(event: string, handler?: (...args: any[]) => void): this {
    const set = this.handlers.get(event);
    if (set) handler ? set.delete(handler) : set.clear();
    return this;
  }

  // The server answers a macrotask later, as over a network.
  emit(event: string, ...args: any[]): boolean {
    this.emits.push({ event, args });
    const ack = args[1] as ((response: any) => void) | undefined;
    if (event === "hello" && ack) {
      setTimeout(() => ack({ userId: "user-1", expiresInMs: 15_050 }), 20);
    }
    if (event === "renew" && ack) {
      setTimeout(
        () => ack({ success: true, userId: "user-1", expiresInMs: 60_000 }),
        5,
      );
    }
    return true;
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }

  connect(): void {
    this.connected = true;
    for (const h of [...(this.handlers.get("connect") ?? [])]) h();
  }

  disconnect(): void {
    this.connected = false;
  }

  close(): void {}
}

let socket: FakeSocket;

vi.mock("socket.io-client", () => ({
  default: vi.fn(() => {
    socket = new FakeSocket();
    return socket;
  }),
}));

const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: object) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;

/** Behaves like Clerk behind the Clerk adapter: a mint runs the listeners. */
function clerkLikeAuth() {
  let mints = 0;
  let cached = jwt({ sub: "user-1", org_id: "org-1", iat: 0 });
  const listeners = new Set<() => void>();
  const auth: AuthClientAdapter = {
    init() {},
    async getToken(request) {
      if (request?.fresh) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        cached = jwt({ sub: "user-1", org_id: "org-1", iat: ++mints });
        for (const listener of [...listeners]) listener();
      }
      return cached;
    },
    onChange(callback) {
      const listener = () => {
        void auth.getToken().then(callback);
      };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { auth, mints: () => mints };
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe("ParcaeProvider with an auth provider that announces each mint", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = null;
  });

  it("authenticates with one hello, then renews with a minted token in place", async () => {
    const clerk = clerkLikeAuth();
    let client: ParcaeClient | null = null;
    await act(async () => {
      renderer = create(
        <ParcaeProvider
          url="http://localhost:0"
          auth={clerk.auth}
          bindAdapter={false}
          watchdogStaleMs={0}
          onReady={(ready) => {
            client = ready;
          }}
        >
          <div />
        </ParcaeProvider>,
      );
    });
    await act(async () => socket.connect());
    await wait(40);

    const hellos = () => socket.emits.filter((e) => e.event === "hello");
    expect(hellos()).toHaveLength(1);
    expect(clerk.mints()).toBe(0);
    expect(client!.session.state.status).toBe("authenticated");

    // The hello ack reported 15.05s left, so the renew is due in 50ms.
    await wait(100);
    const renews = socket.emits.filter((e) => e.event === "renew");
    expect(renews.map((e) => e.args[0])).toEqual([
      { token: jwt({ sub: "user-1", org_id: "org-1", iat: 1 }) },
    ]);
    expect(hellos()).toHaveLength(1);
    expect(client!.session.state.status).toBe("authenticated");
  });
});
