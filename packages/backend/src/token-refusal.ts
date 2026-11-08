import { AsyncLocalStorage } from "node:async_hooks";
import { isLogId } from "./log";

/**
 * Why a token resolved to no session, for the socket's refusal lines. An
 * error is kept only as its name and code: a parse error's message can
 * quote the token itself, and a socket line never carries a token.
 */
export interface TokenRefusal {
  reason: string;
  errorName?: string;
  errorCode?: string;
}

const judging = new AsyncLocalStorage<{ refusal?: TokenRefusal }>();

function refusal(reason: string, error?: unknown): TokenRefusal {
  if (error === undefined) {
    return { reason };
  }
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return {
    reason,
    errorName: error instanceof Error ? error.name : typeof error,
    ...(isLogId(code) && { errorCode: code }),
  };
}

/**
 * Name why an auth adapter, or a wrapper around one, refuses the token it is
 * resolving, and return the null it then returns. The first reason named
 * wins: the innermost adapter decides first, and a wrapper passing a null
 * through names nothing. Outside a socket hello or renew it does nothing.
 */
export function refuseToken(reason: string, error?: unknown): null {
  const slot = judging.getStore();
  if (slot && !slot.refusal) {
    slot.refusal = refusal(reason, error);
  }
  return null;
}

/**
 * Resolve a token, and when it resolves to nothing say why: the reason an
 * adapter named, `adapter-error` with the name of the error it threw, or
 * `unexplained` when an adapter returned null without naming one.
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
    return { session: null, refusal: refusal("adapter-error", error) };
  }
}
