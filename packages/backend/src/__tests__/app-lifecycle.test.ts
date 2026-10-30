import { decompress } from "compress-json";
import pako from "pako";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const dbs: any[] = [];
  const pubsubs: any[] = [];
  const queues: any[] = [];
  const buses: any[] = [];
  const servers: any[] = [];
  let listenError: Error | null = null;

  const knex = vi.fn(() => {
    const db = { destroy: vi.fn(async () => {}) };
    dbs.push(db);
    return db;
  });

  const PubSub = vi.fn().mockImplementation(function () {
    const pubsub = {
      building: Promise.resolve(),
      close: vi.fn(async () => {}),
      on: vi.fn(() => () => {}),
      emit: vi.fn(),
      tryLock: vi.fn(async () => true),
    };
    pubsubs.push(pubsub);
    return pubsub;
  });

  const QueueService = vi.fn().mockImplementation(function () {
    const queue = {
      building: Promise.resolve(),
      close: vi.fn(async () => {}),
      forceClose: vi.fn(async () => {}),
      get: vi.fn(() => null),
      queueNameFor: vi.fn((name: string) => `parcae-${name}`),
      createWorker: vi.fn(),
    };
    queues.push(queue);
    return queue;
  });

  const ChangeBus = vi.fn().mockImplementation(function () {
    const bus = {
      on: vi.fn(() => vi.fn()),
      onReconnect: vi.fn(() => vi.fn()),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    buses.push(bus);
    return bus;
  });

  const createServer_ = vi.fn(() => {
    const polka: any = {};
    for (const method of ["use", "all", "get", "post", "put", "patch", "delete"]) {
      polka[method] = vi.fn(() => polka);
    }
    polka.handler = vi.fn();
    const io = {
      close: vi.fn((callback?: () => void) => callback?.()),
      on: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
      sockets: { sockets: new Map() },
    };
    const httpServer = {
      close: vi.fn((callback?: (err?: Error) => void) => callback?.()),
    };
    const server = { polka, io, httpServer };
    servers.push(server);
    return server;
  });

  const listenServer = vi.fn(async () => {
    if (listenError) throw listenError;
  });

  let sharedAdapter: any = null;
  class BackendAdapter {
    constructor() {
      if (sharedAdapter) return sharedAdapter;
      sharedAdapter = this;
    }
    engine = "postgres";
    modelsByType = new Map<string, any>();
    subscriptions: any = null;
    registerModels(models: any[]) {
      for (const model of models) this.modelsByType.set(model.type, model);
    }
    async detectEngine() {}
    async ensureAllTables() {}
    async ensureChangeTriggers() {}
    async verifyChangeTriggers() {}
    async batchFindByType() {
      return new Map();
    }
  }

  return {
    dbs,
    pubsubs,
    queues,
    buses,
    servers,
    knex,
    PubSub,
    QueueService,
    ChangeBus,
    BackendAdapter,
    createServer_,
    listenServer,
    setListenError(error: Error | null) {
      listenError = error;
    },
    reset() {
      dbs.length = 0;
      pubsubs.length = 0;
      queues.length = 0;
      buses.length = 0;
      servers.length = 0;
      listenError = null;
      knex.mockClear();
      PubSub.mockClear();
      QueueService.mockClear();
      ChangeBus.mockClear();
      createServer_.mockClear();
      listenServer.mockClear();
    },
  };
});

vi.mock("knex", () => ({ default: mocks.knex }));
vi.mock("../schema/generate", () => ({
  generateSchemas: vi.fn(async () => ({ schemas: new Map(), cached: true })),
}));
vi.mock("../adapters/model", () => ({ BackendAdapter: mocks.BackendAdapter }));
vi.mock("../adapters/routes", () => ({ registerModelRoutes: vi.fn(() => 0) }));
vi.mock("../services/pubsub", () => ({ PubSub: mocks.PubSub }));
// Spread the real module so app.ts's other imports from it (the orphan
// scan's warning formatter) resolve while QueueService stays a double.
vi.mock("../services/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/queue")>()),
  QueueService: mocks.QueueService,
  addJobIfNotExists: vi.fn(),
}));
vi.mock("../services/change-bus", () => ({ ChangeBus: mocks.ChangeBus }));
vi.mock("../server", () => ({
  createServer_: mocks.createServer_,
  listenServer: mocks.listenServer,
}));

import {
  createApp,
  createSocketSessionController,
  indexModelTypesByTable,
  mountAuthRoutes,
  normalizeModels,
  resyncQueries,
} from "../app";
import type { AuthSession } from "../auth";
import { route } from "../routing/route";
import { getPubSub, getQueue } from "../services/context";

const claim = Symbol.for("@parcae/backend/app-start-claimed");

describe("application lifecycle", () => {
  beforeEach(() => {
    mocks.reset();
    delete (globalThis as any)[claim];
    vi.stubEnv("DATABASE_URL", "postgres://unused/test");
    vi.stubEnv("ENSURE_SCHEMA", "false");
  });

  afterEach(() => {
    delete (globalThis as any)[claim];
    delete (globalThis as any).__parcae_adapter;
    vi.unstubAllEnvs();
  });

  it("cleans every acquired resource when listen startup fails", async () => {
    const bindError = Object.assign(new Error("address in use"), {
      code: "EADDRINUSE",
    });
    mocks.setListenError(bindError);
    const app = createApp({ models: [] });
    const start = app.start({ port: 4000 });
    const stop = app.stop();

    await expect(start).rejects.toBe(bindError);
    await expect(stop).resolves.toBeUndefined();
    expect(mocks.servers[0]!.io.close).toHaveBeenCalledTimes(1);
    expect(mocks.servers[0]!.httpServer.close).toHaveBeenCalledTimes(1);
    expect(mocks.buses[0]!.start).toHaveBeenCalledTimes(1);
    expect(mocks.buses[0]!.stop).toHaveBeenCalledTimes(1);
    expect(mocks.queues[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.pubsubs[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.dbs[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(getQueue()).toBeNull();
    expect(getPubSub()).toBeNull();
    await expect(app.start()).rejects.toThrow('lifecycle state is "failed"');
    await expect(createApp({ models: [] }).start()).rejects.toThrow(
      "app startup is one-shot",
    );
  });

  it("passes stop({ drainTimeoutMs }) through to the queue drain", async () => {
    const app = createApp({ models: [] });
    await app.start({ port: 4000 });
    (mocks.queues[0]!.close as any).mockImplementation(
      () => new Promise<void>(() => {}),
    );
    const started = Date.now();
    await app.stop({ drainTimeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(mocks.queues[0]!.forceClose).toHaveBeenCalledTimes(1);
  });

  it("mounts auth at the exact base path and its wildcard once each", () => {
    const handler = vi.fn();
    const app = { all: vi.fn() };
    mountAuthRoutes(app, { basePath: "/webhooks/clerk", handler });

    const calls = app.all.mock.calls;
    expect(calls.map((call: any[]) => call[0])).toEqual([
      "/webhooks/clerk",
      "/webhooks/clerk/*",
    ]);
    expect(calls[0]![1]).toBe(calls[1]![1]);
  });
});

describe("socket hello session ordering", () => {
  it("keeps the newest resolved token when an older hello finishes last", async () => {
    let release!: (session: any) => void;
    const slow = new Promise<any>((resolve) => {
      release = resolve;
    });
    const auth = {
      resolveToken: vi.fn((token: string) =>
        token === "slow"
          ? slow
          : Promise.resolve({ user: { id: "u2", role: "admin" } }),
      ),
    };
    const subscriptions = { unsubscribeAll: vi.fn() };
    const controller = createSocketSessionController(
      "socket",
      auth as any,
      subscriptions,
    );
    const staleCallback = vi.fn();

    const stale = controller.hello({ token: "slow" }, staleCallback);
    await controller.hello({ token: "new" });
    release({ user: { id: "u1", role: "member" } });
    await stale;

    expect(controller.session).toEqual({
      user: { id: "u2", role: "admin" },
    });
    expect(staleCallback).toHaveBeenCalledWith({ userId: "u2" });
    // Every hello is an auth boundary: subscriptions drop before each
    // token resolution, so both hellos unsubscribe.
    expect(subscriptions.unsubscribeAll).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale token overwrite a newer signout", async () => {
    let release!: (session: any) => void;
    const auth = {
      resolveToken: vi.fn(
        () =>
          new Promise<any>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const controller = createSocketSessionController("socket", auth as any, {
      unsubscribeAll: vi.fn(),
    });

    const stale = controller.hello({ token: "slow" });
    await controller.hello({ token: null });
    release({ user: { id: "u1" } });
    await stale;

    expect(controller.session).toBeNull();
  });

  it("unsubscribes old claims before accepting changed claims", async () => {
    const sessions = new Map([
      ["member", { user: { id: "u1", role: "member" } }],
      ["admin", { user: { id: "u1", role: "admin" } }],
    ]);
    const auth = {
      resolveToken: vi.fn(async (token: string) => sessions.get(token) ?? null),
    };
    let controller: ReturnType<typeof createSocketSessionController>;
    const observed: Array<AuthSession | null> = [];
    controller = createSocketSessionController("socket", auth as any, {
      unsubscribeAll: () => observed.push(controller.session),
    });

    await controller.hello({ token: "member" });
    await controller.hello({ token: "member" });
    await controller.hello({ token: "admin" });

    // Every hello drops subscriptions at the boundary, after the prior
    // session is already cleared: no RPC or subscription can be served
    // as the old claims while the new token resolves.
    expect(observed).toEqual([null, null, null]);
    expect(controller.session).toEqual({ user: { id: "u1", role: "admin" } });
  });
});

describe("socket session expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const sessions: Record<string, AuthSession> = {
    first: { user: { id: "u1", orgId: "o1", fva: [1, -1] }, expiresAt: 0 },
    rotated: { user: { id: "u1", orgId: "o1", fva: [2, -1] }, expiresAt: 0 },
    otherOrg: { user: { id: "u1", orgId: "o2" }, expiresAt: 0 },
  };
  function authExpiringIn(ms: number) {
    return {
      resolveToken: vi.fn(async (token: string) =>
        sessions[token]
          ? { ...sessions[token], expiresAt: Date.now() + ms }
          : null,
      ),
    };
  }

  it("tells the client when the session expires and hands the socket over at that moment", async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const controller = createSocketSessionController(
      "socket",
      authExpiringIn(60_000) as any,
      { unsubscribeAll: vi.fn() },
      undefined,
      onExpired,
    );
    const ack = vi.fn();
    await controller.hello({ token: "first" }, ack);
    expect(ack).toHaveBeenCalledWith({ userId: "u1", expiresInMs: 60_000 });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(controller.expireIfDue()).toBe(false);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(controller.expireIfDue()).toBe(true);
  });

  it("renews in place for the same authorization, pushing the expiry back", async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const subscriptions = { unsubscribeAll: vi.fn() };
    const controller = createSocketSessionController(
      "socket",
      authExpiringIn(60_000) as any,
      subscriptions,
      undefined,
      onExpired,
    );
    await controller.hello({ token: "first" });
    const before = controller.capture()!;
    await vi.advanceTimersByTimeAsync(50_000);

    await expect(controller.renew({ token: "rotated" })).resolves.toEqual({
      success: true,
      userId: "u1",
      expiresInMs: 60_000,
    });
    // Same operation: in-flight work fenced on it is still current, and
    // the renew did not drop the socket's subscriptions.
    expect(controller.isOperationCurrent(before.operation)).toBe(true);
    expect(subscriptions.unsubscribeAll).toHaveBeenCalledTimes(1);
    expect(controller.session?.user.fva).toEqual([2, -1]);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("refuses a renew that changes the authorization, is unresolvable, or has no session to extend", async () => {
    const controller = createSocketSessionController(
      "socket",
      authExpiringIn(60_000) as any,
      { unsubscribeAll: vi.fn() },
    );
    const refused = {
      success: false,
      error: "Session changed",
      code: "session_changed",
    };
    await expect(controller.renew({ token: "first" })).resolves.toEqual(refused);
    await controller.hello({ token: "first" });
    const session = controller.session;
    for (const payload of [
      { token: "otherOrg" },
      { token: "unknown" },
      { token: 42 },
      null,
      "first",
    ]) {
      await expect(controller.renew(payload)).resolves.toEqual(refused);
    }
    expect(controller.session).toBe(session);
  });

  it("reads a session with an unusable expiry as expired", async () => {
    const controller = createSocketSessionController(
      "socket",
      { resolveToken: async () => ({ user: { id: "u1" }, expiresAt: Number.NaN }) } as any,
      { unsubscribeAll: vi.fn() },
      undefined,
      vi.fn(),
    );
    await controller.hello({ token: "t" });
    expect(controller.expireIfDue()).toBe(true);
  });
});

describe("socket listeners", () => {
  beforeEach(() => {
    mocks.reset();
    delete (globalThis as any)[claim];
    vi.stubEnv("DATABASE_URL", "postgres://unused/test");
    vi.stubEnv("ENSURE_SCHEMA", "false");
  });

  afterEach(() => {
    delete (globalThis as any)[claim];
    delete (globalThis as any).__parcae_adapter;
    vi.unstubAllEnvs();
  });

  const MALFORMED: unknown[][] = [
    [],
    [null, null, null, null],
    [42, 42, 42, 42],
    ["disconnect", { not: "a method" }, ["a path"], undefined],
    ["req1", "GET", "/v1/x", {}, "not-a-function"],
    [{ token: 7 }, "not-a-function"],
    [{ queries: [null, 1, { key: 2 }] }, "not-a-function"],
    [{ queries: [] }, 12],
    ["not-a-payload", { not: "a function" }],
  ];

  async function connect() {
    route.on("custom:event", async () => {
      throw new Error("handler bug");
    });
    const app = createApp({ models: [] });
    await app.start({ port: 4000 });
    const onConnection = mocks.servers[0]!.io.on.mock.calls.find(
      (call: any[]) => call[0] === "connection",
    )![1];
    const listeners = new Map<string, (...args: any[]) => unknown>();
    const socket = {
      id: "socket-1",
      handshake: { headers: {} },
      conn: { close: vi.fn() },
      on: (event: string, listener: (...args: any[]) => unknown) => {
        listeners.set(event, listener);
      },
      emit: vi.fn(),
      join: vi.fn(),
      leave: vi.fn(),
      disconnect: vi.fn(),
      rooms: new Set<string>(),
    };
    onConnection(socket);
    return { app, listeners, socket };
  }

  it("contains every throw and rejection a malformed frame causes, on every event", async () => {
    const { app, listeners } = await connect();
    expect([...listeners.keys()].sort()).toEqual([
      "call",
      "custom:event",
      "disconnect",
      "hello",
      "renew",
      "resync",
      "unsubscribe:query",
    ]);
    const escaped: unknown[] = [];
    const record = (reason: unknown) => escaped.push(reason);
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", record);
    try {
      for (const [event, listener] of listeners) {
        if (event === "disconnect") continue;
        for (const args of MALFORMED) {
          expect(() => listener(...args), `${event}`).not.toThrow();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", record);
      for (const listener of saved) process.on("unhandledRejection", listener);
      await app.stop();
    }
    expect(escaped).toEqual([]);
  });

  it("answers a call with a malformed method or path with a 400 on its request id", async () => {
    const { app, listeners, socket } = await connect();
    try {
      listeners.get("hello")!({ token: null }, vi.fn());
      await new Promise((resolve) => setTimeout(resolve, 0));
      listeners.get("call")!("req1", 42, "/v1/x", {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      const [event, frame] = socket.emit.mock.calls.at(-1)!;
      expect(event).toBe("req1");
      const reply = decompress(JSON.parse(pako.ungzip(frame, { to: "string" })));
      expect(reply).toMatchObject({ success: false, status: 400 });
    } finally {
      await app.stop();
    }
  });
});

describe("model discovery normalization", () => {
  it("dedupes re-exported constructors and rejects distinct type collisions", () => {
    class Project {
      static type = "project";
    }
    class OtherProject {
      static type = "project";
    }

    expect(normalizeModels([Project as any, Project as any])).toEqual([Project]);
    expect(() =>
      normalizeModels([Project as any, OtherProject as any]),
    ).toThrow('same type "project"');
  });

  it("maps plural table names back to the exact declared model type", () => {
    const index = indexModelTypesByTable([
      { type: "settings" } as any,
      { type: "category" } as any,
    ]);

    expect(index.get("settings")).toBe("settings");
    expect(index.get("categories")).toBe("category");
  });
});

describe("resyncQueries limits", () => {
  it("rejects oversized resync batches before doing query work", async () => {
    await expect(
      resyncQueries(
        "socket",
        null,
        [
          { key: "a", modelType: "thing", steps: [] },
          { key: "b", modelType: "thing", steps: [] },
        ],
        {} as any,
        { maxEntries: 1 },
      ),
    ).rejects.toThrow("Resync query limit exceeded (2/1)");
  });

  it("processes resync queries with bounded concurrency", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let peak = 0;
    const makeQuery = () => {
      const query: any = {
        find: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await gate;
          inFlight--;
          return [];
        },
        count: async () => 0,
      };
      return query;
    };
    const Thing = {
      type: "thing",
      scope: { read: () => ({ allowed: true }) },
    };
    const adapter = {
      modelsByType: new Map([["thing", Thing]]),
      queryFromClient: vi.fn(() => makeQuery()),
      batchFindByType: vi.fn(async () => new Map()),
      subscriptions: null,
    };
    const entries = Array.from({ length: 6 }, (_, index) => ({
      key: String(index),
      modelType: "thing",
      steps: [],
      subscribe: false,
    }));

    const resync = resyncQueries("socket", null, entries, adapter as any, {
      concurrency: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    release();
    await expect(resync).resolves.toHaveLength(6);
    expect(peak).toBe(2);
  });

  it("returns explicit empty results for missing and denied models", async () => {
    const Denied = {
      type: "denied",
      scope: { read: () => null },
    };
    const NoRead = { type: "noRead", scope: {} };
    const adapter = {
      modelsByType: new Map([
        ["denied", Denied],
        ["noRead", NoRead],
      ]),
      batchFindByType: vi.fn(async () => new Map()),
      subscriptions: null,
    };

    await expect(
      resyncQueries(
        "socket",
        null,
        [
          { key: "missing-key", modelType: "missing", steps: [] },
          { key: "no-read-key", modelType: "noRead", steps: [] },
          { key: "denied-key", modelType: "denied", steps: [] },
        ],
        adapter as any,
      ),
    ).resolves.toEqual([
      { key: "missing-key", hash: null, items: [], totalCount: 0 },
      { key: "no-read-key", hash: null, items: [], totalCount: 0 },
      { key: "denied-key", hash: null, items: [], totalCount: 0 },
    ]);
  });
});
