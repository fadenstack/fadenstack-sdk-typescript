import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  EventQueue,
  IndexedDbApprovalStore,
  IndexedDbSessionStore,
  checkArguments,
  newId,
  type TranscriptEntry,
} from "@fadenstack/agents";

function entry(type: string, data: Record<string, unknown> = {}, at = new Date().toISOString()): TranscriptEntry {
  return { id: newId(), parentId: null, timestamp: at, type, turnId: "t1", status: null, data };
}

describe("IndexedDbApprovalStore", () => {
  it("keeps what was allowed always per agent, one entry per tool, and forgets one tool or all", async () => {
    const store = new IndexedDbApprovalStore({ indexedDB: new IDBFactory() });
    const at = new Date().toISOString();
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: at });
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: at });
    await store.add("docs", { tool: "rename_page", toolClass: "write", approvedAt: at });
    await store.add("excel", { tool: "write_cells", toolClass: "write", approvedAt: at });
    expect((await store.list("docs")).map((a) => a.tool).sort()).toEqual(["rename_page", "write_page"]);
    await store.remove("docs", "write_page");
    expect((await store.list("docs")).map((a) => a.tool)).toEqual(["rename_page"]);
    await store.remove("docs");
    expect(await store.list("docs")).toEqual([]);
    expect(await store.list("excel")).toEqual([{ tool: "write_cells", toolClass: "write", approvedAt: at }]);
  });
});

describe("IndexedDbSessionStore", () => {
  it("keeps a session entry by entry, and lists it by its first message", async () => {
    const store = new IndexedDbSessionStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
    await store.append("docs", "s1", entry("session.start"));
    await store.append("docs", "s1", entry("user.message", { text: "What is on page 7?" }));
    await store.append("docs", "s1", entry("assistant.message", { text: "Table T1" }));
    const read = await store.read("docs", "s1");
    expect(read.map((e) => e.type)).toEqual(["session.start", "user.message", "assistant.message"]);
    expect(await store.list("docs")).toEqual([expect.objectContaining({ id: "s1", agent: "docs", title: "What is on page 7?" })]);
    expect(await store.list("other")).toEqual([]);
    await store.delete("docs", "s1");
    expect(await store.read("docs", "s1")).toEqual([]);
    expect(await store.list("docs")).toEqual([]);
  });

  it("keeps the newest sessions and none older than the age limit", async () => {
    const store = new IndexedDbSessionStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, retention: { maxSessions: 3, maxAgeDays: 30 } });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await store.append("a", "ancient", entry("session.start", {}, old));
    for (let i = 1; i <= 4; i++) {
      await store.append("a", `s${i}`, entry("session.start", {}, new Date(Date.now() + i).toISOString()));
    }
    expect((await store.list("a")).map((s) => s.id)).toEqual(["s4", "s3", "s2"]);
  });
});

describe("EventQueue", () => {
  it("hands over items in order, then the end or the error", async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    const reading = (async () => {
      const seen: number[] = [];
      for await (const n of queue) seen.push(n);
      return seen;
    })();
    queue.push(2);
    queue.end();
    expect(await reading).toEqual([1, 2]);

    const failing = new EventQueue<number>();
    failing.push(1);
    failing.end(new Error("boom"));
    const seen: number[] = [];
    await expect((async () => {
      for await (const n of failing) seen.push(n);
    })()).rejects.toThrow("boom");
    expect(seen).toEqual([1]);
  });
});

describe("checkArguments", () => {
  const schema = {
    type: "object",
    properties: { page: { type: "integer" }, mode: { type: "string", enum: ["a", "b"] }, tags: { type: "array" } },
    required: ["page"],
    additionalProperties: false,
  };

  it("accepts good arguments and names what is wrong with bad ones", () => {
    expect(checkArguments(schema, { page: 3, mode: "a", tags: [] })).toBeUndefined();
    expect(checkArguments(schema, { page: 1.5, mode: "c", extra: 1 }))
      .toBe("Invalid arguments: 'page' must be integer; 'mode' must be one of \"a\", \"b\"; 'extra' is not a parameter.");
    expect(checkArguments(schema, {})).toBe("Invalid arguments: 'page' is required.");
  });
});
