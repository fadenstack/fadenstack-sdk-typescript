import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import {
  AgentChatViewModel,
  ApprovalBroker,
  ApprovalPart,
  AttachmentViewModel,
  MarkdownPart,
  MemoryClipboard,
  NoticePart,
  RenderBatcher,
  ToolCallPart,
  immediateScheduler,
  type AgentChatOptions,
  type OutgoingMessage,
  type UiScheduler,
} from "@fadenstack/ui";
import { FakeGateway, lastToolResults, type FakeGatewayOptions } from "@fadenstack/testing";

/** The value once `find` returns one (polled; the agent runs on its own). */
async function waitFor<T>(find: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function chat(options: FakeGatewayOptions = {}, chatOptions: AgentChatOptions = {}) {
  const gateway = new FakeGateway({
    agents: [{
      slug: "page", name: "Page assistant", ui: { greeting: "I read pages.", suggestions: ["Summarise", 7, "Explain"] },
      contract: [{ name: "read_page", risk: "read" }, { name: "fill_field", risk: "write" }],
    }],
    ...options,
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const written: string[] = [];
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder()
    .useClient(client)
    .useSessionStore(new MemorySessionStore())
    .useApprovals(approvals)
    .addTools(
      defineTool({ name: "read_page", toolClass: "read", run: () => "The page text." }),
      defineTool<{ text: string }>({
        name: "fill_field", toolClass: "write",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        run: ({ text }) => {
          written.push(text);
          return "filled";
        },
      }),
    )
    .build();
  const clipboard = new MemoryClipboard();
  const vm = new AgentChatViewModel(agent, approvals, { scheduler: immediateScheduler, clipboard, ...chatOptions });
  await vm.initialize();
  return { gateway, vm, written, clipboard, agent };
}

describe("AgentChatViewModel", () => {
  it("starts with the agent's name, greeting and suggestions, in ask", async () => {
    const { vm } = await chat();
    expect(vm).toMatchObject({ title: "Page assistant", greeting: "I read pages.", isReady: true, isEmpty: true, toolMode: "ask" });
    expect(vm.suggestions).toEqual(["Summarise", "Explain"]);
    expect(vm.toolModes.map((o) => [o.mode, o.available])).toEqual([["off", true], ["read_only", true], ["ask", true], ["auto", true]]);
  });

  it("shows a turn as text, a tool line, and more text, in order", async () => {
    const { vm } = await chat({
      model: (r) => (lastToolResults(r).size ? { text: "It says: **The page text.**" } : { text: "Reading.", toolCalls: [{ name: "read_page" }] }),
    });
    vm.setInput("What does the page say?");
    await vm.send();
    expect(vm.input).toBe("");
    const turn = vm.turns[0]!;
    expect(turn.state).toBe("completed");
    expect(turn.parts.map((p) => p.kind)).toEqual(["markdown", "tool", "markdown"]);
    expect((turn.parts[1] as ToolCallPart).title).toBe("Ran read_page");
    expect((turn.parts[0] as MarkdownPart).isStreaming).toBe(false);
    expect(turn.answerText).toBe("Reading.\n\nIt says: **The page text.**");
    expect(turn.usageText).toMatch(/tokens$/);
    expect(vm.sessions[0]).toMatchObject({ title: "What does the page say?", isCurrent: true });
  });

  it("puts an approval card above its tool, and runs the tool when the card is answered", async () => {
    const { vm, written } = await chat({
      model: (r) => (lastToolResults(r).size ? { text: "Done." } : { toolCalls: [{ name: "fill_field", arguments: { text: "Jane" } }] }),
    });
    const sending = vm.send("Fill in my name");
    const turn = vm.turns[0]!;
    const card = await waitFor(() => turn.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart && p.isPending));
    expect(turn.state).toBe("waiting_for_approval");
    expect((turn.parts[1] as ToolCallPart).state).toBe("waiting_for_approval");
    card.allow();
    await sending;
    expect(written).toEqual(["Jane"]);
    expect(turn.parts.map((p) => p.kind)).toEqual(["approval", "tool", "markdown"]);
    expect(card).toMatchObject({ state: "approved", title: "Run fill_field?", argumentsText: "text: Jane", classLabel: "Changes data" });
  });

  it("marks a refused prompt as blocked, with the admin's message", async () => {
    const { vm } = await chat({ model: () => ({ refuse: { stage: "input", message: "Customer data stays here." } }) });
    await vm.send("Our customer list");
    const turn = vm.turns[0]!;
    expect(turn.isPromptBlocked).toBe(true);
    expect(turn.parts[0]).toBeInstanceOf(NoticePart);
    expect(turn.parts[0]).toMatchObject({ severity: "blocked", title: "Your message was not sent", message: "Customer data stays here." });
    turn.edit();
    expect(vm.input).toBe("Our customer list");
  });

  it("stops a running turn", async () => {
    const { vm } = await chat({ model: () => ({ text: "a slow answer, word by word", delayMs: 15 }) });
    const sending = vm.send("Go");
    await new Promise((r) => setTimeout(r, 40));
    vm.stop();
    await sending;
    expect(vm.turns[0]!.state).toBe("stopped");
    expect(vm.turns[0]!.statusText).toBe("Stopped");
    expect(vm.isBusy).toBe(false);
  });

  it("sends attachments, keeps implicit ones for the next message", async () => {
    const { vm, gateway } = await chat({ model: () => ({ text: "ok" }) });
    const page = new AttachmentViewModel({ title: "example.com", subtitle: "page", implicit: true,
      resolve: () => Promise.resolve({ title: "example.com", content: "Page text", kind: "page", source: "page", reference: "page:document" }) });
    vm.addAttachment(page);
    vm.attach({ title: "Selection", content: "Hello", kind: "selection" });
    await vm.send("Explain");
    expect(vm.turns[0]!.attachments.map((a) => a.title)).toEqual(["example.com", "Selection"]);
    expect(vm.attachments).toEqual([page]);
    expect(String(gateway.modelCalls[0]!.messages[0]!.content)).toContain('<attachment title="example.com" kind="page"');
    page.toggle();
    await vm.send("Again");
    expect(vm.turns[1]!.attachments).toEqual([]);
  });

  it("opens a long session at its latest turns and pages in older ones", async () => {
    const { vm } = await chat({ model: () => ({ text: "ok" }) });
    for (let i = 1; i <= 5; i++) await vm.send(`Question ${i}`);
    const id = vm.currentSessionId!;
    const small = new AgentChatViewModel(vm.agent, new ApprovalBroker(), { scheduler: immediateScheduler, initialTurns: 2, pageSize: 2 });
    await small.initialize();
    await small.openSession(id);
    expect(small.turns.map((t) => t.userText)).toEqual(["Question 4", "Question 5"]);
    expect(small.hasEarlierTurns).toBe(true);
    small.loadEarlier();
    small.loadEarlier();
    expect(small.turns.map((t) => t.userText)).toEqual(["Question 1", "Question 2", "Question 3", "Question 4", "Question 5"]);
    expect(small.hasEarlierTurns).toBe(false);
    expect(small.turns[0]!.parts[0]).toBeInstanceOf(MarkdownPart);
  });

  it("lets a card allow a tool always, shows no card for calls a standing approval let through, and resets", async () => {
    const { vm, written, agent } = await chat({
      model: (r) => (lastToolResults(r).size ? { text: "Done." } : { toolCalls: [{ name: "fill_field", arguments: { text: "Jane" } }] }),
    });
    const sending = vm.send("Fill in my name");
    const card = await waitFor(() => vm.turns[0]!.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart && p.isPending));
    expect(card).toMatchObject({ canAllowForSession: true, canAllowAlways: true });
    card.allowAlways();
    await sending;
    expect(card.state).toBe("approved_always");
    expect(card.stateText).toBe("Allowed always");
    await vm.send("Again");
    expect(written).toEqual(["Jane", "Jane"]);
    expect(vm.turns[1]!.parts.some((p) => p instanceof ApprovalPart)).toBe(false);
    // Opened again: the asked card shows how it was answered; the call allowed always shows none.
    const reopened = new AgentChatViewModel(agent, new ApprovalBroker(), { scheduler: immediateScheduler });
    await reopened.initialize();
    await reopened.openSession(vm.currentSessionId!);
    const cards = reopened.turns.flatMap((t) => t.parts.filter((p): p is ApprovalPart => p instanceof ApprovalPart));
    expect(cards.map((c) => c.state)).toEqual(["approved_always"]);
    await vm.resetApprovals();
    const asking = vm.send("Once more");
    const next = await waitFor(() => vm.turns[2]!.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart && p.isPending));
    next.deny();
    await asking;
  });

  it("a card for a tool that cannot be undone offers Allow and Deny only", async () => {
    const { vm } = await chat({
      agents: [{ slug: "page", contract: [{ name: "read_page", risk: "read" }, { name: "fill_field", risk: "destructive" }] }],
      model: (r) => (lastToolResults(r).size ? { text: "Done." } : { toolCalls: [{ name: "fill_field", arguments: { text: "Jane" } }] }),
    });
    const sending = vm.send("Fill in my name");
    const card = await waitFor(() => vm.turns[0]!.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart && p.isPending));
    expect(card).toMatchObject({ canAllowForSession: false, canAllowAlways: false, isDangerous: true });
    card.allowForSession(); // not offered: nothing happens
    card.allowAlways();
    expect(card.isPending).toBe(true);
    card.allow();
    await sending;
    expect(card.state).toBe("approved");
  });

  it("refuses a mode above the agent's ceiling and explains the limit", async () => {
    const { vm } = await chat({ agents: [{ slug: "page", ceiling: "read_only" }] });
    expect(vm.toolMode).toBe("read_only");
    vm.selectToolMode("auto");
    expect(vm.toolMode).toBe("read_only");
    expect(vm.toolModes.find((o) => o.mode === "auto")!.available).toBe(false);
  });

  it("copies an answer", async () => {
    const { vm, clipboard } = await chat({ model: () => ({ text: "Copy me" }) });
    await vm.send("x");
    vm.turns[0]!.copy();
    expect(clipboard.lastText).toBe("Copy me");
    // And as HTML, so it pastes formatted into mail and documents.
    expect(clipboard.lastHtml).toBe("<p>Copy me</p>");
  });

  it("says when the agent needs a sign-in", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "page" }] });
    const { client } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).build();
    const vm = new AgentChatViewModel(agent, new ApprovalBroker(), { scheduler: immediateScheduler });
    await vm.initialize();
    expect(vm.signInRequired).toBe(true);
    expect(vm.isReady).toBe(false);
  });
});

describe("RenderBatcher", () => {
  it("merges text per target and keeps order, one flush per interval", () => {
    const pending: (() => void)[] = [];
    const manual: UiScheduler = { schedule: (cb) => pending.push(cb) };
    const batcher = new RenderBatcher(manual, 33);
    const log: string[] = [];
    const a = {};
    for (const t of ["He", "llo", " wor", "ld"]) batcher.enqueueText(a, t, (s) => log.push(`a:${s}`));
    batcher.enqueue(() => log.push("tool"));
    batcher.enqueueText(a, "!", (s) => log.push(`a:${s}`));
    expect(pending).toHaveLength(1);
    pending.shift()!();
    expect(log).toEqual(["a:Hello world", "tool", "a:!"]);
  });

  it("is also usable without a scheduler delay", () => {
    const batcher = new RenderBatcher(immediateScheduler, 0);
    const log: string[] = [];
    batcher.enqueue(() => log.push("x"));
    expect(log).toEqual(["x"]);
  });
});

describe("AgentChatViewModel's beforeSend and afterSend", () => {
  it("run around every send: the composer, a suggestion and Retry; attachments added first go with the message", async () => {
    const log: string[] = [];
    let vm!: AgentChatViewModel;
    const setup = await chat({ model: () => ({ text: "ok" }) }, {
      beforeSend: async (message: OutgoingMessage, signal: AbortSignal) => {
        log.push(`before ${message.text} busy=${vm.isBusy} aborted=${signal.aborted}`);
        await Promise.resolve();
        if (message.text === "Explain") vm.attach({ title: "Selection", content: "Hello", kind: "selection" });
      },
      afterSend: (message) => log.push(`after ${message.text}`),
    });
    vm = setup.vm;
    vm.setInput("Explain");
    await vm.send();
    await vm.send("Summarise");
    await vm.retry(vm.turns[1]!);
    expect(log).toEqual([
      "before Explain busy=true aborted=false", "after Explain",
      "before Summarise busy=true aborted=false", "after Summarise",
      "before Summarise busy=true aborted=false", "after Summarise",
    ]);
    expect(vm.turns.map((t) => t.userText)).toEqual(["Explain", "Summarise", "Summarise"]);
    expect(vm.turns[0]!.attachments.map((a) => a.title)).toEqual(["Selection"]);
    expect(String(setup.gateway.modelCalls[0]!.messages[0]!.content)).toContain('<attachment title="Selection"');
    expect(vm.input).toBe("");
  });

  it("send nothing when beforeSend throws: the text stays, the error says why, and the next message clears it", async () => {
    let refuse = true;
    const after: string[] = [];
    const { vm, gateway } = await chat({ model: () => ({ text: "ok" }) }, {
      beforeSend: () => {
        if (refuse) throw new Error("Select a file first.");
      },
      afterSend: (message) => after.push(message.text),
    });
    vm.setInput("Summarise the file");
    await vm.send();
    expect(vm).toMatchObject({ isBusy: false, error: "Select a file first.", input: "Summarise the file", isEmpty: true });
    expect(gateway.modelCalls).toHaveLength(0);
    refuse = false;
    await vm.send();
    expect(vm.error).toBeUndefined();
    expect(vm.turns).toHaveLength(1);
    expect(after).toEqual(["Summarise the file", "Summarise the file"]);
  });

  it("are stopped by Stop while the host prepares: no turn, no error", async () => {
    let started!: () => void;
    const preparing = new Promise<void>((r) => (started = r));
    const after: string[] = [];
    const { vm, gateway } = await chat({ model: () => ({ text: "ok" }) }, {
      beforeSend: (_message, signal) => new Promise<void>((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
      afterSend: (message) => after.push(message.text),
    });
    const sending = vm.send("Go");
    await preparing;
    expect(vm.isBusy).toBe(true);
    expect(vm.canSend).toBe(false);
    vm.stop();
    await sending;
    expect(vm).toMatchObject({ isBusy: false, error: undefined, isEmpty: true });
    expect(gateway.modelCalls).toHaveLength(0);
    expect(after).toEqual(["Go"]);
  });

  it("are not needed: a chat without them sends as before", async () => {
    const after: string[] = [];
    const { vm } = await chat({ model: () => ({ text: "ok" }) }, { afterSend: (m) => after.push(m.text) });
    await vm.send("Hi");
    expect(vm.turns).toHaveLength(1);
    expect(after).toEqual(["Hi"]);
  });
});
