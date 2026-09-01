/**
 * Session-boundary refusals — the wire contract callers classify by.
 *
 * The backend's socket channels refuse work across a session boundary.
 * A caller must be able to tell such a refusal from any other error by
 * a constant (the wire `code`), with the exact message table as the
 * fallback for older peers. The refusal envelope is built by
 * `sessionBoundaryRefusal` so a hand-written wording can never drift
 * off the table again.
 */
import { describe, expect, it } from "vitest";
import {
  SESSION_BOUNDARY_CODES,
  SESSION_BOUNDARY_ERRORS,
  isSessionBoundaryError,
  sessionBoundaryOf,
  sessionBoundaryRefusal,
} from "../session-boundary";

describe("sessionBoundaryRefusal", () => {
  it("builds an envelope whose message matches the boundary table", () => {
    for (const kind of ["changed", "notReconciled", "terminated"] as const) {
      const refusal = sessionBoundaryRefusal(kind);
      expect(refusal.message).toBe(SESSION_BOUNDARY_ERRORS[kind]);
      expect(refusal.code).toBe(SESSION_BOUNDARY_CODES[kind]);
      expect(isSessionBoundaryError(refusal.message)).toBe(true);
      expect(sessionBoundaryOf(refusal)).toBe(kind);
    }
  });
});

describe("sessionBoundaryOf", () => {
  it("classifies by wire code ahead of the message", () => {
    expect(
      sessionBoundaryOf({
        message: "reworded by a proxy",
        code: SESSION_BOUNDARY_CODES.notReconciled,
      }),
    ).toBe("notReconciled");
    // When the two disagree, the code is the authority.
    expect(
      sessionBoundaryOf({
        message: SESSION_BOUNDARY_ERRORS.terminated,
        code: SESSION_BOUNDARY_CODES.notReconciled,
      }),
    ).toBe("notReconciled");
  });

  it("falls back to the message table for older peers", () => {
    expect(
      sessionBoundaryOf(new Error(SESSION_BOUNDARY_ERRORS.terminated)),
    ).toBe("terminated");
    expect(
      sessionBoundaryOf(new Error(SESSION_BOUNDARY_ERRORS.changed)),
    ).toBe("changed");
  });

  // A server deployed before the codes existed is the peer a client
  // meets mid-rolling-deploy, and its prefixed wording is the only
  // not-reconciled refusal a REST call can receive from it.
  it("classifies a pre-codes server's prefixed refusal", () => {
    expect(
      sessionBoundaryOf({ message: "Socket session is not reconciled" }),
    ).toBe("notReconciled");
  });

  it("returns null for anything else", () => {
    expect(sessionBoundaryOf(new Error("RPC timeout: GET /posts"))).toBeNull();
    expect(sessionBoundaryOf("Session terminated")).toBeNull();
    expect(sessionBoundaryOf(null)).toBeNull();
    expect(sessionBoundaryOf(undefined)).toBeNull();
    expect(sessionBoundaryOf({ message: "Resync failed" })).toBeNull();
  });
});
