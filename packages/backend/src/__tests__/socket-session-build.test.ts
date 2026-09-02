/**
 * The hello acknowledgement is the one message every client receives on
 * every (re)connection, so it is where the server says which build it is
 * running. A client that reconnects after a deploy compares the value with
 * the one it saw before and can tell its user a newer version exists.
 */
import { describe, expect, it, vi } from "vitest";
import { createSocketSessionController } from "../app";

const subscriptions = { unsubscribeAll: () => {} };

describe("socket hello acknowledgement", () => {
  it("carries the configured build alongside the resolved user", async () => {
    const controller = createSocketSessionController(
      "s1",
      null,
      subscriptions,
      "sha-1",
    );
    const callback = vi.fn();
    await controller.hello({ token: null }, callback);
    expect(callback).toHaveBeenCalledWith({ userId: null, build: "sha-1" });
  });

  it("omits build when the app did not configure one", async () => {
    const controller = createSocketSessionController("s1", null, subscriptions);
    const callback = vi.fn();
    await controller.hello({ token: null }, callback);
    expect(callback).toHaveBeenCalledWith({ userId: null });
  });
});
