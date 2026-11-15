import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { IndexedDbMcpServerStore, McpStoreError, mcpModule } from "@fadenstack/mcp";

import { server } from "./rig.js";

/** Two contexts of one browser profile (a side panel and a service worker, two tabs): one IndexedDB, a store each. */
function contexts(options: { broadcast?: boolean } = {}): [IndexedDbMcpServerStore, IndexedDbMcpServerStore] {
  const factory = new IDBFactory();
  return [new IndexedDbMcpServerStore({ indexedDB: factory, ...options }), new IndexedDbMcpServerStore({ indexedDB: factory, ...options })];
}

async function eventually(condition: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`Did not happen in time: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one list in several contexts", () => {
  it("tells the other contexts of a server added or removed, and they read it", async () => {
    const [panel, worker] = contexts();
    let heard = 0;
    panel.onChanged(() => heard++);

    await worker.save(server("alpha", "https://a.example.com/mcp"));
    await eventually(() => heard === 1, "the panel hears the worker's save");
    expect((await panel.list()).map((s) => s.label)).toEqual(["alpha"]);

    await worker.remove("alpha");
    await eventually(() => heard === 2, "the panel hears the worker's removal");
    expect(await panel.list()).toEqual([]);
    panel.close();
    worker.close();
  });

  it("does not tell a context of another person's database, nor where broadcasting is off", async () => {
    const factory = new IDBFactory();
    const anna = new IndexedDbMcpServerStore({ indexedDB: factory, principal: { tenantId: "t", userId: "anna" } });
    const ben = new IndexedDbMcpServerStore({ indexedDB: factory, principal: { tenantId: "t", userId: "ben" } });
    const [quiet, loud] = contexts({ broadcast: false });
    let annaHeard = 0;
    let quietHeard = 0;
    anna.onChanged(() => annaHeard++);
    quiet.onChanged(() => quietHeard++);

    await ben.save(server("alpha", "https://a.example.com/mcp"));
    await loud.save(server("beta", "https://b.example.com/mcp"));
    await pause(50);

    expect(annaHeard).toBe(0);
    expect(quietHeard).toBe(0);
    for (const store of [anna, ben, quiet, loud]) store.close();
  });

  it("refuses a label another context takes at the same moment, in any case", async () => {
    const [panel, worker] = contexts();

    const results = await Promise.allSettled([
      panel.save(server("alpha", "https://a.example.com/mcp")),
      worker.save(server("Alpha", "https://b.example.com/mcp")),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(McpStoreError);
    expect(await panel.list()).toHaveLength(1);
    panel.close();
    worker.close();
  });

  it("the module of one context asks again when another context changes the list", async () => {
    const [panel, worker] = contexts();
    const module = mcpModule({ store: panel });
    let asked = 0;
    module.onChanged(() => asked++);

    await worker.save(server("gamma", "https://g.example.com/mcp"));

    await eventually(() => asked > 0, "the module asks again");
    expect((await module.servers()).map((s) => s.label)).toEqual(["gamma"]);
    module.dispose?.();
    panel.close();
    worker.close();
  });
});
