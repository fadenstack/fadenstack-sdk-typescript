import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import {
  AgentChatViewModel,
  ApprovalBroker,
  MemoryClipboard,
  MemoryPreferenceStore,
  chatFileName,
  immediateScheduler,
  type AgentChatOptions,
  type FileToSave,
} from "@fadenstack/ui";
import { FakeGateway, lastToolResults, type FakeAgent, type FakeModel } from "@fadenstack/testing";

async function chat(model: FakeModel, options: AgentChatOptions = {}, agent: Partial<FakeAgent> = {}) {
  const gateway = new FakeGateway({
    agents: [{ slug: "page", name: "Page assistant", contract: [{ name: "read_page", risk: "read" }], ...agent }],
    model,
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const built = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .addTools(defineTool({ name: "read_page", toolClass: "read", run: () => "The page text." })).build();
  const saved: FileToSave[] = [];
  const vm = new AgentChatViewModel(built, approvals, {
    scheduler: immediateScheduler, clipboard: new MemoryClipboard(), preferences: new MemoryPreferenceStore(), locale: "en-GB",
    now: () => new Date(2026, 10, 12, 9, 30), saveFile: (f) => void saved.push(f), ...options,
  });
  await vm.initialize();
  return { chat: vm, saved, gateway };
}

const readsThenAnswers: FakeModel = (r) => (lastToolResults(r).size
  ? { reasoning: "Secret thinking about the page.", text: "The page says **hello**.\n\n| A |\n|---|\n| 1 |" }
  : { toolCalls: [{ name: "read_page" }] });

describe("exporting a chat as Markdown", () => {
  it("is empty-chat aware: nothing to export, nothing saved", async () => {
    const { chat: vm, saved } = await chat(() => ({ text: "ok" }));
    expect(vm.canExport).toBe(false);
    await vm.saveChatMarkdown();
    expect(saved).toEqual([]);
  });

  it("writes the title, the date, then each turn in order: message, attachment titles, answer under the agent's name, tool lines", async () => {
    const { chat: vm } = await chat(readsThenAnswers);
    vm.attach({ title: "Contract.pdf", content: "SECRET CONTENT OF THE CONTRACT", kind: "document" });
    await vm.send("What does the page say?\n# not a heading");
    await vm.send("And again");
    const md = vm.exportMarkdown();
    expect(md.startsWith("# What does the page say?\n\n12 November 2026\n")).toBe(true);
    const lines = md.split("\n");
    // order: first message, its attachment line, the agent, the tool line, the answer, then the second message
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(at("> What does the page say?")).toBeLessThan(at("_Attachments: Contract.pdf_"));
    expect(at("_Attachments: Contract.pdf_")).toBeLessThan(at("## Page assistant"));
    expect(at("## Page assistant")).toBeLessThan(at("- Ran read_page"));
    expect(at("- Ran read_page")).toBeLessThan(at("The page says **hello**."));
    expect(at("The page says **hello**.")).toBeLessThan(at("> And again"));
    expect(md).toContain("> # not a heading"); // a message cannot change the document's structure
    expect(md).toContain("## You");
    expect(md).toContain("| A |\n|---|\n| 1 |");
  });

  it("leaves out reasoning, approval cards and the content of attachments", async () => {
    const { chat: vm } = await chat(readsThenAnswers);
    vm.attach({ title: "Contract.pdf", content: "SECRET CONTENT OF THE CONTRACT", kind: "document" });
    await vm.send("Read it");
    const md = vm.exportMarkdown();
    expect(md).not.toContain("Secret thinking");
    expect(md).not.toContain("SECRET CONTENT");
    expect(md).not.toContain("Run read_page?");
    expect(md).not.toContain("Thought for");
  });

  it("names picked skills by their titles", async () => {
    const { chat: vm } = await chat(() => ({ text: "Done." }), {}, { skills: [{ slug: "check", name: "Contract check" }] });
    vm.setInput("Please $");
    await new Promise((r) => setTimeout(r, 20));
    vm.skillPicker.pick();
    await vm.send("Please check it");
    expect(vm.exportMarkdown()).toContain("_Skills: Contract check_");
  });

  it("speaks the panel's language, German with Sie, and the date in the chat's locale", async () => {
    const { chat: vm } = await chat(readsThenAnswers, { automaticLanguage: "de", locale: "de-DE" });
    vm.attach({ title: "Vertrag.pdf", content: "x", kind: "document" });
    await vm.send("Was steht auf der Seite?");
    const md = vm.exportMarkdown();
    expect(md).toContain("## Sie");
    expect(md).toContain("_Anhänge: Vertrag.pdf_");
    expect(md).toContain("12. November 2026");
    expect(md).toContain("- read_page ausgeführt");
    expect(md).not.toContain("## You");
  });

  it("saves through saveFile as text/markdown with a file name made from the title", async () => {
    const { chat: vm, saved } = await chat(() => ({ text: "Hi" }));
    await vm.send("Was ist das Wetter? Über 20°C!");
    vm.setSettingsOpen(true);
    await vm.saveChatMarkdown();
    expect(vm.isSettingsOpen).toBe(false);
    expect(saved.length).toBe(1);
    expect(saved[0]!.type).toBe("text/markdown");
    expect(saved[0]!.name).toBe("Was-ist-das-Wetter-Über-20C.md");
    expect(saved[0]!.content).toBe(vm.exportMarkdown());
  });
});

describe("chatFileName", () => {
  it("keeps letters and digits (also umlauts), turns spaces into hyphens and drops the rest", () => {
    expect(chatFileName("Quarterly report 2026")).toBe("Quarterly-report-2026.md");
    expect(chatFileName("a/b\\c:d*e?f\"g<h>i|j")).toBe("abcdefghij.md");
    expect(chatFileName("  Grüße   aus  Köln ")).toBe("Grüße-aus-Köln.md");
    expect(chatFileName("../../etc/passwd")).toBe("etcpasswd.md");
  });

  it("is at most 60 characters before .md, and never ends in a hyphen", () => {
    const name = chatFileName("word ".repeat(30));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith("-.md")).toBe(false);
    expect(name.endsWith(".md")).toBe(true);
  });

  it("falls back to chat.md for nothing usable or a reserved device name", () => {
    expect(chatFileName("")).toBe("chat.md");
    expect(chatFileName("???")).toBe("chat.md");
    expect(chatFileName("CON")).toBe("chat.md");
  });
});
