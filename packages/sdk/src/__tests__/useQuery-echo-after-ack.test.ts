/**
 * The backend diffs each subscription frame against the row as that
 * subscription last described it. A save ack has already moved the model's
 * snapshot past that baseline, so the frame's `add` for an array element
 * the ack delivered must not insert it a second time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@parcae/model";
import { EventEmitter } from "eventemitter3";

import { __test as useQueryTest } from "../react/useQuery";

class Setting extends Model {
  static type = "setting" as const;
  rules: Record<string, unknown[]> = {};
}

class FakeClient extends EventEmitter {
  public subscriptions: Array<{
    event: string;
    handler: (...args: any[]) => void;
  }> = [];
  public send = vi.fn();

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    const entry = { event, handler };
    this.subscriptions.push(entry);
    return () => {
      const idx = this.subscriptions.indexOf(entry);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  emitQueryOps(hash: string, ops: unknown[]): void {
    for (const sub of this.subscriptions) {
      if (sub.event === `query:${hash}`) sub.handler(ops);
    }
  }
}

const adapter = {
  save: async (_model: any, data: Record<string, any>) => structuredClone(data),
  remove: async () => {},
  findById: async () => null,
  query: () => ({}) as any,
  patch: async (_model: any, _ops: any[], data: Record<string, any>) =>
    structuredClone(data),
};

async function primeCache(client: FakeClient, hash: string) {
  const chain: any = {
    __modelType: "setting",
    __modelClass: Setting,
    __steps: [{ method: "where", args: [{ org: "o1" }] }],
    __adapter: null,
  };
  chain.find = async () => {
    const items = [Setting.hydrate(adapter, { id: "s1", rules: { inHours: [] } })];
    Object.defineProperty(items, "__queryHash", { value: hash, enumerable: false });
    Object.defineProperty(items, "__totalCount", { value: 1, enumerable: false });
    return items;
  };
  const key = useQueryTest.buildKey("setting", "u1", chain.__steps);
  const release = useQueryTest.retain(client as any, key, () => {});
  useQueryTest.fetch(key, chain, client as any);
  await new Promise((r) => setImmediate(r));
  const entry = useQueryTest.getEntry(client as any, key)!;
  return { entry, release };
}

describe("useQuery — subscription echo after the client's own save", () => {
  beforeEach(() => useQueryTest.resetCache());
  afterEach(() => useQueryTest.resetCache());

  it("keeps one array element when the echo of a save lands after its ack", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-echo");
    const row = entry.items[0];
    const rule = { destination: "reception", label: "Reception", number: "+61255501234" };

    row.rules = { inHours: [rule] };
    await row.save();

    client.emitQueryOps("h-echo", [
      {
        op: "update",
        id: "s1",
        patch: [
          {
            op: "add",
            path: "/rules/inHours/0",
            value: { label: "Reception", number: "+61255501234", destination: "reception" },
          },
        ],
      },
    ]);

    expect(entry.items[0].rules.inHours).toEqual([rule]);
    release();
  });

  it("diffs later frames against the add frame's row for an optimistic create", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-add");
    const local = Setting.hydrate(adapter, {
      id: "s2",
      tmp: "tmp-2",
      rules: { inHours: [] },
    });
    entry.optimistic.push(local);

    // The server's row carries a field the client never wrote; the next
    // frame is diffed against that row, so it must become the baseline.
    client.emitQueryOps("h-add", [
      {
        op: "add",
        id: "s2",
        data: { id: "s2", tmp: "tmp-2", rules: { inHours: [] }, status: "active" },
      },
    ]);
    expect(entry.items[1]).toBe(local);
    expect((local as any).status).toBe("active");

    client.emitQueryOps("h-add", [
      {
        op: "update",
        id: "s2",
        patch: [{ op: "replace", path: "/rules", value: { inHours: [] , afterHours: [] } }],
      },
    ]);

    expect((local as any).status).toBe("active");
    expect(local.rules).toEqual({ inHours: [], afterHours: [] });
    release();
  });
});
