import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FadenstackClient, loginWithPassword, type ReasoningEffort } from "@fadenstack/client";
import {
  FadenstackAgent, MemoryReasoningStore, MemorySessionStore, REASONING_LEVELS, ReasoningChoices, EntryTypes,
  parseReasoningLevel, reasoningEffort, reasoningWire, type ReasoningLevel,
} from "@fadenstack/agents";
import { FakeGateway, type FakeGatewayOptions } from "@fadenstack/testing";

// The thinking ladder (.NET ReasoningTests): the levels, the server's cap, the person's pick per person and agent.

const ui = (reasoning: unknown) => ({ ui: { reasoning } });

describe("the levels a profile offers", () => {
  it("offers all five and no maximum without a setting", () => {
    expect(ReasoningChoices.fromUi({}).levels).toEqual(["auto", "off", "low", "medium", "high"]);
    expect(ReasoningChoices.fromUi({}).max).toBeUndefined();
    expect(REASONING_LEVELS).toEqual(ReasoningChoices.everything.levels);
  });

  it.each<[string, ReasoningLevel[], ReasoningEffort | undefined]>([
    ["none", ["auto", "off"], "none"],
    ["minimal", ["auto", "off"], "none"], // the gateway's step between none and low caps at none
    ["low", ["auto", "off", "low"], "low"],
    ["medium", ["auto", "off", "low", "medium"], "medium"],
    ["high", ["auto", "off", "low", "medium", "high"], "high"],
    ["xhigh", ["auto", "off", "low", "medium", "high"], "xhigh"],
    ["LOW", ["auto", "off", "low"], "low"],
  ])("a maximum of %s hides the levels above it, and off stays", (max, expected, cap) => {
    const choices = ReasoningChoices.fromUi({ reasoning: { max } });
    expect(choices.levels).toEqual(expected);
    expect(choices.max).toBe(cap);
  });

  it("the top of the gateway's scale sets no cap", () => {
    const choices = ReasoningChoices.fromUi({ reasoning: { max: "max" } });
    expect([choices.levels.length, choices.max]).toEqual([5, undefined]);
  });

  it.each<unknown>([undefined, null, "low", 7, [], { reasoning: 3 }, { reasoning: {} }, { reasoning: { max: 3 } }, { reasoning: { max: "" } },
    { reasoning: { max: "bogus" } }, { reasoning: { max: null } }, { reasoning: [] }])("ignores what it cannot read: %j", (value) => {
    const choices = ReasoningChoices.fromUi(value);
    expect([choices.levels.length, choices.max]).toEqual([5, undefined]);
  });

  it("names the levels on the wire and parses them back, off as none", () => {
    expect(REASONING_LEVELS.map(reasoningWire)).toEqual(["auto", "none", "low", "medium", "high"]);
    expect(["auto", "none", "off", "OFF", " High ", "bogus", 3, undefined].map(parseReasoningLevel))
      .toEqual(["auto", "off", "off", "off", "high", undefined, undefined, undefined]);
    expect(REASONING_LEVELS.map(reasoningEffort)).toEqual([undefined, "none", "low", "medium", "high"]);
  });
});

describe("the agent's level", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const users = [{ email: "anna@example.com", password: "secret" }, { email: "ben@example.com", password: "secret" }];

  async function agentFor(gateway: FakeGateway, email = "anna@example.com", configure = (b: ReturnType<typeof FadenstackAgent.createBuilder>) => b) {
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email, password: "secret", fetch: gateway.fetch }));
    return configure(FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore())).build();
  }
  const gatewayWith = (agent: Record<string, unknown> = {}, options: FakeGatewayOptions = {}) =>
    new FakeGateway({ users, principal: true, agents: [{ slug: "docs", ...agent }], model: () => ({ text: "Hello." }), ...options });
  const efforts = (gateway: FakeGateway) => gateway.modelCalls.map((c) => c.body["reasoning_effort"]);

  it("is auto with nothing set, and the app's setting beats auto", async () => {
    const plain = await agentFor(gatewayWith());
    await plain.start();
    expect([plain.reasoning, plain.reasoningChoice]).toEqual(["auto", undefined]);
    const app = await agentFor(gatewayWith(), "anna@example.com", (b) => b.useReasoning("medium"));
    await app.start();
    expect(app.reasoning).toBe("medium");
  });

  it("the person's pick beats the app's setting, and forgetting it goes back", async () => {
    const agent = await agentFor(gatewayWith(), "anna@example.com", (b) => b.useReasoning("high"));
    expect(await agent.setReasoning("low")).toBe("low");
    expect(agent.reasoningChoice).toBe("low");
    expect(await agent.setReasoning("auto")).toBe("auto");
    expect(await agent.setReasoning(undefined)).toBe("high");
    await agent.dispose();
  });

  it("does not take a pick above the maximum", async () => {
    const agent = await agentFor(gatewayWith(ui({ max: "low" })));
    expect(await agent.setReasoning("high")).toBe("auto");
    expect(agent.reasoningChoice).toBeUndefined();
    await agent.dispose();
  });

  it("lowers the app's setting to the maximum, and auto means the maximum", async () => {
    const gateway = gatewayWith(ui({ max: "medium" }));
    const app = await agentFor(gateway, "anna@example.com", (b) => b.useReasoning("high"));
    await app.start();
    expect(app.reasoning).toBe("medium");
    const auto = await agentFor(gateway);
    const session = await auto.startSession();
    expect(session.reasoning).toBe("auto");
    await session.send("Hi");
    expect(efforts(gateway)).toEqual(["medium"]);
  });

  it("a session set to auto itself sends the maximum, and a level above it the maximum too", async () => {
    const gateway = gatewayWith(ui({ max: "medium" }));
    const agent = await agentFor(gateway);
    const session = await agent.startSession();
    session.reasoning = "auto";
    await session.send("One");
    session.reasoning = "high";
    expect(session.reasoning).toBe("medium"); // above the maximum: shows it
    await session.send("Two");
    expect(efforts(gateway)).toEqual(["medium", "medium"]);
  });

  it("shows and sends the maximum for a stored pick above a lowered maximum, which is kept as it was picked", async () => {
    const first = await agentFor(gatewayWith());
    await first.setReasoning("high");
    await first.dispose();
    const gateway = gatewayWith(ui({ max: "low" }));
    const later = await agentFor(gateway);
    await later.start();
    expect([later.reasoningChoice, later.reasoning]).toEqual(["high", "low"]);
    const session = await later.startSession();
    expect(session.reasoning).toBe("low");
    await session.send("Hi");
    expect(efforts(gateway)).toEqual(["low"]);
  });

  it("off always goes out as none, even with a maximum", async () => {
    const gateway = gatewayWith(ui({ max: "low" }));
    const agent = await agentFor(gateway);
    await agent.setReasoning("off");
    await (await agent.startSession()).send("Hi");
    expect(efforts(gateway)).toEqual(["none"]);
  });

  it("auto sends no field", async () => {
    const gateway = gatewayWith();
    const agent = await agentFor(gateway);
    await (await agent.startSession()).send("Hi");
    expect("reasoning_effort" in gateway.modelCalls[0]!.body).toBe(false);
  });

  it.each<[ReasoningLevel, string]>([["off", "none"], ["low", "low"], ["medium", "medium"], ["high", "high"]])("%s goes out as %s", async (level, wire) => {
    const gateway = gatewayWith();
    const agent = await agentFor(gateway);
    const session = await agent.startSession();
    session.reasoning = level;
    await session.send("Hi");
    expect(efforts(gateway)).toEqual([wire]);
  });

  it("the app's extra high goes out as it was set", async () => {
    const gateway = gatewayWith();
    const agent = await agentFor(gateway, "anna@example.com", (b) => b.useReasoning("xhigh"));
    await (await agent.startSession()).send("Hi");
    expect(efforts(gateway)).toEqual(["xhigh"]);
  });

  it("a new session starts from the pick, and a change applies from the next message", async () => {
    const gateway = gatewayWith();
    const agent = await agentFor(gateway);
    await agent.setReasoning("high");
    const session = await agent.startSession();
    expect(session.reasoning).toBe("high");
    await session.send("First");
    await agent.setReasoning("off");
    session.reasoning = "off";
    await session.send("Second");
    expect(efforts(gateway)).toEqual(["high", "none"]);
  });

  it("a session that follows the agent picks up a change at its next message", async () => {
    const gateway = gatewayWith();
    const agent = await agentFor(gateway);
    const session = await agent.startSession();
    await session.send("First");
    await agent.setReasoning("low");
    await session.send("Second");
    expect(efforts(gateway)).toEqual([undefined, "low"]);
  });

  it("the turn start entry records the effort, and no client event carries it", async () => {
    const gateway = gatewayWith();
    const agent = await agentFor(gateway);
    const session = await agent.startSession();
    session.reasoning = "medium";
    await session.send("Hi");
    await agent.flush();
    expect(session.transcript.find((e) => e.type === EntryTypes.turnStart)!.data["reasoning_effort"]).toBe("medium");
    expect(JSON.stringify(gateway.reported)).not.toContain("reasoning");
  });

  it("the pick survives a new agent instance, in the person's own database", async () => {
    const gateway = gatewayWith();
    const first = await agentFor(gateway);
    await first.setReasoning("high");
    await first.dispose();
    expect((await indexedDB.databases()).map((d) => d.name)).toContain("fadenstack-preferences:tenant-1:user-1");
    const second = await agentFor(gateway);
    await second.start();
    expect(second.reasoningChoice).toBe("high");
    expect((await second.startSession()).reasoning).toBe("high");
  });

  it("another person on the device does not get it", async () => {
    const gateway = gatewayWith();
    const anna = await agentFor(gateway, "anna@example.com");
    await anna.setReasoning("high");
    await anna.dispose();
    const ben = await agentFor(gateway, "ben@example.com");
    await ben.start();
    expect(ben.reasoningChoice).toBeUndefined();
  });

  it("each agent keeps its own pick", async () => {
    const two = new FakeGateway({ users, principal: true, agents: [{ slug: "docs" }, { slug: "mail" }], model: () => ({ text: "Hello." }) });
    const docs = await agentFor(two);
    await docs.setReasoning("low");
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: two.serverUrl, agent: "mail", fetch: two.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: two.serverUrl, email: "anna@example.com", password: "secret", fetch: two.fetch }));
    const mail = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).build();
    await mail.start();
    expect(mail.reasoningChoice).toBeUndefined();
    await mail.setReasoning("high");
    await docs.dispose();
    const again = await agentFor(two);
    await again.start();
    expect(again.reasoningChoice).toBe("low");
  });

  it("a damaged row means no pick", async () => {
    const gateway = gatewayWith();
    const first = await agentFor(gateway);
    await first.setReasoning("high");
    await first.dispose();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("fadenstack-preferences:tenant-1:user-1", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["reasoning"], "readwrite");
      tx.objectStore("reasoning").put({ agent: "docs", level: "loud" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const second = await agentFor(gateway);
    await second.start();
    expect(second.reasoningChoice).toBeUndefined();
  });

  it("a host that keeps both stores itself keeps the pick for the run only; its own reasoning store is used", async () => {
    const gateway = gatewayWith();
    const store = new MemoryReasoningStore();
    const agent = await agentFor(gateway, "anna@example.com", (b) => b.useReasoningStore(store));
    await agent.setReasoning("medium");
    expect(await store.get("docs")).toBe("medium");
    const other = await agentFor(gateway, "anna@example.com", (b) => b.useSessionStore(new MemorySessionStore())
      .useApprovalStore({ list: async () => [], add: async () => undefined, remove: async () => undefined }));
    await other.setReasoning("low");
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain("fadenstack-preferences:tenant-1:user-1");
  });
});
