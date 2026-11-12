import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FadenstackClient, loginWithPassword, toLocalRetention } from "@fadenstack/client";
import {
  ApprovalDecision,
  FadenstackAgent,
  MemoryApprovalStore,
  MemorySessionStore,
  newId,
  withinServerRetention,
  type SecretProtector,
  type StoreProblem,
  type TranscriptEntry,
} from "@fadenstack/agents";
import { FakeGateway, lastToolResults, type FakeGatewayOptions, type FakeModel } from "@fadenstack/testing";

import { PAGE_CONTRACT, Pages } from "./helpers.js";

/** Data rights (F2: export and delete my data) and retention (F3), with the stores encrypted. Port of the .NET DataRights tests. */
describe("my data on this device", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const users = [{ email: "anna@example.com", password: "secret" }, { email: "ben@example.com", password: "secret" }];
  const SECRET = "The merger with Contoso closes on Friday";

  const model: FakeModel = (request) =>
    lastToolResults(request).size ? { text: "Done." } : { toolCalls: [{ id: "c-1", name: "write_page", arguments: { page: 8, text: "x" } }] };

  function gatewayFor(extra: Partial<FakeGatewayOptions> = {}, agent: Record<string, unknown> = {}): FakeGateway {
    return new FakeGateway({ users, principal: true, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT], ...agent }], ...extra });
  }

  async function agentFor(gateway: FakeGateway, email: string, configure = (b: ReturnType<typeof FadenstackAgent.createBuilder>) => b): Promise<FadenstackAgent> {
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email, password: "secret", fetch: gateway.fetch }));
    const pages = new Pages();
    return configure(FadenstackAgent.createBuilder().useClient(client).addTools(pages.read, pages.write, pages.delete)
      .useApprovals(() => Promise.resolve(ApprovalDecision.approveAlways()))).build();
  }

  const names = async () => (await indexedDB.databases()).map((d) => d.name).sort();

  async function chat(agent: FadenstackAgent, text = SECRET): Promise<void> {
    await (await agent.startSession("ask")).send(text);
  }

  async function rawRows(name: string, store: string): Promise<Record<string, unknown>[]> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const req = db.transaction([store]).objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function putRaw(name: string, store: string, rows: unknown[]): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([store], "readwrite");
        for (const row of rows) tx.objectStore(store).put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  const USER_ONE = ["fadenstack-approvals:tenant-1:user-1", "fadenstack-keys:tenant-1:user-1", "fadenstack-sessions:tenant-1:user-1"];

  describe("the stores the SDK keeps", () => {
    it("are encrypted under a key of the user's own that the page cannot read", async () => {
      const agent = await agentFor(gatewayFor(), "anna@example.com");
      await chat(agent);
      await agent.dispose();

      expect(await names()).toEqual(USER_ONE);
      const everything = JSON.stringify([...await rawRows(USER_ONE[2]!, "entries"), ...await rawRows(USER_ONE[2]!, "sessions"), ...await rawRows(USER_ONE[0]!, "approvals")],
        (_, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v));
      expect(everything).not.toContain("Contoso");
      const [key] = await rawRows(USER_ONE[1]!, "keys") as unknown as CryptoKey[];
      expect(key!.extractable).toBe(false);
      expect(key!.algorithm).toMatchObject({ name: "AES-GCM" });

      const again = await agentFor(gatewayFor(), "anna@example.com");
      expect((await again.listSessions()).length).toBe(1);
      expect(await again.listApprovals()).toMatchObject([{ tool: "write_page" }]);
      await again.dispose();
    });

    it("use the host's protector when it supplies one, and no key of the SDK's", async () => {
      const calls: string[] = [];
      const protector: SecretProtector = {
        encrypts: true,
        protect: (data, context) => {
          calls.push(context);
          return Promise.resolve(Uint8Array.from([...data].map((b) => b ^ 0x5a)));
        },
        unprotect: (data) => Promise.resolve(Uint8Array.from([...data].map((b) => b ^ 0x5a))),
      };
      const agent = await agentFor(gatewayFor(), "anna@example.com", (b) => b.useSecretProtector(protector));
      await chat(agent);
      await agent.dispose();
      expect(calls.length).toBeGreaterThan(2);
      expect(await names()).toEqual([USER_ONE[0], USER_ONE[2]]); // no keys database
      const again = await agentFor(gatewayFor(), "anna@example.com", (b) => b.useSecretProtector(protector));
      expect((await again.listSessions()).length).toBe(1);
      await again.dispose();
    });

    it("tell the host of a record that does not decrypt, never throw at the person, and leak no contents", async () => {
      const agent = await agentFor(gatewayFor(), "anna@example.com");
      await chat(agent);
      await agent.dispose();
      // The key database is lost (a cleared profile restored from a backup of the other databases).
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(USER_ONE[1]!);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      const problems: StoreProblem[] = [];
      const again = await agentFor(gatewayFor(), "anna@example.com", (b) => b.useStoreProblemHandler((p) => problems.push(p)));
      expect(await again.listSessions()).toEqual([]);
      expect(await again.listApprovals()).toEqual([]);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((p) => p.kind === "undecryptable")).toBe(true);
      expect(JSON.stringify(problems)).not.toMatch(/Contoso|write_page/);
      await again.dispose();
    });

    it("write nothing and keep no key where there is no IndexedDB (Node)", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const calls: string[] = [];
      const protector: SecretProtector = { encrypts: true, protect: (d, c) => (calls.push(c), Promise.resolve(d)), unprotect: (d) => Promise.resolve(d) };
      const agent = await agentFor(gatewayFor(), "anna@example.com", (b) => b.useSecretProtector(protector));
      await chat(agent);
      expect((await agent.listSessions()).length).toBe(1);
      expect(calls).toEqual([]); // memory stores: nothing to protect
    });
  });

  describe("export (F2)", () => {
    it("is a JSON document of the user's sessions and approvals, decrypted, of every agent the stores hold", async () => {
      const agent = await agentFor(gatewayFor(), "anna@example.com");
      await chat(agent);
      await agent.sessionStore.append("excel", "x1", entry("user.message", { text: "Sum the column" }));
      await agent.approvalStore.add("excel", { tool: "write_cells", toolClass: "write", approvedAt: "2026-11-01T10:00:00.000Z" });

      const data = await agent.exportMyData();
      expect(JSON.parse(JSON.stringify(data))).toEqual(data); // plain JSON
      expect(data).toMatchObject({ format: "fadenstack-my-data", version: 1, counts: { agents: 2, sessions: 2, approvals: 2, unreadable: 0 } });
      const docs = data.sessions.find((s) => s.agent === "docs")!;
      expect(docs.title).toBe(SECRET);
      expect(docs.entries.some((e) => e.data["text"] === SECRET)).toBe(true);
      expect(data.sessions.find((s) => s.agent === "excel")!.entries[0]!.data["text"]).toBe("Sum the column");
      expect(data.approvals.map((a) => a.agent).sort()).toEqual(["docs", "excel"]);
      expect(data.notIncluded.join(" ")).toContain("Sign-in tokens");
      expect(JSON.stringify(data)).not.toMatch(/access_token|refresh_token|Bearer/i);
      await agent.dispose();
    });

    it("holds only the user's own data, and counts what it could not read instead of failing", async () => {
      const gateway = gatewayFor();
      const anna = await agentFor(gateway, "anna@example.com");
      await chat(anna);
      await anna.dispose();
      const ben = await agentFor(gateway, "ben@example.com");
      await chat(ben, "Ben's own question");

      const data = await ben.exportMyData();
      expect(JSON.stringify(data)).not.toContain("Contoso");
      expect(data.counts.sessions).toBe(1);

      // damage one of Ben's entries
      const dbName = (await names()).find((n) => n!.startsWith("fadenstack-sessions") && n!.endsWith("user-2"))!;
      const rows = await rawRows(dbName, "entries");
      const bad = (rows[1]!["data"] as Uint8Array).slice();
      bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
      await putRaw(dbName, "entries", [{ ...rows[1], data: bad }]);
      const damaged = await ben.exportMyData();
      expect(damaged.counts.unreadable).toBe(1);
      expect(damaged.sessions[0]!.entries.length).toBe(rows.length - 1);
      await ben.dispose();
    });

    it("reads a store the host passed for this agent only", async () => {
      const sessions = new MemorySessionStore();
      const approvals = new MemoryApprovalStore();
      await sessions.append("docs", "d1", entry("user.message", { text: "mine" }));
      await sessions.append("other-agent", "o1", entry("user.message", { text: "someone else's" }));
      await approvals.add("docs", { tool: "write_page", toolClass: "write", approvedAt: "2026-11-01T10:00:00.000Z" });
      const agent = await agentFor(gatewayFor(), "anna@example.com", (b) => b.useSessionStore(sessions).useApprovalStore(approvals));
      const data = await agent.exportMyData();
      expect(data.sessions.map((s) => s.agent)).toEqual(["docs"]);
      expect(data.counts).toMatchObject({ sessions: 1, approvals: 1 });
    });
  });

  describe("deletion (F2)", () => {
    it("removes the user's databases and their key, and leaves another user's alone", async () => {
      const gateway = gatewayFor();
      const ben = await agentFor(gateway, "ben@example.com");
      await chat(ben, "Ben's own question");
      await ben.dispose();
      const anna = await agentFor(gateway, "anna@example.com");
      await chat(anna);

      const result = await anna.deleteMyData();
      expect(result).toEqual({ storesCleared: 3, hostSessionStoreLeft: false, hostApprovalStoreLeft: false, hostStoresLeft: false });
      expect(await names()).toEqual(["fadenstack-approvals:tenant-1:user-2", "fadenstack-keys:tenant-1:user-2", "fadenstack-sessions:tenant-1:user-2"]);
      expect(await anna.listSessions()).toEqual([]);
      expect(await anna.listApprovals()).toEqual([]);
      expect((await anna.exportMyData()).counts).toMatchObject({ sessions: 0, approvals: 0 });

      // and goes on: new stores, a new key
      await chat(anna, "afterwards");
      expect((await anna.listSessions()).length).toBe(1);
      await anna.dispose();
      const bens = await agentFor(gateway, "ben@example.com");
      expect((await bens.listSessions()).length).toBe(1);
      await bens.dispose();
    });

    it("takes the user's thinking level with it, as .NET removes the user's whole folder", async () => {
      const gateway = gatewayFor();
      const anna = await agentFor(gateway, "anna@example.com");
      await chat(anna);
      await anna.setReasoning("low");
      const preferences = async () => (await names()).filter((n) => n?.startsWith("fadenstack-preferences:"));
      expect(await preferences()).toHaveLength(1);

      const result = await anna.deleteMyData();
      expect(result.storesCleared).toBe(4);
      expect(await preferences()).toEqual([]);
      expect(anna.reasoning).not.toBe("low");
      await anna.dispose();
    });

    it("takes the key with it: a copy of the databases from before can never be read again", async () => {
      const agent = await agentFor(gatewayFor(), "anna@example.com");
      await chat(agent);
      const before = {
        entries: await rawRows(USER_ONE[2]!, "entries"),
        sessions: await rawRows(USER_ONE[2]!, "sessions"),
        approvals: await rawRows(USER_ONE[0]!, "approvals"),
      };
      expect(before.entries.length).toBeGreaterThan(0);

      await agent.deleteMyData();
      // a backup of the profile is restored over the empty databases
      await chat(agent, "afterwards"); // creates them again, with the new key
      await putRaw(USER_ONE[2]!, "entries", before.entries.map((r) => ({ ...r, session: "restored" })));
      await putRaw(USER_ONE[2]!, "sessions", before.sessions.map((r) => ({ ...r, id: "restored" })));
      await putRaw(USER_ONE[0]!, "approvals", before.approvals);

      const problems: StoreProblem[] = [];
      await agent.dispose();
      const again = await agentFor(gatewayFor(), "anna@example.com", (b) => b.useStoreProblemHandler((p) => problems.push(p)));
      const list = await again.listSessions();
      expect(list.map((s) => s.title)).toEqual(["afterwards"]);
      expect(JSON.stringify(await again.exportMyData())).not.toContain("Contoso");
      expect(await again.listApprovals()).toEqual([]);
      expect(problems.length).toBeGreaterThan(0);
      await again.dispose();
    });

    it("leaves a store the host passed to the host, and says so", async () => {
      const gateway = gatewayFor();
      const both = await agentFor(gateway, "anna@example.com", (b) => b.useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore()));
      expect(await both.deleteMyData()).toEqual({ storesCleared: 0, hostSessionStoreLeft: true, hostApprovalStoreLeft: true, hostStoresLeft: true });

      const sessionsOnly = await agentFor(gateway, "anna@example.com", (b) => b.useSessionStore(new MemorySessionStore()));
      expect(await sessionsOnly.deleteMyData()).toMatchObject({ hostSessionStoreLeft: true, hostApprovalStoreLeft: false, hostStoresLeft: true });

      const approvalsOnly = await agentFor(gateway, "anna@example.com", (b) => b.useApprovalStore(new MemoryApprovalStore()));
      expect(await approvalsOnly.deleteMyData()).toMatchObject({ hostSessionStoreLeft: false, hostApprovalStoreLeft: true, hostStoresLeft: true });

      const none = await agentFor(gateway, "anna@example.com");
      expect(await none.deleteMyData()).toMatchObject({ hostSessionStoreLeft: false, hostApprovalStoreLeft: false, hostStoresLeft: false });
    });

    it("does not empty the host's own store", async () => {
      const sessions = new MemorySessionStore();
      await sessions.append("docs", "d1", entry("user.message", { text: "kept by the host" }));
      const agent = await agentFor(gatewayFor(), "anna@example.com", (b) => b.useSessionStore(sessions));
      await agent.deleteMyData();
      expect((await sessions.list("docs")).length).toBe(1);
    });

    it("clears the shared databases of an older SDK from a gateway that names no user", async () => {
      const agent = await agentFor(gatewayFor({ principal: false }), "anna@example.com");
      await chat(agent);
      expect(await names()).toEqual(["fadenstack-approvals", "fadenstack-keys", "fadenstack-sessions"]);
      expect((await agent.deleteMyData()).storesCleared).toBe(3);
      expect(await names()).toEqual([]);
    });
  });

  describe("retention (F3)", () => {
    async function sessionsAfterFour(gateway: FakeGateway, configure?: (b: ReturnType<typeof FadenstackAgent.createBuilder>) => ReturnType<typeof FadenstackAgent.createBuilder>): Promise<number> {
      const agent = await agentFor(gateway, "anna@example.com", configure);
      for (let i = 0; i < 4; i++) await agent.startSession("ask");
      const count = (await agent.listSessions()).length;
      await agent.dispose();
      return count;
    }

    it("takes the stricter of the device's limits and the server's, and a limit the server leaves out stays", () => {
      const own = { maxSessions: 50, maxAgeDays: 90 };
      expect(withinServerRetention(own, undefined)).toEqual(own);
      expect(withinServerRetention(own, { maxSessions: 10 })).toEqual({ maxSessions: 10, maxAgeDays: 90 });
      expect(withinServerRetention(own, { maxAgeDays: 30 })).toEqual({ maxSessions: 50, maxAgeDays: 30 });
      expect(withinServerRetention(own, { maxSessions: 200, maxAgeDays: 365 })).toEqual(own); // the server cannot raise them
      expect(withinServerRetention({ maxSessions: 5, maxAgeDays: 7 }, { maxSessions: 10, maxAgeDays: 3 })).toEqual({ maxSessions: 5, maxAgeDays: 3 });
    });

    it("reads local_retention from the profile: only positive whole numbers count", () => {
      expect(toLocalRetention({ max_age_days: 30, max_sessions: 5 })).toEqual({ maxAgeDays: 30, maxSessions: 5 });
      expect(toLocalRetention({ max_sessions: 5 })).toEqual({ maxSessions: 5 });
      expect(toLocalRetention({ max_age_days: 0, max_sessions: -1 })).toBeUndefined();
      expect(toLocalRetention({ max_age_days: 2.5, max_sessions: "7" })).toBeUndefined();
      expect(toLocalRetention({ max_age_days: 12, max_sessions: null })).toEqual({ maxAgeDays: 12 });
      expect(toLocalRetention("many")).toBeUndefined();
      expect(toLocalRetention(undefined)).toBeUndefined();
    });

    it("keeps only as many sessions as the server allows", async () => {
      expect(await sessionsAfterFour(gatewayFor({}, { localRetention: { max_sessions: 2 } }))).toBe(2);
    });

    it("keeps the app's own limit when the server sets none, or an invalid one", async () => {
      expect(await sessionsAfterFour(gatewayFor(), (b) => b.useSessionRetention({ maxSessions: 3, maxAgeDays: 90 }))).toBe(3);
      expect(await sessionsAfterFour(gatewayFor({}, { localRetention: { max_sessions: 0, max_age_days: "x" } }), (b) => b.useSessionRetention({ maxSessions: 3, maxAgeDays: 90 }))).toBe(3);
    });

    it("lets the server lower the app's limit but not raise it", async () => {
      expect(await sessionsAfterFour(gatewayFor({}, { localRetention: { max_sessions: 2 } }), (b) => b.useSessionRetention({ maxSessions: 3, maxAgeDays: 90 }))).toBe(2);
      expect(await sessionsAfterFour(gatewayFor({}, { localRetention: { max_sessions: 40 } }), (b) => b.useSessionRetention({ maxSessions: 3, maxAgeDays: 90 }))).toBe(3);
    });

    it("refuses a limit below one", () => {
      expect(() => FadenstackAgent.createBuilder().useSessionRetention({ maxSessions: 0, maxAgeDays: 90 })).toThrow(RangeError);
      expect(() => FadenstackAgent.createBuilder().useSessionRetention({ maxSessions: 5, maxAgeDays: 0 })).toThrow(RangeError);
    });
  });
});

function entry(type: string, data: Record<string, unknown> = {}): TranscriptEntry {
  return { id: newId(), parentId: null, timestamp: new Date().toISOString(), type, turnId: "t1", status: null, data };
}
