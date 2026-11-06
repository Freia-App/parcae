/**
 * A socket session that lapses, refuses a token or reconnects leaves one
 * log line saying why, with the client's own account of the drop when it
 * sent one. The client's report is untrusted input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSocketSessionController } from "../app";
import type { AuthAdapter, AuthSession } from "../auth";
import { log } from "../logger";
import {
  clientDiagnostics,
  logFields,
  withinLogBudget,
} from "../socket-diagnostics";

const subscriptions = { unsubscribeAll: () => {} };
const NOW = 1_900_000_000_000;

// Each token resolves when presented, so its expiry counts from then.
function adapterWith(
  sessions: Record<string, () => AuthSession>,
): AuthAdapter {
  return {
    resolveToken: async (token: string) => sessions[token]?.() ?? null,
  } as unknown as AuthAdapter;
}

function session(role: string, expiresInMs: number): () => AuthSession {
  return () =>
    ({
      user: { id: "u1", orgId: "o1", orgRole: role },
      expiresAt: Date.now() + expiresInMs,
    }) as AuthSession;
}

describe("client diagnostics from a hello", () => {
  it("keeps known keys only, bounds numbers and cuts strings", () => {
    expect(
      clientDiagnostics({
        disconnect: "transport close".repeat(10),
        offlineMs: 4_200.6,
        hiddenAtDisconnect: true,
        renewAttempts: -3,
        renewLateMs: 1e12,
        renewOutcome: "token-unchanged",
        renewError: "x".repeat(500),
        token: "secret",
        nested: { a: 1 },
      }),
    ).toEqual({
      disconnect: "transport close".repeat(10).slice(0, 40),
      offlineMs: 4_201,
      hiddenAtDisconnect: true,
      renewAttempts: 0,
      renewLateMs: 86_400_000,
      renewOutcome: "token-unchanged",
      renewError: "x".repeat(120),
    });
  });

  it("drops an outcome it does not know and anything that is not an object", () => {
    expect(clientDiagnostics({ renewOutcome: "pwned" })).toBeNull();
    expect(clientDiagnostics("diag")).toBeNull();
    expect(clientDiagnostics(null)).toBeNull();
  });

  it("quotes string values so none can forge a field or a line", () => {
    expect(
      logFields({ user: 'u1" admin=true\nfake', renews: 2, gone: undefined }),
    ).toBe('user="u1\\" admin=true\\nfake" renews=2');
  });
});

describe("socket session log lines", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    info = vi.spyOn(log, "info").mockImplementation(() => {});
    warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("says a hello refused its token, with the client's account of the drop", async () => {
    const controller = createSocketSessionController(
      "s1",
      adapterWith({}),
      subscriptions,
    );
    await controller.hello({
      token: "stale",
      diag: {
        disconnect: "transport close",
        offlineMs: 900,
        renewAttempts: 8,
        renewLateMs: 0,
        renewOutcome: "token-unchanged",
      },
    });
    expect(warn.mock.calls).toEqual([
      [
        '[socket] hello refused its token disconnect="transport close" offlineMs=900 renewAttempts=8 renewLateMs=0 renewOutcome="token-unchanged"',
      ],
    ]);
  });

  it("logs a reconnect with the user and the time its token has left", async () => {
    const controller = createSocketSessionController(
      "s1",
      adapterWith({ t1: session("org:admin", 12_000) }),
      subscriptions,
    );
    await controller.hello({
      token: "t1",
      diag: { disconnect: "transport close", offlineMs: 5_000, renewAttempts: 1, renewLateMs: 61_000 },
    });
    expect(info.mock.calls).toEqual([
      [
        '[socket] reconnected user="u1" expiresInMs=12000 disconnect="transport close" offlineMs=5000 renewAttempts=1 renewLateMs=61000',
      ],
    ]);
  });

  it("logs nothing for a first hello that resolves", async () => {
    const controller = createSocketSessionController(
      "s1",
      adapterWith({ t1: session("org:admin", 60_000) }),
      subscriptions,
    );
    await controller.hello({ token: "t1" });
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs why a renew was refused, and the lapse line carries the renewal history", async () => {
    const onExpired = vi.fn();
    const controller = createSocketSessionController(
      "s1",
      adapterWith({
        t1: session("org:admin", 60_000),
        t2: session("org:admin", 60_000),
        t3: session("org:member", 60_000),
      }),
      subscriptions,
      undefined,
      onExpired,
    );
    await controller.hello({ token: "t1" });
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(controller.renew({ token: "t2" })).resolves.toMatchObject({
      success: true,
    });
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(controller.renew({ token: "t3" })).resolves.toMatchObject({
      success: false,
    });
    expect(info.mock.calls).toEqual([
      ['[socket] renew refused user="u1" reason="changed"'],
    ]);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onExpired.mock.calls).toEqual([
      [
        'user="u1" expiredAgoMs=0 sessionAgeMs=105000 renews=1 lastRenewAgoMs=60000 lastRenewRefusal="changed"',
      ],
    ]);
  });

  it("does not call a token refused when the app checks no tokens", async () => {
    const controller = createSocketSessionController("s1", null, subscriptions);
    await controller.hello({ token: "t1" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves a renew refusal off the session a newer hello replaced it with", async () => {
    let finishRenew!: (session: AuthSession) => void;
    const onExpired = vi.fn();
    const sessions: Record<string, () => AuthSession | Promise<AuthSession>> = {
      t1: session("org:admin", 60_000),
      t2: () =>
        new Promise<AuthSession>((resolve) => {
          finishRenew = resolve;
        }),
      t3: session("org:admin", 60_000),
    };
    const controller = createSocketSessionController(
      "s1",
      {
        resolveToken: async (token: string) => sessions[token]?.() ?? null,
      } as unknown as AuthAdapter,
      subscriptions,
      undefined,
      onExpired,
    );
    await controller.hello({ token: "t1" });
    const renewing = controller.renew({ token: "t2" });
    await controller.hello({ token: "t3" });
    finishRenew(session("org:admin", 60_000)());
    await expect(renewing).resolves.toMatchObject({ success: false });
    expect(info.mock.calls).toEqual([
      ['[socket] renew refused user="u1" reason="superseded"'],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onExpired.mock.calls).toEqual([
      ['user="u1" expiredAgoMs=0 sessionAgeMs=60000 renews=0'],
    ]);
  });
});

describe("socket diagnostic log budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops lines past the minute's budget and starts again the next minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 3_600_000);
    const allowed = Array.from({ length: 301 }, () => withinLogBudget());
    expect(allowed.filter(Boolean)).toHaveLength(300);
    expect(allowed.at(-1)).toBe(false);
    vi.setSystemTime(NOW + 3_660_000);
    expect(withinLogBudget()).toBe(true);
  });
});
