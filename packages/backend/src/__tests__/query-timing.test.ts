import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureLogs } from "../log";
import { observeQueries } from "../query-timing";

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.stop();
  vi.restoreAllMocks();
});

const SQL = `select * from "patients" where "email" = 'jane@example.com'`;

it("names the table and duration of a slow or failed query, never its SQL", () => {
  const db = new EventEmitter();
  observeQueries(db, "read");
  const now = vi.spyOn(performance, "now");

  now.mockReturnValue(1_000);
  db.emit("query", { __knexQueryUid: "q1", method: "select", sql: SQL });
  now.mockReturnValue(1_100);
  db.emit("query-response", [], { __knexQueryUid: "q1", sql: SQL });

  now.mockReturnValue(2_000);
  db.emit("query", { __knexQueryUid: "q2", method: "select", sql: SQL });
  now.mockReturnValue(2_750);
  db.emit("query-response", [], {
    __knexQueryUid: "q2",
    method: "select",
    sql: SQL,
  });

  db.emit("query", { __knexQueryUid: "q3", method: "insert", sql: SQL });
  db.emit(
    "query-error",
    Object.assign(new Error("Key (email)=(jane@example.com) exists"), {
      code: "23505",
    }),
    { __knexQueryUid: "q3", method: "insert", sql: SQL },
  );

  expect(
    logs.lines.map((l) => [l.msg, l.table, l.method, l.durationMs, l.pool]),
  ).toEqual([
    ["slow query", "patients", "select", 750, "read"],
    ["query failed", "patients", "insert", 0, "read"],
  ]);
  expect(logs.lines[1]).toMatchObject({
    level: "error",
    errorCode: "23505",
    errorMessage: "Key (email)=(jane@example.com) exists",
  });
});

it("names a table whose quoted name has a hyphen", () => {
  const db = new EventEmitter();
  observeQueries(db, "write");
  const sql = `insert into public."chat-messages" ("body") values ($1)`;
  db.emit("query", { __knexQueryUid: "h1", method: "insert", sql });
  db.emit("query-error", new Error("boom"), {
    __knexQueryUid: "h1",
    method: "insert",
    sql,
  });
  expect(logs.lines[0]).toMatchObject({
    msg: "query failed",
    table: "chat-messages",
  });
});
