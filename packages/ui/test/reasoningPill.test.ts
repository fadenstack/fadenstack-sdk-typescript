import { describe, expect, it } from "vitest";
import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemoryReasoningStore, MemorySessionStore, REASONING_LEVELS, type ReasoningLevel } from "@fadenstack/agents";
import {
  AgentChatViewModel, ApprovalBroker, MemoryClipboard, MemoryPreferenceStore, builtInStrings, immediateScheduler, type AgentChatOptions, type TurnLease,
} from "@fadenstack/ui";
import { FakeGateway, type FakeModel } from "@fadenstack/testing";

// The thinking pill's view model: the levels the profile offers, the pick, and what the next message carries (.NET ReasoningPillTests).

const says: FakeModel = () => ({ text: "Ok." });

async function chatWith(ui: Record<string, unknown> = {}, options: AgentChatOptions = {}, store = new MemoryReasoningStore()) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant", ui }], model: says });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .useReasoningStore(store).build();
  const chat = new AgentChatViewModel(agent, approvals, {
    scheduler: immediateScheduler, clipboard: new MemoryClipboard(), preferences: new MemoryPreferenceStore(), automaticLanguage: "en", ...options,
  });
  return { chat, agent, gateway, store };
}

const ui = (reasoning: unknown) => ({ reasoning });
const labels = (chat: AgentChatViewModel) => chat.reasoningOptions.map((o) => o.label);
const efforts = (gateway: FakeGateway) => gateway.modelCalls.map((c) => ("reasoning_effort" in c.body ? c.body["reasoning_effort"] : undefined));

describe("the thinking pill", () => {
  it("is empty until the agent started", async () => {
    const { chat } = await chatWith();
    expect([chat.reasoningOptions, chat.selectedReasoning, chat.reasoningPillText]).toEqual([[], undefined, ""]);
    expect(chat.reasoningAutomationName).toBe("How long it thinks");
    expect(chat.reasoningToolTip).toBe("How long it thinks");
    expect(chat.reasoningHint).toBe("");
  });

  it("without a setting offers five levels starting at auto, with the pill's texts", async () => {
    const { chat } = await chatWith();
    await chat.initialize();
    expect(labels(chat)).toEqual(["Auto", "Off", "Low", "Medium", "High"]);
    expect(chat.reasoningOptions.map((o) => o.level)).toEqual([...REASONING_LEVELS]);
    expect(chat.selectedReasoning!.level).toBe("auto");
    expect(chat.reasoningLevel).toBe("auto");
    expect(chat.reasoningPillText).toBe("Auto");
    expect(chat.reasoningAutomationName).toBe("Thinking: Auto");
    expect(chat.reasoningToolTip).toContain("How long it thinks");
    expect(chat.reasoningToolTip).toContain("Thinking: Auto");
    expect(chat.reasoningToolTip).toBe("How long it thinks\nThinking: Auto. The agent's own setting.");
    expect(chat.reasoningHint).toBe("The agent's own setting.");
    for (const option of chat.reasoningOptions) expect(option.description.trim()).not.toBe("");
  });

  it("a maximum hides the levels above it; auto and off stay", async () => {
    const { chat } = await chatWith(ui({ max: "low" }));
    await chat.initialize();
    expect(labels(chat)).toEqual(["Auto", "Off", "Low"]);
  });

  it("the old levels and default of a profile change nothing", async () => {
    const { chat } = await chatWith(ui({ default: "none", levels: ["none", "high"] }));
    await chat.initialize();
    expect(chat.reasoningOptions).toHaveLength(5);
    expect(chat.reasoningPillText).toBe("Auto");
  });

  it("a stored pick above the maximum shows the maximum", async () => {
    const store = new MemoryReasoningStore();
    await store.set("page", "high"); // as left by an earlier run with no maximum
    const { chat } = await chatWith(ui({ max: "low" }), {}, store);
    await chat.initialize();
    expect(chat.reasoningPillText).toBe("Low");
    expect(chat.reasoningOptions.filter((o) => o.selected).map((o) => o.level)).toEqual(["low"]);
  });

  it("marks exactly the current level in the menu, and moves the mark with the pick", async () => {
    const { chat } = await chatWith();
    await chat.initialize();
    expect(chat.reasoningOptions.filter((o) => o.selected).map((o) => o.level)).toEqual(["auto"]);
    await chat.selectReasoning("medium");
    expect(chat.reasoningOptions.filter((o) => o.selected).map((o) => o.level)).toEqual(["medium"]);
    expect(chat.selectedReasoning).toMatchObject({ level: "medium", label: "Medium", selected: true });
  });

  it("the pick is kept for the agent and the next message carries it", async () => {
    const { chat, agent, gateway } = await chatWith();
    await chat.initialize();
    await chat.send("First");
    chat.setReasoningMenuOpen(true);
    await chat.selectReasoning("low");
    expect(chat.isReasoningMenuOpen).toBe(false);
    expect(agent.reasoningChoice).toBe("low");
    await chat.send("Second");
    expect(efforts(gateway)).toEqual([undefined, "low"]);
  });

  it("a pick above the maximum is not taken", async () => {
    const { chat, agent } = await chatWith(ui({ max: "low" }));
    await chat.initialize();
    chat.setReasoningMenuOpen(true);
    await chat.selectReasoning("high");
    expect(chat.isReasoningMenuOpen).toBe(false);
    expect(agent.reasoningChoice).toBeUndefined();
    expect([chat.reasoningLevel, chat.reasoningPillText]).toEqual(["auto", "Auto"]);
  });

  it("a new chat starts from the pick", async () => {
    const { chat, gateway } = await chatWith();
    await chat.initialize();
    await chat.selectReasoning("high");
    await chat.send("First");
    chat.newChat();
    expect(chat.selectedReasoning!.level).toBe("high");
    await chat.send("Second");
    expect(efforts(gateway)).toEqual(["high", "high"]);
  });

  it("a pick made in a chat applies to that chat's next message, not the one running", async () => {
    const { chat, gateway } = await chatWith();
    await chat.initialize();
    await chat.send("First");
    await chat.selectReasoning("off");
    expect(chat.reasoningLevel).toBe("off");
    await chat.send("Second");
    expect(efforts(gateway)).toEqual([undefined, "none"]);
  });

  it("the menu closes with About, and opens and closes on request", async () => {
    const { chat } = await chatWith();
    await chat.initialize();
    chat.setReasoningMenuOpen(true);
    expect(chat.isReasoningMenuOpen).toBe(true);
    chat.setReasoningMenuOpen(false);
    expect(chat.isReasoningMenuOpen).toBe(false);
    chat.setReasoningMenuOpen(true);
    chat.setAboutOpen(true);
    expect(chat.isReasoningMenuOpen).toBe(false);
  });

  it("the texts follow the panel's language", async () => {
    const { chat } = await chatWith();
    await chat.initialize();
    await chat.setLanguage("de");
    expect(chat.reasoningPillText).toBe("Auto");
    expect(chat.reasoningAutomationName).toBe("Nachdenken: Auto");
    await chat.selectReasoning("low");
    expect(chat.reasoningPillText).toBe("Niedrig");
    expect(chat.reasoningOptions.find((o) => o.level === "low")!.label).toBe("Niedrig");
  });

  it.each(Object.keys(builtInStrings))("every level has a label and a line in %s, and the pill and menu are said", (tag) => {
    const strings = builtInStrings[tag]!;
    for (const level of REASONING_LEVELS as readonly ReasoningLevel[]) {
      expect(strings.reasoningLabel[level].trim()).not.toBe("");
      expect(strings.reasoningDescription[level].trim()).not.toBe("");
    }
    expect(strings.reasoningPill("x")).toContain("x");
    expect(strings.reasoningPill("x")).not.toBe("x");
    expect(strings.reasoningMenu.trim()).not.toBe("");
    expect(strings.reasoningMenu === "How long it thinks").toBe(tag === "en");
  });
});

describe("waiting for a free slot", () => {
  const WORDS: Record<string, string> = {
    en: "Waiting for a free slot", de: "Wartet auf einen freien Platz", es: "Esperando un hueco libre",
    fr: "En attente d’une place libre", "zh-Hans": "等待空闲名额",
  };

  it.each(Object.entries(WORDS))("the turn says so in %s while the gate holds it, and no longer after", async (tag, words) => {
    let release!: (lease: TurnLease) => void;
    let entered = false;
    const { chat } = await chatWith({}, { automaticLanguage: tag, turnGate: () => { entered = true; return new Promise<TurnLease>((r) => { release = r; }); } });
    await chat.initialize();
    const sending = chat.send("Go.");
    for (let i = 0; i < 500 && !entered; i++) await new Promise((r) => setTimeout(r, 2));
    expect(chat.isWaitingForSlot).toBe(true);
    expect(chat.turns[0]!.statusText).toBe(words);
    expect(chat.strings.waitingForSlot).toBe(words);
    release(() => undefined);
    await sending;
    expect(chat.turns[0]!.statusText).toBe("");
  });

  it("is not said for a turn that is not held, which says it works", async () => {
    const { chat } = await chatWith();
    await chat.initialize();
    const sending = chat.send("Go.");
    expect(chat.turns[0]!.statusText).not.toBe("Waiting for a free slot");
    await sending;
  });

  it("goes when Stop cancels the wait", async () => {
    let entered = false;
    const { chat } = await chatWith({}, { turnGate: (signal) => { entered = true; return new Promise<TurnLease>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); } });
    await chat.initialize();
    const sending = chat.send("Go.");
    for (let i = 0; i < 500 && !entered; i++) await new Promise((r) => setTimeout(r, 2));
    expect(chat.turns[0]!.statusText).toBe("Waiting for a free slot");
    chat.stop();
    await sending;
    expect([chat.isWaitingForSlot, chat.turns[0]!.state, chat.turns[0]!.statusText]).toEqual([false, "stopped", "Stopped"]);
  });
});
