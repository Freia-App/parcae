/**
 * Wire-visible error messages that mark a socket session boundary.
 *
 * The backend refuses resyncs and RPCs with these exact strings, and the
 * SDK fails CLOSED when it sees one (rendered rows from the prior
 * authorization are blanked instead of retained). Matching is by
 * substring on the client, so a reworded refusal silently downgrades
 * fail-closed to stale-while-revalidate: change these values nowhere
 * else, and never rephrase a refusal without going through this table.
 *
 * The message table is the fallback. A refusal carries a stable wire
 * `code` from SESSION_BOUNDARY_CODES, which classification prefers so
 * a peer that rewords a message still lands in the right bucket.
 */
export const SESSION_BOUNDARY_ERRORS = {
  changed: "Session changed",
  notReconciled: "Session is not reconciled",
  terminated: "Session terminated",
} as const;

/** Stable wire codes for the same boundaries, immune to rewording. */
export const SESSION_BOUNDARY_CODES = {
  changed: "session_changed",
  notReconciled: "session_not_reconciled",
  terminated: "session_terminated",
} as const;

export type SessionBoundary = keyof typeof SESSION_BOUNDARY_CODES;

/** True when an error message marks a session/authorization boundary. */
export function isSessionBoundaryError(message: string): boolean {
  return (
    message.includes(SESSION_BOUNDARY_ERRORS.changed) ||
    message.includes(SESSION_BOUNDARY_ERRORS.notReconciled) ||
    message.includes(SESSION_BOUNDARY_ERRORS.terminated)
  );
}

/**
 * Which boundary an error marks, or null when it marks none. Takes
 * anything a catch block can hand it.
 *
 * The message pass folds case. A server deployed before the codes
 * existed prefixes its refusal ("Socket session is not reconciled"),
 * and during a rolling deploy that peer is answering a client that
 * already classifies by code. A case-sensitive test would read that
 * refusal as an ordinary error and let a caller retry it, which is the
 * fail-open the whole table exists to prevent.
 */
export function sessionBoundaryOf(error: unknown): SessionBoundary | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  for (const kind of Object.keys(SESSION_BOUNDARY_CODES) as SessionBoundary[]) {
    if (code === SESSION_BOUNDARY_CODES[kind]) return kind;
  }
  if (typeof message !== "string") return null;
  const lower = message.toLowerCase();
  for (const kind of Object.keys(SESSION_BOUNDARY_ERRORS) as SessionBoundary[]) {
    if (lower.includes(SESSION_BOUNDARY_ERRORS[kind].toLowerCase())) return kind;
  }
  return null;
}

/**
 * The refusal envelope a server writes on the wire, built from the two
 * tables so a hand-written wording cannot drift off them.
 */
export function sessionBoundaryRefusal(kind: SessionBoundary): {
  message: string;
  code: string;
  status: 409;
} {
  return {
    message: SESSION_BOUNDARY_ERRORS[kind],
    code: SESSION_BOUNDARY_CODES[kind],
    status: 409,
  };
}
