import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EndpointDialect } from "@fadenstack/client";
import { ApprovalDecision, type ApprovalRequest } from "@fadenstack/agents";
import { OpenAiFake } from "@fadenstack/testing";

import { BrowserKeyStore, DEFINITION, KEY_DATABASE, KEY_PREFIX, Notes, buildSampleAgent } from "../src/sample.js";

// The sample page builds its agent against the testing package's fakes: no network. The page itself (main.tsx) only wires
// this to the SDK's React skin.
describe("the standalone web sample's agent", () => {
  class FakeStorage {
    readonly #map = new Map<string, string>();
    get length(): number { return this.#map.size; }
    key(i: number): string | null { return [...this.#map.keys()][i] ?? null; }
    getItem(k: string): string | null { return this.#map.get(k) ?? null; }
    setItem(k: string, v: string): void { this.#map.set(k, v); }
    removeItem(k: string): void { this.#map.delete(k); }
  }

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.stubGlobal("localStorage", new FakeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function run(decide: (request: ApprovalRequest) => ApprovalDecision) {
    const fake = new OpenAiFake();
    fake.answers.push(OpenAiFake.calls(["call-1", "save_note", '{"text":"buy milk"}']), OpenAiFake.text("Saved."));
    const notes = new Notes();
    const asked: ApprovalRequest[] = [];
    const agent = buildSampleAgent({
      endpoint: { baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch },
      notes,
      approvals: (request) => {
        asked.push(request);
        return Promise.resolve(decide(request));
      },
    });
    await agent.start();
    const result = await (await agent.startSession("ask")).send("Save a note: buy milk");
    return { agent, notes, asked, result };
  }

  it("is standalone, with the definition's one write tool and content marking on", async () => {
    const { agent, asked } = await run(() => ApprovalDecision.approve());

    expect(agent.connection).toBe("standalone");
    expect(agent.profile.slug).toBe(DEFINITION.slug);
    expect(agent.tools.map((t) => [t.name, t.toolClass])).toContainEqual(["save_note", "write"]);
    expect(agent.settings.modules).toContain("provenance");
    expect(asked).toHaveLength(1);
  });

  it("asks before it writes, and saves the note once the person allows it", async () => {
    const { notes, asked } = await run(() => ApprovalDecision.approve());

    expect([asked[0]?.toolName, asked[0]?.toolClass, asked[0]?.arguments]).toEqual(["save_note", "write", { text: "buy milk" }]);
    expect(asked[0]?.target).toBe('note "buy milk" in this page\'s list');
    expect(notes.items).toEqual(["buy milk"]);
  });

  it("saves nothing when the person says no", async () => {
    const { notes } = await run(() => ApprovalDecision.deny());

    expect(notes.items).toEqual([]);
  });

  it("removes the sample's own key store with the person's data: the sealed key and its seal database", async () => {
    const { agent } = await run(() => ApprovalDecision.approve());
    const endpoint = new URL("http://localhost:11434/v1");
    await new BrowserKeyStore().save(endpoint, "sk-test-key");
    const keyName = KEY_PREFIX + endpoint.origin;
    expect(localStorage.getItem(keyName)).not.toBeNull();
    expect((await indexedDB.databases()).map((d) => d.name)).toContain(KEY_DATABASE);

    const result = await agent.deleteMyData();

    expect(localStorage.getItem(keyName)).toBeNull();
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(KEY_DATABASE);
    expect(result.storesCleared).toBeGreaterThanOrEqual(2); // counted: the seal database and the key
  });
});
