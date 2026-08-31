/**
 * SQL adapter root-clear tests.
 *
 * A root `remove` (or a root `add`/`replace` carrying null) on a
 * DECLARED json column must persist as SQL NULL. The previous
 * behaviour wrote `'{}'::jsonb`, which reads back as a present empty
 * object and counts as non-null for CHECK constraints: a model whose
 * before-save hook clears one polymorphic value column while another
 * holds the value then violates an at-most-one-non-null constraint on
 * every save.
 *
 * The `data` overflow column is the one json column whose absent
 * state really is `'{}'`, so it keeps the old behaviour.
 *
 * Same recording-knex-stub approach as patch-vivify.test.ts: no real
 * database, the SQL builder layer is the unit under test.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { BackendAdapter } from "../adapters/model";
import { clearHooks } from "../routing/hook";

interface RawCall {
  sql: string;
  bindings: any[];
}

interface UpdateCall {
  table: string;
  fields: Record<string, unknown>;
}

function createKnexStub() {
  const raws: RawCall[] = [];
  const updates: UpdateCall[] = [];
  let currentRow: Record<string, any> = {
    id: "p1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    data: {},
  };

  type Raw = { __raw: true; sql: string; bindings: any[] };

  const knex: any = (table: string) => {
    let whereVal: unknown;
    return {
      where(_col: string, val: unknown) {
        whereVal = val;
        return this;
      },
      forUpdate() {
        return this;
      },
      async first() {
        return currentRow;
      },
      update(fields: Record<string, unknown>) {
        const resolved: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v && typeof v === "object" && (v as Raw).__raw) {
            const r = v as Raw;
            resolved[k] = { sql: r.sql, bindings: r.bindings };
          } else {
            resolved[k] = v;
          }
        }
        updates.push({ table, fields: resolved });
        currentRow = { ...currentRow, id: whereVal as string };
        return {
          returning: async () => [{ ...currentRow }],
        };
      },
    };
  };

  knex.raw = (sql: string, bindings: any[] = []) => {
    raws.push({ sql, bindings });
    return { __raw: true, sql, bindings } as Raw;
  };
  knex.transaction = async (fn: (trx: any) => Promise<any>) => fn(knex);

  return {
    knex,
    lastFieldFor(column: string): unknown {
      const last = [...updates].reverse().find((u) => column in u.fields);
      return last ? last.fields[column] : undefined;
    },
    setRow(row: Record<string, any>) {
      currentRow = { ...row };
    },
  };
}

const ResultModel: any = {
  type: "result",
  __schema: {
    valueCompound: "json",
    metadata: "json",
    data: "json",
    title: "string",
  },
  hydrate(_adapter: BackendAdapter, data: Record<string, any>) {
    const m: any = { ...data, __data: data };
    m.constructor = ResultModel;
    return m;
  },
};

function makeModel(): any {
  return {
    constructor: ResultModel,
    id: "p1",
    __data: { id: "p1", metadata: {}, data: {} },
    __serverSnapshot: { id: "p1", valueCompound: null, metadata: {}, data: {} },
  };
}

describe("BackendAdapter._patchPostgres — root clears write SQL NULL", () => {
  let adapter: BackendAdapter;
  let stub: ReturnType<typeof createKnexStub>;

  beforeEach(() => {
    clearHooks();
    stub = createKnexStub();
    adapter = new BackendAdapter({ read: stub.knex, write: stub.knex });
    adapter.engine = "postgres";
  });

  afterEach(() => {
    clearHooks();
  });

  it("root remove on a declared json column writes SQL NULL, not '{}'", async () => {
    await adapter.patch(makeModel(), [
      { op: "remove", path: "/valueCompound" } as any,
    ]);
    expect(stub.lastFieldFor("valueCompound")).toBeNull();
  });

  it("root replace with null writes SQL NULL", async () => {
    await adapter.patch(makeModel(), [
      { op: "replace", path: "/metadata", value: null } as any,
    ]);
    expect(stub.lastFieldFor("metadata")).toBeNull();
  });

  it("root add with null writes SQL NULL", async () => {
    await adapter.patch(makeModel(), [
      { op: "add", path: "/valueCompound", value: null } as any,
    ]);
    expect(stub.lastFieldFor("valueCompound")).toBeNull();
  });

  it("root remove followed by a nested add rebuilds from '{}' instead of NULL", async () => {
    await adapter.patch(makeModel(), [
      { op: "remove", path: "/metadata" } as any,
      { op: "add", path: "/metadata/kept", value: 1 } as any,
    ]);
    const field = stub.lastFieldFor("metadata") as RawCall;
    expect(field).not.toBeNull();
    expect(field.sql).toContain("'{}'::jsonb");
  });

  it("root remove on the data overflow column keeps '{}'", async () => {
    await adapter.patch(makeModel(), [
      { op: "remove", path: "/data" } as any,
    ]);
    const field = stub.lastFieldFor("data") as RawCall;
    expect(field).not.toBeNull();
    expect(field.sql).toContain("'{}'::jsonb");
  });

  it("nested remove alone does not null the column", async () => {
    await adapter.patch(makeModel(), [
      { op: "remove", path: "/metadata/gone" } as any,
    ]);
    const field = stub.lastFieldFor("metadata") as RawCall;
    expect(field).not.toBeNull();
    expect(field.sql).toContain("#-");
  });

  it("root replace with a non-null object still writes the value", async () => {
    await adapter.patch(makeModel(), [
      { op: "replace", path: "/metadata", value: { a: 1 } } as any,
    ]);
    const field = stub.lastFieldFor("metadata") as RawCall;
    expect(field).not.toBeNull();
    expect(field.sql).toContain("?::jsonb");
    expect(field.bindings).toContain(JSON.stringify({ a: 1 }));
  });
});

describe("saveDiff — a nullish pair is not a change", () => {
  let adapter: BackendAdapter;
  let stub: ReturnType<typeof createKnexStub>;

  beforeEach(() => {
    clearHooks();
    stub = createKnexStub();
    adapter = new BackendAdapter({ read: stub.knex, write: stub.knex });
    adapter.engine = "postgres";
  });

  afterEach(() => {
    clearHooks();
  });

  function makeSaveModel(snapshot: Record<string, any>, data: Record<string, any>): any {
    const m = Object.create(ResultModel.prototype ?? {});
    m.constructor = ResultModel;
    m.id = "p1";
    m.__isNew = false;
    m.__serverSnapshot = snapshot;
    m.__data = data;
    return m;
  }

  it("does not re-clear a column the snapshot holds as null and the instance omits", async () => {
    await adapter.save(
      makeSaveModel(
        { id: "p1", valueCompound: null, metadata: {}, title: "a", data: {} },
        { id: "p1", metadata: {}, title: "b", data: {} },
      ),
    );
    expect(stub.lastFieldFor("title")).toBe("b");
    expect(stub.lastFieldFor("valueCompound")).toBeUndefined();
  });

  it("still nulls a column the snapshot holds non-null and the instance cleared", async () => {
    stub.setRow({
      id: "p1",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      valueCompound: { sys: 120 },
      metadata: {},
      title: "a",
      data: {},
    });
    await adapter.save(
      makeSaveModel(
        { id: "p1", valueCompound: { sys: 120 }, metadata: {}, title: "a", data: {} },
        { id: "p1", metadata: {}, title: "a", data: {} },
      ),
    );
    expect(stub.lastFieldFor("valueCompound")).toBeNull();
  });
});
