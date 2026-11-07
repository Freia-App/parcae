/**
 * A socket session that lapses, refuses a token or reconnects leaves one
 * log line saying why, with the client's own account of the drop when it
 * sent one. The client's report is untrusted input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSocketSessionController } from "../app";
import type { AuthAdapter, AuthSession } from "../auth";
import { captureLogs, type Line, withLogContext } from "../log";
import { clientDiagnostics, withinLogBudget } from "../socket-diagnostics";

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

/** The line minus the fields every line carries. */
function own(line: Line): Record<string, unknown> {
  const {
    schema: _s,
    at: _a,
    service: _sv,
    environment: _e,
    deployment: _d,
    lane: _l,
    task: _t,
    ...rest
  } = line;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null));
}

function jwt(payload: Record<string, unknown>): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
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
});

describe("socket session log lines", () => {
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    logs = captureLogs();
  });
  afterEach(() => {
    logs.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("says a hello refused its token, naming the user from its unverified claims", async () => {
    const controller = createSocketSessionController(
      "s1",
      adapterWith({}),
      subscriptions,
    );
    await withLogContext({ trigger: "socket", ip: "203.0.113.9" }, () =>
      controller.hello({
        token: jwt({ sub: "user_2abcDEF", exp: NOW / 1000 - 30 }),
        client: "dashboard/2026.11.07/web",
        diag: {
          disconnect: "transport close",
          offlineMs: 900,
          renewAttempts: 8,
          renewLateMs: 0,
          renewOutcome: "token-unchanged",
        },
      }),
    );
    expect(logs.lines.map(own)).toEqual([
      {
        level: "warn",
        tag: "socket",
        msg: "hello refused its token",
        user: "user_2abcDEF",
        ip: "203.0.113.9",
        app: "dashboard",
        appVersion: "2026.11.07",
        platform: "web",
        trigger: "socket",
        expiredAgoMs: 30_000,
        disconnect: "transport-close",
        offlineMs: 900,
        renewAttempts: 8,
        renewLateMs: 0,
        renewOutcome: "token-unchanged",
      },
    ]);
  });

  it("logs a reconnect with the user and the time its token has left", async () => {
    const controller = createSocketSessionController(
      "s1",
      adapterWith({ t1: session("org:admin", 12_000) }),
      subscriptions,
    );
    await withLogContext({ trigger: "socket" }, () =>
      controller.hello({
        token: "t1",
        diag: { disconnect: "transport close", offlineMs: 5_000, renewAttempts: 1, renewLateMs: 61_000 },
      }),
    );
    expect(logs.lines.map(own)).toEqual([
      {
        level: "info",
        tag: "socket",
        msg: "reconnected",
        user: "u1",
        org: "o1",
        role: "admin",
        trigger: "socket",
        expiresInMs: 12_000,
        disconnect: "transport-close",
        offlineMs: 5_000,
        renewAttempts: 1,
        renewLateMs: 61_000,
      },
    ]);
  });

  it("logs nothing for a first hello that resolves", async () => {
    const controller = createSocketSessionController(
      "s1",
      adapterWith({ t1: session("org:admin", 60_000) }),
      subscriptions,
    );
    await controller.hello({ token: "t1" });
    expect(logs.lines).toEqual([]);
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
    expect(logs.lines.map(own)).toEqual([
      {
        level: "info",
        tag: "socket",
        msg: "renew refused",
        user: "u1",
        reason: "changed",
      },
    ]);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onExpired.mock.calls).toEqual([
      [
        {
          user: "u1",
          expiredAgoMs: 0,
          sessionAgeMs: 105_000,
          renews: 1,
          lastRenewAgoMs: 60_000,
          lastRenewRefusal: "changed",
        },
      ],
    ]);
  });

  it("does not call a token refused when the app checks no tokens", async () => {
    const controller = createSocketSessionController("s1", null, subscriptions);
    await controller.hello({ token: "t1" });
    expect(logs.lines).toEqual([]);
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
    expect(logs.lines.map(own)).toEqual([
      {
        level: "info",
        tag: "socket",
        msg: "renew refused",
        user: "u1",
        reason: "superseded",
      },
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onExpired.mock.calls).toEqual([
      [
        {
          user: "u1",
          expiredAgoMs: 0,
          sessionAgeMs: 60_000,
          renews: 0,
          lastRenewAgoMs: undefined,
          lastRenewRefusal: undefined,
        },
      ],
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
