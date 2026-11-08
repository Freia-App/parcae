import { AsyncLocalStorage } from "node:async_hooks";

/** Why a token resolved to no session, for the socket's refusal lines. */
export interface TokenRefusal {
  reason: string;
  error?: unknown;
}

const judging = new AsyncLocalStorage<{ refusal?: TokenRefusal }>();

/**
 * Name why an auth adapter, or a wrapper around one, refuses the token it is
 * resolving, and return the null it then returns. The first reason named
 * wins: the innermost adapter decides first, and a wrapper passing a null
 * through names nothing. Outside a socket hello or renew it does nothing.
 */
export function refuseToken(reason: string, error?: unknown): null {
  const slot = judging.getStore();
  if (slot && !slot.refusal) {
    slot.refusal = error === undefined ? { reason } : { reason, error };
  }
  return null;
}

/**
 * Resolve a token, and when it resolves to nothing say why: the reason an
 * adapter named, `adapter-error` with the error it threw, or `unexplained`
 * when an adapter returned null without naming one.
 */
export async function judgeToken<S>(
  resolve: () => Promise<S | null>,
): Promise<
  { session: S; refusal: null } | { session: null; refusal: TokenRefusal }
> {
  const slot: { refusal?: TokenRefusal } = {};
  try {
    const session = await judging.run(slot, resolve);
    return session
      ? { session, refusal: null }
      : { session: null, refusal: slot.refusal ?? { reason: "unexplained" } };
  } catch (error) {
    return { session: null, refusal: { reason: "adapter-error", error } };
  }
}
