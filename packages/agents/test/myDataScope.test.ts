import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EndpointDialect, FadenstackClient, loginWithPassword } from "@fadenstack/client";
import {
  AgentDefinition, ApprovalDecision, BROWSER_LOG_DATABASE, FadenstackAgent, IndexedDbAppRecords, STANDALONE_PRINCIPAL, userStoreName,
  type DataDeletion,
} from "@fadenstack/agents";
import { FakeGateway, OpenAiFake } from "@fadenstack/testing";

/**
 * "Remove my data…" takes only the calling app's data; the shared data goes only when no other Fadenstack app in this browser uses
 * the person's data; "Remove all" takes everything; the export follows the same scope (owner, 16 Nov; GDPR Art. 15, 17, 20).
 * App A is "Word add-in" (agent `docs`), app B is "Desktop agent" (agent `desktop-assistant`): two agents of one browser profile,
 * one person. Port of the .NET MyDataScopeTests.
 */
describe("my data per app", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PERSON = { tenantId: "tenant-1", userId: "user-1" };
  const APP_A = "Word add-in";
  const APP_B = "Desktop agent";
  const AGENT_A = "docs";
  const AGENT_B = "desktop-assistant";
  const users = [{ email: "anna@example.com", password: "secret" }];
  const gateway = () => new FakeGateway({ users, principal: true, model: () => ({ text: "Done." }), agents: [{ slug: AGENT_A }, { slug: AGENT_B }, { slug: "excel-assistant" }] });
  const db = (base: string) => userStoreName(base, PERSON);

  async function app(gw: FakeGateway, slug: string, name: string | undefined): Promise<FadenstackAgent> {
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gw.serverUrl, agent: slug, fetch: gw.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gw.serverUrl, email: "anna@example.com", password: "secret", fetch: gw.fetch }));
    const builder = FadenstackAgent.createBuilder().useClient(client).useApprovals(() => Promise.resolve(ApprovalDecision.approveAlways()));
    return (name ? builder.describeApp({ name }) : builder).build();
  }

  /** An app's own data: a chat, an "Allow always", a thinking level. */
  async function seedOwn(agent: FadenstackAgent, text: string): Promise<string> {
    const session = await agent.startSession("ask");
    await session.send(text);
    await agent.approvalStore.add(agent.slug, { tool: "write_page", toolClass: "write", approvedAt: "2026-11-16T10:00:00.000Z" });
    await agent.setReasoning("high");
    return session.id;
  }

  /** The person's shared data, as the modules write it: skills, a key of provenance, the person's web search. */
  async function seedShared(): Promise<void> {
    await put(db("fadenstack-skills"), "skills", [{ name: "notes", text: "Short sentences." }], { keyPath: "name" });
    await put(db("fadenstack-provenance"), "records", [{ signed: { record: { id: "r1" } }, signature: "a.b.c" }], { keyPath: null });
    await put(db("fadenstack-web-search"), "settings", [{ id: "provider", provider: "searxng" }], { keyPath: "id" });
  }

  async function put(name: string, store: string, rows: unknown[], options: { keyPath: string | null }): Promise<void> {
    const handle = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => { open.result.createObjectStore(store, options.keyPath ? { keyPath: options.keyPath } : { autoIncrement: true }); };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = handle.transaction([store], "readwrite");
      for (const row of rows) tx.objectStore(store).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    handle.close();
  }

  async function rows(name: string, store: string): Promise<Record<string, unknown>[]> {
    const handle = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const req = handle.transaction([store]).objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
        req.onerror = () => reject(req.error);
      });
    } finally {
      handle.close();
    }
  }

  const databases = async () => (await indexedDB.databases()).map((d) => d.name).sort();
  const has = async (name: string) => (await databases()).includes(name);
  const SHARED = ["fadenstack-skills", "fadenstack-provenance", "fadenstack-web-search"].map(db);

  /** An app on an older SDK: it writes no record, only its data. */
  async function forgetRecord(name: string): Promise<void> {
    const records = new IndexedDbAppRecords({ name: db("fadenstack-apps") });
    await records.remove(name);
    records.close();
  }

  it("the default scope is this app's, and an AbortSignal alone still works", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");

    const exported = await a.exportMyData(new AbortController().signal);
    expect(exported.scope).toBe("thisApp");
    expect(exported.sessions.map((s) => s.agent)).toEqual([AGENT_A]);
    const deletion = await a.deleteMyData(new AbortController().signal);

    expect(deletion.scope).toBe("thisApp");
    expect(deletion.otherApps).toEqual([APP_B]);
    expect((await b.listSessions()).length).toBe(1);
  });

  it("this app's removal takes the person's browser log too, while the shared data stays for the other app", async () => {
    const gw = gateway();
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gw.serverUrl, agent: AGENT_A, fetch: gw.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gw.serverUrl, email: "anna@example.com", password: "secret", fetch: gw.fetch }));
    const builder = FadenstackAgent.createBuilder().useClient(client).useApprovals(() => Promise.resolve(ApprovalDecision.approveAlways()))
      .describeApp({ name: APP_A }).useBrowserLog();
    const log = builder.browserLog!;
    const a = builder.build();
    const b = await app(gw, AGENT_B, APP_B);
    await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");
    await seedShared();
    await a.flush();
    await log.flush();
    expect(await has(db(BROWSER_LOG_DATABASE))).toBe(true);

    const deletion = await a.deleteMyData();

    expect(deletion).toMatchObject({ scope: "thisApp", otherApps: [APP_B], sharedDataKept: true });
    expect(await has(db(BROWSER_LOG_DATABASE))).toBe(false);
    for (const name of SHARED) expect(await has(name)).toBe(true);
  });

  it("by default the removal takes this app's data and leaves the other app and the shared data", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    const mine = await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");
    await seedShared();

    const deletion = await a.deleteMyData();

    expect(deletion).toMatchObject({ scope: "thisApp", otherApps: [APP_B], sharedDataKept: true, agentsKept: [] });
    // A's data is gone ...
    expect(await a.listSessions()).toEqual([]);
    expect(await a.listApprovals()).toEqual([]);
    expect((await rows(db("fadenstack-sessions"), "sessions")).map((r) => r["agent"])).toEqual([AGENT_B]);
    expect((await rows(db("fadenstack-sessions"), "entries")).every((r) => r["agent"] === AGENT_B)).toBe(true);
    expect((await rows(db("fadenstack-preferences"), "reasoning")).map((r) => r["agent"])).toEqual([AGENT_B]);
    expect((await rows(db("fadenstack-apps"), "apps")).map((r) => r["app"])).toEqual([APP_B]);
    expect(JSON.stringify(await a.exportMyData({ scope: "allApps" }))).not.toContain(mine);
    // ... and B's, the shared data and the data key stay
    expect((await b.listSessions()).length).toBe(1);
    expect((await b.listApprovals()).map((x) => x.tool)).toEqual(["write_page"]);
    for (const name of [...SHARED, db("fadenstack-keys")]) expect(await has(name), name).toBe(true);
    expect((await b.exportMyData()).sessions[0]!.title).toBe("B's chat");
  });

  it("when no other app uses the data, this app's removal takes the shared data, the data key and everything", async () => {
    const a = await app(gateway(), AGENT_A, APP_A);
    await seedOwn(a, "A's chat");
    await seedShared();

    const deletion = await a.deleteMyData({ scope: "thisApp" });

    expect(deletion).toMatchObject({ scope: "thisApp", otherApps: [], sharedDataKept: false, agentsKept: [] });
    expect(await databases()).toEqual([]);
  });

  it("the last app removing its data takes the shared data, the data key and the rest", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");
    await seedShared();

    await a.deleteMyData();
    expect(await has(db("fadenstack-keys"))).toBe(true);
    const last = await b.deleteMyData();

    expect(last).toMatchObject({ otherApps: [], sharedDataKept: false });
    expect(await databases()).toEqual([]);
  });

  it("an app on an older SDK without a record still keeps the shared data, and is listed by its agent", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const older = await app(gw, "excel-assistant", undefined);
    await seedOwn(a, "A's chat");
    await seedOwn(older, "the older app's chat");
    await forgetRecord("excel-assistant"); // it never wrote one
    await seedShared();

    const apps = await a.myDataApps();
    const deletion = await a.deleteMyData({ scope: "thisApp" });

    const other = apps.filter((x) => !x.isThisApp);
    expect(other.map((x) => [x.name, x.recorded])).toEqual([["excel-assistant", false]]);
    expect(deletion.otherApps).toEqual(["excel-assistant"]);
    expect((await older.listSessions()).length).toBe(1);
    for (const name of [...SHARED, db("fadenstack-keys")]) expect(await has(name), name).toBe(true);
  });

  it("an app whose record exists but whose agent is not named is inferred from the agent's data, never lost", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");
    const records = new IndexedDbAppRecords({ name: db("fadenstack-apps") });
    await records.remove(APP_B);
    records.close();

    const deletion = await a.deleteMyData();

    expect(deletion.otherApps).toEqual([AGENT_B]); // named by its agent
    expect((await b.listSessions()).length).toBe(1);
  });

  it("an agent another app also uses keeps its data when this app's data is removed", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");
    const records = new IndexedDbAppRecords({ name: db("fadenstack-apps") });
    await records.record(APP_B, AGENT_A, new Date().toISOString()); // B runs docs too
    records.close();

    const deletion = await a.deleteMyData({ scope: "thisApp" });

    expect(deletion.agentsKept).toEqual([AGENT_A]);
    expect((await a.listSessions()).length).toBe(1);
    expect((await a.listApprovals()).length).toBe(1);
    expect((await rows(db("fadenstack-apps"), "apps")).map((r) => r["app"])).toEqual([APP_B]); // A's record goes all the same

    // and the other way round: neither removes that agent's chats while the other's record lists it
    const again = await b.deleteMyData();
    expect(again.otherApps).toEqual([]);
    expect(await databases()).toEqual([]);
  });

  it("the data key goes only when nothing of another app remains", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    await seedOwn(a, "A's chat");
    await b.start();
    await b.approvalStore.add(AGENT_B, { tool: "read_page", toolClass: "read", approvedAt: "2026-11-16T10:00:00.000Z" }); // B keeps only "Allow always"

    await a.deleteMyData();
    expect(await has(db("fadenstack-keys"))).toBe(true); // B's approvals are sealed under it
    expect((await b.listApprovals()).length).toBe(1);

    await b.deleteMyData();
    expect(await has(db("fadenstack-keys"))).toBe(false);
  });

  it("Remove all takes every app's data and the list names the apps first", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    const older = await app(gw, "excel-assistant", undefined);
    await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");
    await seedOwn(older, "older chat");
    await forgetRecord("excel-assistant");
    await seedShared();

    const apps = await a.myDataApps();
    const deletion = await a.deleteMyData({ scope: "allApps" });

    expect(apps.map((x) => [x.name, x.isThisApp, x.recorded])).toEqual([[APP_A, true, true], [APP_B, false, true], ["excel-assistant", false, false]]);
    expect(apps[0]!.agents).toEqual([AGENT_A]);
    expect(apps[0]!.lastSeen).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(deletion).toMatchObject({ scope: "allApps", otherApps: [], sharedDataKept: false, agentsKept: [] });
    expect(await databases()).toEqual([]);
  });

  it("the export of this app holds exactly what its removal takes and says what stayed", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    const mine = await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");
    await seedShared();

    const data = await a.exportMyData({ scope: "thisApp" });

    expect(data.scope).toBe("thisApp");
    expect(data.app).toBe(APP_A);
    expect(data.otherApps).toEqual([APP_B]);
    expect(data.sessions.map((s) => [s.agent, s.id])).toEqual([[AGENT_A, mine]]);
    expect(data.approvals.map((x) => x.agent)).toEqual([AGENT_A]);
    expect(Object.keys(data.databases ?? {}).sort()).toEqual(["apps", "preferences"]);
    expect((data.databases!["apps"]!["apps"] as { app: string }[]).map((r) => r.app)).toEqual([APP_A]);
    expect((data.databases!["preferences"]!["reasoning"] as { agent: string }[]).map((r) => r.agent)).toEqual([AGENT_A]);
    expect(data.localStorage).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("B's chat");
    expect(JSON.stringify(data)).not.toContain("Short sentences");
    expect(data.notIncluded.join(" ")).toContain(APP_B);
  });

  it("the export of all apps holds every app's data and the shared data", async () => {
    const gw = gateway();
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");
    await seedShared();

    const data = await a.exportMyData({ scope: "allApps" });

    expect(data.scope).toBe("allApps");
    expect(data.sessions.map((s) => s.agent).sort()).toEqual([AGENT_B, AGENT_A]);
    expect(data.approvals.map((x) => x.agent).sort()).toEqual([AGENT_B, AGENT_A]);
    expect((data.databases!["apps"]!["apps"] as { app: string }[]).map((r) => r.app).sort()).toEqual([APP_B, APP_A]);
    expect(JSON.stringify(data.databases)).toContain("Short sentences");
    expect(JSON.stringify(data)).not.toContain("KEYMATERIAL");
  });

  it("the export of the only app holds all of it", async () => {
    const a = await app(gateway(), AGENT_A, APP_A);
    await seedOwn(a, "A's chat");
    await seedShared();

    const data = await a.exportMyData();

    expect(Object.keys(data.databases ?? {})).toContain("skills");
    expect(data.otherApps).toBeUndefined();
  });

  it("the record names the app and its agents and holds no content", async () => {
    const a = await app(gateway(), AGENT_A, APP_A);
    await a.start();

    const [record] = await rows(db("fadenstack-apps"), "apps");

    expect(record).toMatchObject({ app: APP_A, agents: [AGENT_A] });
    expect(Object.keys(record!).sort()).toEqual(["agents", "app", "firstSeen", "lastSeen"]);
  });

  it("an app that is not described is named by its agent", async () => {
    const a = await app(gateway(), AGENT_A, undefined);
    expect((await a.myDataApps())[0]).toMatchObject({ name: AGENT_A, isThisApp: true, recorded: true });
  });

  it("from a gateway that names no user, this app's removal takes this agent's data and leaves the shared databases and the other agent", async () => {
    const gw = new FakeGateway({ users, principal: false, model: () => ({ text: "Done." }), agents: [{ slug: AGENT_A }, { slug: AGENT_B }] });
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");

    const deletion = await a.deleteMyData();

    expect(deletion).toMatchObject({ scope: "thisApp", otherApps: [], agentsKept: [] });
    expect(await a.listSessions()).toEqual([]);
    expect((await b.listSessions()).length).toBe(1);
    expect(await has("fadenstack-keys")).toBe(true);
    expect((await rows("fadenstack-preferences", "reasoning")).map((r) => r["agent"])).toEqual([AGENT_B]);
    expect(await has("fadenstack-apps")).toBe(false); // no person, no record
  });

  it("from a gateway that names no user, this app's export holds exactly what its removal takes", async () => {
    const gw = new FakeGateway({ users, principal: false, model: () => ({ text: "Done." }), agents: [{ slug: AGENT_A }, { slug: AGENT_B }] });
    const a = await app(gw, AGENT_A, APP_A);
    const b = await app(gw, AGENT_B, APP_B);
    await seedOwn(a, "A's chat");
    await seedOwn(b, "B's chat");

    const data = await a.exportMyData();

    expect(data.scope).toBe("thisApp");
    expect(data.sessions.map((s) => s.agent)).toEqual([AGENT_A]);
    expect(data.approvals.map((x) => x.agent)).toEqual([AGENT_A]);
    expect(JSON.stringify(data)).not.toContain("B's chat");
    expect((data.databases?.["preferences"]?.["reasoning"] ?? []).map((r) => (r as { agent: string }).agent)).toEqual([AGENT_A]);
    expect(data.localStorage).toBeUndefined();
    expect(data.notIncluded.join(" ")).toContain("other agents' chats");
    expect(data.notIncluded.join(" ")).not.toContain("()");

    const all = await a.exportMyData({ scope: "allApps" });
    expect(all.sessions.map((s) => s.agent).sort()).toEqual([AGENT_B, AGENT_A]);
  });

  it("a governed person's removal leaves the standalone principal's data, and the other way round", async () => {
    const gw = gateway();
    const governed = await app(gw, AGENT_A, APP_A);
    await seedOwn(governed, "governed chat");
    const fake = new OpenAiFake();
    const local = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch })
      .useLocalProfile(AgentDefinition.fromJson({ slug: "local-assistant", name: "Local", version: { instructions: "Hi.", host_tool_contract: [], ui: {} } }))
      .describeApp({ name: "Local app" }).build();
    await seedOwn(local, "standalone chat");
    const standalone = userStoreName("fadenstack-sessions", STANDALONE_PRINCIPAL);

    await governed.deleteMyData({ scope: "allApps" });
    expect(await has(standalone)).toBe(true);
    expect(await has(db("fadenstack-sessions"))).toBe(false);

    const again = await app(gw, AGENT_A, APP_A);
    await seedOwn(again, "governed again");
    const result: DataDeletion = await local.deleteMyData();
    expect(result.scope).toBe("thisApp");
    expect(await has(standalone)).toBe(false);
    expect(await has(db("fadenstack-sessions"))).toBe(true);
  });
});
