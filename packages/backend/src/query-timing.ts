/**
 * @parcae/backend — slow and failed query lines.
 *
 * A line for every query Knex sends that fails, and every one slower than
 * 500 ms, naming the table, method, duration and pool. A slow line never
 * carries the SQL; a failed one carries the error, whose message Knex writes
 * with the statement and whose detail can quote a row. A pool that cannot hand out
 * a connection fails before any query is sent, so it writes nothing here.
 */

import { log } from "./log";

const SLOW_MS = 500;
// Past this many queries in flight at once the oldest starts are dropped,
// so a stream of queries that never answer cannot grow the map.
const MAX_IN_FLIGHT = 5_000;
const TABLE =
  /\b(?:from|into|update|join)\s+(?:"?[A-Za-z_][\w-]{0,62}"?\.)?"?([A-Za-z_][\w-]{0,62})"?/i;

interface KnexQuery {
  __knexQueryUid?: string;
  method?: string;
  sql?: string;
}

interface QueryEvents {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export function observeQueries(db: QueryEvents, pool: "read" | "write"): void {
  const started = new Map<string, number>();
  const take = (query: KnexQuery): number | undefined => {
    const uid = query.__knexQueryUid;
    const at = uid ? started.get(uid) : undefined;
    if (uid) {
      started.delete(uid);
    }
    return at === undefined ? undefined : performance.now() - at;
  };
  const fields = (query: KnexQuery, elapsed: number | undefined) => ({
    table: TABLE.exec(query.sql ?? "")?.[1] ?? null,
    method: query.method ?? null,
    durationMs: elapsed === undefined ? null : Math.round(elapsed),
    pool,
  });

  db.on("query", (query: KnexQuery) => {
    if (!query.__knexQueryUid) {
      return;
    }
    if (started.size >= MAX_IN_FLIGHT) {
      started.delete(started.keys().next().value as string);
    }
    started.set(query.__knexQueryUid, performance.now());
  });
  db.on("query-response", (_response: unknown, query: KnexQuery) => {
    const elapsed = take(query);
    if (elapsed !== undefined && elapsed >= SLOW_MS) {
      log.warn("[db] slow query", fields(query, elapsed));
    }
  });
  db.on("query-error", (error: unknown, query: KnexQuery) => {
    log.error("[db] query failed", { ...fields(query, take(query)), error });
  });
}
