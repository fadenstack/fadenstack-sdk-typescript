import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { ApprovalDecision, FadenstackAgent, MemoryApprovalStore, MemorySessionStore, userLocalKey } from "@fadenstack/agents";
import { FakeGateway } from "@fadenstack/testing";

/** The export holds all the deletion removes, without secrets (GDPR Art. 15 and 20; as .NET's `DataExport`). */
describe("exportMyData beyond sessions and approvals", () => {
  const SECRETS = ["s3cret-header", "s3cret-query", "s3cret-password", "s3cret-unknown", "s3cret-user"];
  const users = [{ email: "anna@example.com", password: "secret" }, { email: "ben@example.com", password: "secret" }];
  const ANNA = ":tenant-1:user-1";
  const BEN = ":tenant-1:user-2";

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

  async function seed(name: string, stores: Record<string, { keyPath?: string; autoIncrement?: boolean; rows: [unknown, IDBValidKey?][] }>): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        for (const [store, spec] of Object.entries(stores)) {
          open.result.createObjectStore(store, { ...(spec.keyPath ? { keyPath: spec.keyPath } : {}), ...(spec.autoIncrement ? { autoIncrement: true } : {}) });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(Object.keys(stores), "readwrite");
      for (const [store, spec] of Object.entries(stores)) for (const [row, key] of spec.rows) tx.objectStore(store).put(row, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function seedPerson(suffix: string, tag: string): Promise<void> {
    await seed(`fadenstack-preferences${suffix}`, { reasoning: { keyPath: "agent", rows: [[{ agent: "docs", level: `high-${tag}` }]] } });
    await seed(`fadenstack-skills${suffix}`, { skills: { rows: [[{ name: "my-skill", description: `d-${tag}`, body: `my own text ${tag}` }, "my-skill"]] } });
    await seed(`fadenstack-skill-switches${suffix}`, { off: { rows: [[true, `off-${tag}`]] } });
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    await seed(`fadenstack-provenance${suffix}`, {
      keys: { rows: [[{ privateKey: key.privateKey, certificate: new Uint8Array([1, 2, 3]), marker: "KEYMATERIAL" }, "device"]] },
      records: { rows: [[{ signed: { record: { id: `rec-${tag}` }, signature: "a.b.c", timestamp: null }, queued: false }, `rec-${tag}`]] },
      placements: { autoIncrement: true, rows: [[{ hash: `h-${tag}`, kind: "insert" }]] },
    });
    await seed(`fadenstack-mcp${suffix}`, {
      servers: {
        rows: [[{
          label: `srv-${tag}`, url: "https://user:s3cret-password@mcp.example.com:8443/v1/mcp?token=s3cret-query#s3cret-query", enabled: true, trusted: false,
          toolClasses: { a: "write" }, callTimeoutS: 30, importedFrom: "mcpServers", reviewed: true, plainHttpInLan: false,
          headerNames: ["Authorization"], sealed: new Uint8Array([9, 9, 9]), apiKey: "s3cret-unknown", extra: { nested: "s3cret-unknown" },
        }, `srv-${tag}`]],
      },
      audit: { autoIncrement: true, rows: [[{ event: "local_mcp.plain_http", at: "2026-11-15T10:00:00Z", source: "http://192.168.0.5", state: "on", warning_version: "1", person: "x" }]] },
    });
    await seed(`fadenstack-keys${suffix}`, { keys: { rows: [[{ marker: "KEYSTORE" }, "k"]] } });
  }

  async function agentFor(gateway: FakeGateway, email: string): Promise<FadenstackAgent> {
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email, password: "secret", fetch: gateway.fetch }));
    return FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore())
      .useApprovals(() => Promise.resolve(ApprovalDecision.approve())).build();
  }

  const gateway = () => new FakeGateway({ users, principal: true, model: () => ({ text: "Hi." }), agents: [{ slug: "docs" }] });

  it("hands over every database of the person, without a secret and without key material", async () => {
    await seedPerson(ANNA, "anna");
    await seedPerson(BEN, "ben");
    localStorage.setItem(userLocalKey("prompts", { tenantId: "tenant-1", userId: "user-1" }), JSON.stringify([{ id: "1", text: "my prompt anna" }]));
    localStorage.setItem(userLocalKey("language", { tenantId: "tenant-1", userId: "user-1" }), "de");
    localStorage.setItem(userLocalKey("language", { tenantId: "tenant-1", userId: "user-2" }), "fr");
    const agent = await agentFor(gateway(), "anna@example.com");

    const data = await agent.exportMyData();

    const json = JSON.stringify(data);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    expect(json).not.toContain("KEYMATERIAL");
    expect(json).not.toContain("KEYSTORE");
    expect(json).not.toContain("privateKey");
    expect(json).not.toContain("-ben");
    expect(json).not.toContain(`"value":"fr"`);
    expect(data.format).toBe("fadenstack-my-data");
    expect(data.version).toBe(1);
    const d = data.databases!;
    expect(Object.keys(d).sort()).toEqual(["mcp", "preferences", "provenance", "skill-switches", "skills"]);
    expect(d["preferences"]!["reasoning"]).toEqual([{ agent: "docs", level: "high-anna" }]);
    expect(d["skills"]!["skills"]).toEqual([{ key: "my-skill", value: { name: "my-skill", description: "d-anna", body: "my own text anna" } }]);
    expect(d["skill-switches"]!["off"]).toEqual([{ key: "off-anna", value: true }]);
    expect(Object.keys(d["provenance"]!).sort()).toEqual(["placements", "records"]);
    expect(JSON.stringify(d["provenance"])).toContain("rec-anna");
    expect(JSON.stringify(d["provenance"])).toContain("h-anna");
    expect(d["mcp"]!["servers"]).toEqual([{
      key: "srv-anna",
      value: {
        label: "srv-anna", url: "https://mcp.example.com:8443/v1/mcp", enabled: true, trusted: false, reviewed: true, plainHttpInLan: false,
        toolClasses: { a: "write" }, callTimeoutS: 30, importedFrom: "mcpServers", headerNames: ["Authorization"],
      },
    }]);
    expect(d["mcp"]!["audit"]).toHaveLength(1);
    expect(data.localStorage).toEqual([{ name: "language", value: "de" }, { name: "prompts", value: JSON.stringify([{ id: "1", text: "my prompt anna" }]) }]);
    expect(data.notIncluded.join(" ")).toMatch(/keys/i);
    expect(data.notIncluded.join(" ")).toMatch(/header/i);
    await agent.dispose();
  });

  it("skips a database that does not exist, and makes none", async () => {
    await seed(`fadenstack-skills${ANNA}`, { skills: { rows: [[{ name: "only" }, "only"]] } });
    const agent = await agentFor(gateway(), "anna@example.com");

    const data = await agent.exportMyData();

    expect(Object.keys(data.databases!)).toEqual(["skills"]);
    expect(data.localStorage).toBeUndefined();
    const names = (await indexedDB.databases()).map((x) => x.name);
    expect(names.some((n) => n?.startsWith("fadenstack-mcp"))).toBe(false);
    expect(names.some((n) => n?.startsWith("fadenstack-provenance"))).toBe(false);
    await agent.dispose();
  });

  it("hands over the web search settings and never the sealed Brave key, and deleting removes them", async () => {
    await seed(`fadenstack-web-search${ANNA}`, {
      settings: { rows: [[{ provider: "searxng", searxngUrl: "https://searx.example.org/" }, "settings"]] },
      key: { rows: [[new Uint8Array([1, 2, 3, 4]), "brave"]] },
    });
    const agent = await agentFor(gateway(), "anna@example.com");

    const data = await agent.exportMyData();

    expect(data.databases!["web-search"]).toEqual({
      settings: [{ key: "settings", value: { provider: "searxng", searxngUrl: "https://searx.example.org/" } }],
    });
    await agent.deleteMyData();
    expect((await indexedDB.databases()).some((x) => x.name === `fadenstack-web-search${ANNA}`)).toBe(false);
    await agent.dispose();
  });

  it("counts a row that is not plain data instead of throwing, and never hands it over", async () => {
    const blob = new Blob(["BLOBTEXT"]);
    await seed(`fadenstack-skills${ANNA}`, { skills: { rows: [[{ name: "ok" }, "ok"], [{ name: "bad", file: new Uint8Array([1]) }, "bad"], [{ name: "blob", file: blob }, "blob"]] } });
    const agent = await agentFor(gateway(), "anna@example.com");

    const data = await agent.exportMyData();

    expect(data.databases!["skills"]!["skills"]).toEqual([{ key: "ok", value: { name: "ok" } }]);
    expect(data.counts.unreadable).toBe(2);
    await agent.dispose();
  });

  it("deleteMyData removes the person's localStorage keys and counts them, and leaves another person's", async () => {
    const anna = { tenantId: "tenant-1", userId: "user-1" };
    localStorage.setItem(userLocalKey("prompts", anna), "[]");
    localStorage.setItem(userLocalKey("language", anna), "de");
    localStorage.setItem(userLocalKey("language", { tenantId: "tenant-1", userId: "user-2" }), "fr");
    localStorage.setItem("fadenstack.prompts", "[]"); // the old shared key is not a governed person's
    const agent = await agentFor(gateway(), "anna@example.com");

    const result = await agent.deleteMyData();

    expect(result.storesCleared).toBe(2);
    expect(localStorage.getItem(userLocalKey("language", anna))).toBeNull();
    expect(localStorage.getItem(userLocalKey("language", { tenantId: "tenant-1", userId: "user-2" }))).toBe("fr");
    expect(localStorage.getItem("fadenstack.prompts")).toBe("[]");
    await agent.dispose();
  });
});
