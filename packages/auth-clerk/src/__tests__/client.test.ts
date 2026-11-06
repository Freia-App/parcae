import { describe, expect, it, vi } from "vitest";
import { createClerkAuthAdapter } from "../client.js";

describe("createClerkAuthAdapter", () => {
  it("propagates token read errors", async () => {
    const failure = new Error("Clerk unavailable");
    const adapter = createClerkAuthAdapter(async () => {
      throw failure;
    }, { subscribe: () => () => {} });

    await expect(adapter.getToken()).rejects.toBe(failure);
  });

  it("reads tokens from the supplied Clerk session change source", async () => {
    let onSessionChange: (() => void) | null = null;
    const getToken = vi.fn().mockResolvedValue("token-2");
    const adapter = createClerkAuthAdapter(getToken, {
      subscribe(callback) {
        onSessionChange = callback;
        return () => {
          onSessionChange = null;
        };
      },
    });
    const onChange = vi.fn();
    const unsubscribe = adapter.onChange!(onChange);

    onSessionChange!();
    await Promise.resolve();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith("token-2");

    unsubscribe();
    expect(onSessionChange).toBeNull();
  });

  // Clerk's cache measures a token's life on the device clock. With the
  // clock running slow it hands back a token the server already expired,
  // which is what kept a clinician's socket dropping every minute.
  const clerkWithStaleCache = () =>
    vi.fn(async (opts?: { skipCache?: boolean }) =>
      opts?.skipCache ? "minted" : "expired-but-cached",
    );

  it("mints a token when the transport asks for a fresh one", async () => {
    const getToken = clerkWithStaleCache();
    const adapter = createClerkAuthAdapter(getToken, {
      organizationId: "org_1",
      subscribe: () => () => {},
    });

    await expect(adapter.getToken({ fresh: true })).resolves.toBe("minted");
    expect(getToken).toHaveBeenCalledWith({
      organizationId: "org_1",
      skipCache: true,
    });
  });

  // Each mint runs Clerk's session listeners, so a hello that minted would
  // wake onChange before its own ack and start another hello.
  it("reads Clerk's cache for a hello and for session changes", async () => {
    let onSessionChange: (() => void) | null = null;
    const getToken = clerkWithStaleCache();
    const adapter = createClerkAuthAdapter(getToken, {
      subscribe(callback) {
        onSessionChange = callback;
        return () => {};
      },
    });
    const onChange = vi.fn();
    adapter.onChange!(onChange);

    await expect(adapter.getToken()).resolves.toBe("expired-but-cached");
    onSessionChange!();
    await Promise.resolve();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith("expired-but-cached");
    expect(getToken).not.toHaveBeenCalledWith(
      expect.objectContaining({ skipCache: true }),
    );
  });
});
