import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool, type AnswerCopy, type AnswerCopyMarker, type MarkedCopy } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, MemoryClipboard, immediateScheduler, type AgentChatOptions, type FileToSave, type MarkdownPart } from "@fadenstack/ui";
import { FakeGateway, type FakeModel } from "@fadenstack/testing";
import { testServices } from "./services.js";

/**
 * Copying in the chat goes through the agent's marking (`agent.markCopy`): a marker stands in for the provenance module here, as it is
 * in the .NET tests of the UI (the UI has no reference to the provenance package).
 */
class FakeMarker implements AnswerCopyMarker {
  readonly seen: AnswerCopy[] = [];
  refuse = false;

  async mark(copy: AnswerCopy): Promise<MarkedCopy> {
    this.seen.push(copy);
    if (this.refuse) return { text: copy.text, marked: false, refused: true };
    if (copy.file) return { text: `---\nai-generated: true\n---\n${copy.text}`, marked: true, recordId: "r-1" };
    if (copy.code) return { text: copy.text, ...(copy.html ? { html: copy.html } : {}), marked: false, exemptBecause: "code" };
    return { text: copy.text, ...(copy.html ? { html: `<span data-ai-generated="r-1">${copy.html}</span>` } : {}), marked: true, recordId: "r-1" };
  }
}

async function chat(model: FakeModel, marker: FakeMarker | undefined, options: Partial<AgentChatOptions> = {}) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant" }], model });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  let builder = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .addTools(defineTool({ name: "noop", toolClass: "read", run: () => "" }));
  if (marker) builder = builder.useAnswerCopyMarker(() => marker);
  const clipboard = new MemoryClipboard();
  const saved: FileToSave[] = [];
  const vm = new AgentChatViewModel(builder.build(), approvals, {
    ...testServices(), scheduler: immediateScheduler, clipboard, saveFile: (f) => void saved.push(f), ...options,
  });
  await vm.initialize();
  return { vm, clipboard, saved };
}

describe("copying an answer", () => {
  it("puts the text as it was and the marked HTML on the clipboard, and says Copied", async () => {
    const marker = new FakeMarker();
    const { vm, clipboard } = await chat(() => ({ text: "Hello **Jane**" }), marker);
    await vm.send("Greet Jane.");
    const turn = vm.turns[0]!;

    await turn.copy();

    expect(clipboard.lastText).toBe("Hello **Jane**");
    expect(clipboard.lastHtml).toBe('<span data-ai-generated="r-1"><p>Hello <strong>Jane</strong></p></span>');
    expect(marker.seen[0]).toMatchObject({ text: "Hello **Jane**", chat: vm.currentSessionId, turn: turn.id });
    expect(turn.copyStatus).toBe("Copied");
    expect(turn.copyRefused).toBe(false);
  });

  it("copies the text and its HTML as before without a marker", async () => {
    const { vm, clipboard } = await chat(() => ({ text: "Copy me" }), undefined);
    await vm.send("x");
    await vm.turns[0]!.copy();
    expect([clipboard.lastText, clipboard.lastHtml]).toEqual(["Copy me", "<p>Copy me</p>"]);
  });

  it("copies nothing when the policy refuses, and says why", async () => {
    const marker = new FakeMarker();
    marker.refuse = true;
    const { vm, clipboard } = await chat(() => ({ text: "Hello" }), marker);
    await vm.send("x");
    const turn = vm.turns[0]!;

    await turn.copy();

    expect(clipboard.lastText).toBeUndefined();
    expect(turn.copyStatus).toBe("Not copied: this answer could not be marked as AI-generated, and your organisation requires it.");
    expect(turn.copyRefused).toBe(true);
  });

  it("marks a copied table, and copies a code block as it is, recorded as code", async () => {
    const marker = new FakeMarker();
    const { vm, clipboard } = await chat(() => ({ text: "| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```" }), marker);
    await vm.send("x");
    const part = vm.turns[0]!.parts.find((p): p is MarkdownPart => p.kind === "markdown")!;
    const table = part.blocks.find((b) => b.kind === "table")!;

    expect(await part.copyTable(table as Parameters<MarkdownPart["copyTable"]>[0])).toBe("copied");
    expect(clipboard.lastText).toBe("A\tB\n1\t2");
    expect(clipboard.lastHtml).toBe('<span data-ai-generated="r-1"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></span>');
    expect(marker.seen.at(-1)).toMatchObject({ turn: vm.turns[0]!.id });

    expect(await part.copyCode("let x = 1;")).toBe("copied");
    expect(marker.seen.at(-1)).toMatchObject({ text: "let x = 1;", code: true });
    expect([clipboard.lastText, clipboard.lastHtml]).toEqual(["let x = 1;", undefined]);
  });

  it("refuses the copy of a table too", async () => {
    const marker = new FakeMarker();
    marker.refuse = true;
    const { vm, clipboard } = await chat(() => ({ text: "| A |\n|---|\n| 1 |" }), marker);
    await vm.send("x");
    const part = vm.turns[0]!.parts.find((p): p is MarkdownPart => p.kind === "markdown")!;
    expect(await part.copyTable(part.blocks.find((b) => b.kind === "table") as Parameters<MarkdownPart["copyTable"]>[0])).toBe("refused");
    expect(clipboard.lastText).toBeUndefined();
  });
});

describe("saving a chat as Markdown", () => {
  it("is marked in its front matter through the agent's marking", async () => {
    const marker = new FakeMarker();
    const { vm, saved } = await chat(() => ({ text: "Hello" }), marker);
    await vm.send("Hi");

    await vm.saveChatMarkdown();

    expect(marker.seen.at(-1)).toMatchObject({ file: true, chat: vm.currentSessionId, turn: vm.turns[0]!.id });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.content).toMatch(/^---\nai-generated: true\n---\n# Hi/);
  });

  it("saves nothing when the policy refuses, and says so", async () => {
    const marker = new FakeMarker();
    marker.refuse = true;
    const { vm, saved } = await chat(() => ({ text: "Hello" }), marker);
    await vm.send("Hi");

    await vm.saveChatMarkdown();

    expect(saved).toEqual([]);
    expect(vm.error).toBe("Not saved: this chat could not be marked as AI-generated, and your organisation requires it.");
  });
});
