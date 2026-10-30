/**
 * `scope.fields` evaluation — which columns a request context may name
 * in a query — and `scope.read` for the ref targets it reaches.
 *
 * Pure policy over a model's static scope: no adapter, no I/O. It sits
 * on its own so the two consumers share one definition — the query
 * replay in `adapters/model.ts`, and `prepareClientQuery`, which hands
 * the set to routes that validate a column outside the step list
 * (`__sum`). Keeping it off `BackendAdapter` also keeps it out of the
 * adapter interface every mock has to satisfy.
 */

import type {
  ModelConstructor,
  ScopeContext,
  ScopeResult,
} from "@parcae/model";

/** Shared empty result for models with no `scope.fields` policy. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Columns `ctx` may not reference in a query: the `privateFields`, which
 * `sanitize()` strips from every reply so a filter on one is the only
 * way to read it, and each `scope.fields` entry whose predicate fails.
 *
 * No `ctx` denies every policied column outright rather than
 * evaluating the predicates against an empty one — `(ctx) =>
 * ctx.user?.role !== "banned"` is true for `{}` and would fail open.
 */
export function deniedFields(
  modelClass: ModelConstructor<any>,
  ctx?: ScopeContext,
): ReadonlySet<string> {
  const fields = modelClass.scope?.fields;
  const privateFields = modelClass.privateFields ?? [];
  if (!fields && privateFields.length === 0) return EMPTY;
  const denied = new Set<string>(privateFields);
  for (const name of Object.keys(fields ?? {})) {
    if (!ctx || !fields![name]!(ctx)) denied.add(name);
  }
  return denied;
}

/** A `scope.read` result that admits rows: a query modifier or a where object. */
export type ReadScope = NonNullable<ScopeResult>;

/**
 * The rows of `target` that `ctx` may read directly, as its `scope.read`
 * returns them, or null when it may read none. A model with no
 * `scope.read` has no read route, so a ref into it reaches nothing
 * either; no `ctx` denies for the same fail-closed reason as
 * {@link deniedFields}.
 */
export function readScopeFor(
  target: ModelConstructor<any>,
  ctx?: ScopeContext,
): ReadScope | null {
  const read = target.scope?.read;
  if (!read || !ctx) return null;
  return read(ctx) || null;
}

/**
 * Field policy for one client-query replay. `own` is the queried
 * model's denied columns; `forTarget` resolves a ref target's, so
 * `Post.where("author.email", …)` is judged by User's policy.
 */
export interface FieldPolicy {
  own: ReadonlySet<string>;
  forTarget(target: ModelConstructor<any>): ReadonlySet<string>;
  /**
   * The rows of a ref target this ctx may reach through a ref filter:
   * null refuses the filter, undefined (trusted code only) leaves it
   * unscoped.
   */
  readScope(target: ModelConstructor<any>): ReadScope | null | undefined;
}

/**
 * Built by `queryFromClient` and threaded down as data. Server-side
 * chains pass nothing and get {@link NO_FIELD_POLICY}, so trusted code
 * is never subject to a policy meant for client input.
 */
export function fieldPolicyFor(
  modelClass: ModelConstructor<any>,
  ctx?: ScopeContext,
): FieldPolicy {
  return {
    own: deniedFields(modelClass, ctx),
    forTarget: (target) => deniedFields(target, ctx),
    readScope: (target) => readScopeFor(target, ctx),
  };
}

/** The open policy — nothing withheld. Used off the client path. */
export const NO_FIELD_POLICY: FieldPolicy = {
  own: EMPTY,
  forTarget: () => EMPTY,
  readScope: () => undefined,
};
