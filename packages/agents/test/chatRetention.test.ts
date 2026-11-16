import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EndpointDialect, FadenstackClient, loginWithPassword } from "@fadenstack/client";
import {
  AgentDefinition, EntryTypes, FadenstackAgent, IndexedDbChatRetentionStore, IndexedDbSessionStore, MachinePolicy,
  STANDALONE_PRINCIPAL, chatRetentionChoice, userStoreName,
} from "@fadenstack/agents";
import { FakeGateway, OpenAiFake } from "@fadenstack/testing";

// How long old chats are kept (.NET ChatRetentionTests): the person's choice in standalone, the server's in governed mode, the machine
// policy over both. The stores are the SDK's own, in the (fake) IndexedDB of the browser profile.

const DEFINITION = {
  slug: "docs-assistant", name: "Docs assistant",
  version: { instructions: "You are the docs assistant.", host_tool_contract: [], ui: {} },
};
const SLUG = "docs-assistant";
const DAY = 86_400_000;

const GOVERNED = { tenantId: "tenant-1", userId: "user-1" };

describe("chat retention", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function standalone(policy?: MachinePolicy, configure = (b: ReturnType<typeof FadenstackAgent.createBuilder>) => b): FadenstackAgent {
    const fake = new OpenAiFake();
    const builder = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch })
      .useLocalProfile(AgentDefinition.fromJson(DEFINITION));
    if (policy) builder.useMachinePolicy(policy);
    return configure(builder).build();
  }

  const users = [{ email: "anna@example.com", password: "secret" }];
  async function governed(localRetention?: unknown, configure = (b: ReturnType<typeof FadenstackAgent.createBuilder>) => b): Promise<FadenstackAgent> {
    const gateway = new FakeGateway({ users, principal: true, model: () => ({ text: "Hello." }), agents: [{ slug: "docs", ...(localRetention === undefined ? {} : { localRetention }) }] });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "anna@example.com", password: "secret", fetch: gateway.fetch }));
    return configure(FadenstackAgent.createBuilder().useClient(client)).build();
  }

  /** Saves `count` chats of `agent` in the person's own sessions database; chat i is `ageDays + i` minutes old... newest first. Returns the ids. */
  async function seed(principal: { tenantId: string; userId: string }, agent: string, count: number, ageMs: number, stepMs = 60_000): Promise<string[]> {
    const store = new IndexedDbSessionStore({ name: userStoreName("fadenstack-sessions", principal), retention: { maxSessions: 100_000, maxAgeDays: 100_000 } });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `c${String(i).padStart(3, "0")}`;
      await store.append(agent, id, {
        id: `e-${id}`, parentId: null, timestamp: new Date(Date.now() - ageMs - i * stepMs).toISOString(), type: EntryTypes.sessionStart, turnId: null, status: null, data: {},
      });
      ids.push(id);
    }
    store.close();
    return ids;
  }

  const preferences = (principal: { tenantId: string; userId: string }) => userStoreName("fadenstack-preferences", principal);
  const kept = async (agent: FadenstackAgent) => (await agent.listSessions()).map((s) => s.id).sort();

  // -- standalone: the person chooses -------------------------------------------------------------------------

  it("defaults to on, 90 days, 50 chats, or the app's limits", async () => {
    const agent = standalone();
    await agent.start();
    expect(agent.chatRetention).toEqual({ control: "person", autoDelete: true, maxAgeDays: 90, maxSessions: 50, organisationSetsLimit: false, canChange: true });
    const app = standalone(undefined, (b) => b.useSessionRetention({ maxSessions: 20, maxAgeDays: 30 }));
    await app.start();
    expect([app.chatRetention.autoDelete, app.chatRetention.maxAgeDays, app.chatRetention.maxSessions]).toEqual([true, 30, 20]);
    await agent.dispose();
    await app.dispose();
  });

  it("prunes at start: the newest 50, none older than 90 days", async () => {
    await seed(STANDALONE_PRINCIPAL, SLUG, 60, 3_600_000);
    await seed(STANDALONE_PRINCIPAL, "old-agent-chat", 0, 0);
    const agent = standalone();
    await agent.start();
    const ids = await kept(agent);
    expect(ids).toHaveLength(50);
    expect(ids).toContain("c049");
    expect(ids).not.toContain("c050");
    await agent.dispose();
  });

  it("lets an idle profile age out at start", async () => {
    await seed(STANDALONE_PRINCIPAL, SLUG, 3, 120 * DAY);
    const agent = standalone();
    await agent.start();
    expect(await kept(agent)).toEqual([]);
    await agent.dispose();
  });

  it("off keeps everything, at start and when a chat is created", async () => {
    await new IndexedDbChatRetentionStore({ name: preferences(STANDALONE_PRINCIPAL) }).set(chatRetentionChoice({ autoDelete: false, maxAgeDays: 30, maxSessions: 5 }));
    await seed(STANDALONE_PRINCIPAL, SLUG, 12, 200 * DAY);
    const agent = standalone();
    await agent.start();
    expect(agent.chatRetention.autoDelete).toBe(false);
    expect(await kept(agent)).toHaveLength(12);
    await (await agent.startSession()).send("Hi").catch(() => undefined);
    await agent.startSession();
    expect((await agent.listSessions()).length).toBeGreaterThanOrEqual(12);
    expect(await kept(agent)).toEqual(expect.arrayContaining(["c000", "c011"]));
    await agent.dispose();
  });

  it("keeps the person's change, per person, and a new agent reads it", async () => {
    const first = standalone();
    const state = await first.setChatRetention({ autoDelete: false, maxAgeDays: 7, maxSessions: 9 });
    expect(state).toMatchObject({ control: "person", autoDelete: false, maxAgeDays: 7, maxSessions: 9 });
    await first.dispose();
    expect((await indexedDB.databases()).map((d) => d.name)).toContain(preferences(STANDALONE_PRINCIPAL));

    const second = standalone();
    await second.start();
    expect([second.chatRetention.autoDelete, second.chatRetention.maxAgeDays, second.chatRetention.maxSessions]).toEqual([false, 7, 9]);
    await second.dispose();

    // A governed person's database is another one: nothing of it is there.
    expect(await new IndexedDbChatRetentionStore({ name: preferences(GOVERNED) }).get()).toBeUndefined();
  });

  it("the thinking level and the retention share the preferences database without disturbing each other", async () => {
    const agent = standalone();
    await agent.setChatRetention({ autoDelete: true, maxAgeDays: 10, maxSessions: 10 });
    await agent.setReasoning("low");
    await agent.dispose();
    const again = standalone();
    await again.start();
    expect([again.reasoningChoice, again.chatRetention.maxAgeDays]).toEqual(["low", 10]);
    await again.dispose();
  });

  it("an earlier database (version 1, thinking level only) gets the new store", async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(preferences(STANDALONE_PRINCIPAL), 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("reasoning", { keyPath: "agent" }).put({ agent: SLUG, level: "high" });
      };
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });
    const agent = standalone();
    await agent.setChatRetention({ autoDelete: false, maxAgeDays: 5, maxSessions: 5 });
    await agent.dispose();
    const again = standalone();
    await again.start();
    expect([again.reasoningChoice, again.chatRetention.autoDelete]).toEqual(["high", false]);
    await again.dispose();
  });

  it("turning it on prunes at once", async () => {
    await new IndexedDbChatRetentionStore({ name: preferences(STANDALONE_PRINCIPAL) }).set(chatRetentionChoice({ autoDelete: false }));
    await seed(STANDALONE_PRINCIPAL, SLUG, 10, 3_600_000);
    const agent = standalone();
    await agent.start();
    expect(await kept(agent)).toHaveLength(10);
    await agent.setChatRetention({ autoDelete: true, maxAgeDays: 90, maxSessions: 4 });
    expect(await kept(agent)).toEqual(["c000", "c001", "c002", "c003"]);
    await agent.dispose();
  });

  it("lowering a limit prunes at once", async () => {
    await seed(STANDALONE_PRINCIPAL, SLUG, 6, 10 * DAY);
    const agent = standalone();
    await agent.start();
    expect(await kept(agent)).toHaveLength(6);
    await agent.setChatRetention({ autoDelete: true, maxAgeDays: 5, maxSessions: 50 });
    expect(await kept(agent)).toEqual([]);
    await agent.dispose();
  });

  it("never deletes the chat that is open", async () => {
    await new IndexedDbChatRetentionStore({ name: preferences(STANDALONE_PRINCIPAL) }).set(chatRetentionChoice({ autoDelete: false }));
    const ids = await seed(STANDALONE_PRINCIPAL, SLUG, 5, 200 * DAY);
    const agent = standalone();
    await agent.start();
    const open = await agent.openSession(ids[2]!);
    await agent.setChatRetention({ autoDelete: true, maxAgeDays: 30, maxSessions: 1 });
    expect(await kept(agent)).toEqual([open.id]);
    await agent.dispose();
  });

  it("counts a new chat among the chats kept", async () => {
    await new IndexedDbChatRetentionStore({ name: preferences(STANDALONE_PRINCIPAL) }).set(chatRetentionChoice({ maxSessions: 3 }));
    await seed(STANDALONE_PRINCIPAL, SLUG, 3, 3_600_000);
    const agent = standalone();
    await agent.start();
    const created = await agent.startSession();
    const ids = await kept(agent);
    expect(ids).toHaveLength(3);
    expect(ids).toContain(created.id);
    await agent.dispose();
  });

  it.each<[number, number]>([[0, 50], [3651, 50], [90, 0], [90, 10_001], [1.5, 50], [90, 2.5], [Number.NaN, 50]])("refuses the limits %s days, %s chats", async (maxAgeDays, maxSessions) => {
    expect(() => chatRetentionChoice({ maxAgeDays, maxSessions })).toThrow(RangeError);
    const agent = standalone();
    await expect(agent.setChatRetention({ autoDelete: false, maxAgeDays, maxSessions })).rejects.toThrow(RangeError);
    await agent.dispose();
  });

  it("allows the bounds themselves", () => {
    expect(chatRetentionChoice({ maxAgeDays: 1, maxSessions: 1 })).toEqual({ autoDelete: true, maxAgeDays: 1, maxSessions: 1 });
    expect(chatRetentionChoice({ maxAgeDays: 3650, maxSessions: 10_000 }).maxSessions).toBe(10_000);
  });

  it.each<unknown>([
    { id: "chat", autoDelete: false, maxAgeDays: 0, maxSessions: 5 },
    { id: "chat", autoDelete: false, maxAgeDays: 10, maxSessions: 99_999 },
    { id: "chat", autoDelete: "no", maxAgeDays: 10, maxSessions: 5 },
    { id: "chat", autoDelete: false },
  ])("a damaged stored choice counts as none: %j", async (row) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(preferences(STANDALONE_PRINCIPAL), 2);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("reasoning", { keyPath: "agent" });
        open.result.createObjectStore("retention", { keyPath: "id" }).put(row);
      };
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });
    const agent = standalone();
    await agent.start();
    expect(agent.chatRetention).toMatchObject({ control: "person", autoDelete: true, maxAgeDays: 90, maxSessions: 50 });
    await agent.dispose();
  });

  // -- governed: the server decides ---------------------------------------------------------------------------

  it("governed ignores the person's choice and follows the stricter server limit", async () => {
    await new IndexedDbChatRetentionStore({ name: preferences(GOVERNED) }).set(chatRetentionChoice({ autoDelete: false, maxAgeDays: 3650, maxSessions: 10_000 }));
    await seed(GOVERNED, "docs", 8, 3_600_000);
    const agent = await governed({ max_sessions: 3 });
    await agent.start();
    expect(agent.chatRetention).toEqual({ control: "organisation", autoDelete: true, maxAgeDays: 90, maxSessions: 3, organisationSetsLimit: true, canChange: false });
    expect(await kept(agent)).toHaveLength(3);
    const after = await agent.setChatRetention({ autoDelete: false, maxAgeDays: 1, maxSessions: 1 });
    expect(after).toEqual(agent.chatRetention);
    expect(await new IndexedDbChatRetentionStore({ name: preferences(GOVERNED) }).get()).toMatchObject({ autoDelete: false, maxAgeDays: 3650 }); // untouched
    expect(await kept(agent)).toHaveLength(3);
    await agent.dispose();
  });

  it("governed takes the app's limit when it is stricter, and says when the server sets none", async () => {
    const plain = await governed(undefined, (b) => b.useSessionRetention({ maxSessions: 10, maxAgeDays: 20 }));
    await plain.start();
    expect(plain.chatRetention).toMatchObject({ control: "organisation", maxAgeDays: 20, maxSessions: 10, organisationSetsLimit: false });
    const stricter = await governed({ max_sessions: 50, max_age_days: 7 }, (b) => b.useSessionRetention({ maxSessions: 10, maxAgeDays: 20 }));
    await stricter.start();
    expect([stricter.chatRetention.maxAgeDays, stricter.chatRetention.maxSessions]).toEqual([7, 10]);
    await plain.dispose();
    await stricter.dispose();
  });

  // -- the machine policy ------------------------------------------------------------------------------------

  const fixed = (json: string) => MachinePolicy.fromJson(`{"chatRetention":${json}}`);

  it("the machine policy fixes it, and the person's choice cannot change it", async () => {
    await new IndexedDbChatRetentionStore({ name: preferences(STANDALONE_PRINCIPAL) }).set(chatRetentionChoice({ autoDelete: false }));
    await seed(STANDALONE_PRINCIPAL, SLUG, 6, 3_600_000);
    const agent = standalone(fixed(`{"autoDelete":true,"maxAgeDays":30,"maxSessions":4}`));
    await agent.start();
    expect(agent.chatRetention).toMatchObject({ control: "machinePolicy", autoDelete: true, maxAgeDays: 30, maxSessions: 4, canChange: false });
    expect(await kept(agent)).toHaveLength(4);
    await agent.setChatRetention({ autoDelete: true, maxAgeDays: 90, maxSessions: 50 });
    expect(agent.chatRetention.maxSessions).toBe(4);
    expect(await new IndexedDbChatRetentionStore({ name: preferences(STANDALONE_PRINCIPAL) }).get()).toMatchObject({ autoDelete: false });
    await agent.dispose();
  });

  it("the machine policy can turn pruning off", async () => {
    await seed(STANDALONE_PRINCIPAL, SLUG, 6, 400 * DAY);
    const agent = standalone(fixed(`{"autoDelete":false}`));
    await agent.start();
    expect(await kept(agent)).toHaveLength(6);
    await agent.dispose();
  });

  it("reads the entry with defaults, and warns about what it does not understand without echoing the value", () => {
    const full = fixed(`{"autoDelete":true,"maxAgeDays":30,"maxSessions":100}`);
    expect(full.chatRetention).toEqual({ autoDelete: true, maxAgeDays: 30, maxSessions: 100 });
    expect(full.warnings).toEqual([]);
    expect(full.locked).toContain("chatRetention");
    expect(MachinePolicy.none.chatRetention).toBeUndefined();
    expect(fixed("{}").chatRetention).toEqual({ autoDelete: true, maxAgeDays: 90, maxSessions: 50 });
    const bad = fixed(`{"autoDelete":"yes","maxAgeDays":0,"maxSessions":2.5,"colour":1}`);
    expect(bad.chatRetention).toEqual({ autoDelete: true, maxAgeDays: 90, maxSessions: 50 });
    expect(bad.warnings).toHaveLength(4);
    expect(bad.warnings.join(" ")).not.toContain("yes");
    const notObject = fixed(`"30"`);
    expect(notObject.chatRetention).toEqual({ autoDelete: true, maxAgeDays: 90, maxSessions: 50 });
    expect(notObject.warnings).toHaveLength(1);
  });

  it("a governed agent follows its server, not the policy", async () => {
    const agent = await governed({ max_sessions: 7 }, (b) => b.useMachinePolicy(fixed(`{"autoDelete":false}`)));
    await agent.start();
    expect(agent.chatRetention).toMatchObject({ control: "organisation", maxSessions: 7 });
    await agent.dispose();
  });

  // -- the person's data --------------------------------------------------------------------------------------

  it("the export includes the choice and the deletion removes it", async () => {
    const agent = standalone();
    await agent.setChatRetention({ autoDelete: true, maxAgeDays: 14, maxSessions: 20 });
    const data = await agent.exportMyData();
    expect(data.databases?.["preferences"]?.["retention"]).toEqual([{ id: "chat", autoDelete: true, maxAgeDays: 14, maxSessions: 20 }]);

    await agent.deleteMyData();
    expect(agent.chatRetention).toMatchObject({ autoDelete: true, maxAgeDays: 90, maxSessions: 50 });
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(preferences(STANDALONE_PRINCIPAL));
    await agent.dispose();
  });
});



