/**
 * One log line per lapsed, refused or reconnected socket session, so why a
 * user's connection dropped can be read from the server log.
 *
 * The client's own account of the drop arrives in its hello and is
 * untrusted: only known keys survive, numbers are bounded, and strings are
 * cut short.
 */

type Field = string | number | boolean;

const RENEW_OUTCOMES = new Set([
  "token-null",
  "token-unchanged",
  "token-error",
  "no-answer",
  "refused",
]);

const MAX_MS = 86_400_000;

// Every connection can write these lines, so a flood of connections or
// tokens could fill the log; past this many a minute they are dropped.
const LINES_PER_MINUTE = 300;
let budgetWindowStart = 0;
let budgetLines = 0;

export function withinLogBudget(): boolean {
  const now = Date.now();
  if (now - budgetWindowStart >= 60_000) {
    budgetWindowStart = now;
    budgetLines = 0;
  }
  return ++budgetLines <= LINES_PER_MINUTE;
}

export function clientDiagnostics(raw: unknown): Record<string, Field> | null {
  if (!raw || typeof raw !== "object") return null;
  const report = raw as Record<string, unknown>;
  const out: Record<string, Field> = {};
  const count = (key: string) => {
    const value = report[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.min(Math.max(Math.round(value), 0), MAX_MS);
    }
  };
  const text = (key: string, max: number) => {
    const value = report[key];
    if (typeof value === "string" && value) out[key] = value.slice(0, max);
  };
  const disconnect = disconnectReason(report.disconnect);
  if (disconnect) out.disconnect = disconnect;
  count("offlineMs");
  if (typeof report.hiddenAtDisconnect === "boolean") {
    out.hiddenAtDisconnect = report.hiddenAtDisconnect;
  }
  count("renewAttempts");
  count("renewLateMs");
  if (
    typeof report.renewOutcome === "string" &&
    RENEW_OUTCOMES.has(report.renewOutcome)
  ) {
    out.renewOutcome = report.renewOutcome;
  }
  text("renewError", 120);
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * socket.io's disconnect reason as a code ("transport close" becomes
 * "transport-close"), so it survives the log's no-whitespace rule.
 */
export function disconnectReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const code = raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
  return /^[a-z-]+$/.test(code) ? code : undefined;
}

/**
 * The `sub` and `exp` of a JWT, read without verifying it: who a token
 * says it is, for naming the line when it is refused.
 */
export function unverifiedTokenClaims(token: string): {
  sub?: string;
  exp?: number;
} {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const sub = payload?.sub;
    return {
      sub:
        typeof sub === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sub)
          ? sub
          : undefined,
      exp:
        typeof payload?.exp === "number" && Number.isFinite(payload.exp)
          ? payload.exp
          : undefined,
    };
  } catch {
    return {};
  }
}
