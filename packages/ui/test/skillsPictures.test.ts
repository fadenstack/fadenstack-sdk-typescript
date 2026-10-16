import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import {
  AgentChatViewModel,
  ApprovalBroker,
  ApprovalPart,
  MemoryClipboard,
  MemoryPreferenceStore,
  immediateScheduler,
  matchSkills,
  skillToken,
} from "@fadenstack/ui";
import { FakeGateway, lastUserText as lastUserTextOf, type FakeAgent } from "@fadenstack/testing";

const SKILLS = [
  { slug: "reply-in-house-style", name: "Reply in our style", description: "Answers a customer mail the way we write" },
  { slug: "contract-check", name: "Vertragsprüfung", description: "Checks a clause against the legal checklist" },
  { slug: "summary", name: "Short summary", description: "Five bullet points" },
];
const PICTURE = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

async function chat(agent: Partial<FakeAgent> = {}) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant", ...agent }] });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const built = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  const vm = new AgentChatViewModel(built, approvals, {
    scheduler: immediateScheduler, clipboard: new MemoryClipboard(), preferences: new MemoryPreferenceStore(), locale: "en-GB",
  });
  await vm.initialize();
  return { chat: vm, gateway };
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("skillToken", () => {
  it("finds $name at the end, after a space or at the start, and /name as the whole message", () => {
    expect(skillToken("$")).toEqual({ query: "", start: 0 });
    expect(skillToken("Please check $contr")).toEqual({ query: "contr", start: 13 });
    expect(skillToken("/sum")).toEqual({ query: "sum", start: 0 });
    expect(skillToken("Prüfe $vertrags-p")).toEqual({ query: "vertrags-p", start: 6 });
  });

  it("leaves prices, paths and words with a $ inside alone", () => {
    expect(skillToken("It costs $5 now")).toBeUndefined();
    expect(skillToken("US$")).toBeUndefined();
    expect(skillToken("see /docs and more")).toBeUndefined();
    expect(skillToken("$summary done")).toBeUndefined();
  });
});

describe("matchSkills", () => {
  const options = SKILLS.map((s) => ({ ...s, id: s.slug, activation: "manual" }));

  it("matches names and slugs first, then descriptions, without regard to case or accents", () => {
    expect(matchSkills(options, "vertragspruf").map((s) => s.slug)).toEqual(["contract-check"]);
    expect(matchSkills(options, "mail").map((s) => s.slug)).toEqual(["reply-in-house-style"]);
    expect(matchSkills(options, "s").map((s) => s.slug).slice(0, 2)).toEqual(["reply-in-house-style", "contract-check"]);
    expect(matchSkills(options, "").length).toBe(3);
  });
});

describe("the skill picker", () => {
  it("opens on $, narrows as the user types, and the pick goes with the next message only", async () => {
    const { chat: vm, gateway } = await chat({ skills: SKILLS });
    expect(vm.canPickSkills).toBe(true);
    vm.setInput("Answer this mail $");
    expect(vm.skillPicker.isOpen).toBe(true);
    await until(() => !vm.skillPicker.isLoading);
    expect(vm.skillPicker.options.map((s) => s.slug)).toEqual(SKILLS.map((s) => s.slug));
    vm.setInput("Answer this mail $sty");
    expect(vm.skillPicker.options.map((s) => s.slug)).toEqual(["reply-in-house-style"]);
    vm.skillPicker.pick();
    expect(vm.skillPicker.isOpen).toBe(false);
    expect(vm.input).toBe("Answer this mail ");
    expect(vm.pickedSkills.map((s) => s.slug)).toEqual(["reply-in-house-style"]);

    await vm.send();
    expect(gateway.modelCalls.at(-1)!.body["skills"]).toEqual(["reply-in-house-style"]);
    expect(vm.pickedSkills).toEqual([]);
    expect(vm.turns[0]!.attachments).toEqual([{ title: "Reply in our style", subtitle: undefined, skill: true }]);
    await vm.send("And another one");
    expect(gateway.modelCalls.at(-1)!.body["skills"]).toBeUndefined();
    // The list was read once.
    expect(gateway.requests.filter((r) => r.path.endsWith("/skills")).length).toBe(1);
  });

  it("moves round the list with the arrows, and picks by slash at the start", async () => {
    const { chat: vm } = await chat({ skills: SKILLS });
    vm.setInput("/");
    await until(() => !vm.skillPicker.isLoading);
    vm.skillPicker.move(-1);
    expect(vm.skillPicker.activeIndex).toBe(2);
    vm.skillPicker.move(1);
    expect(vm.skillPicker.activeIndex).toBe(0);
    vm.skillPicker.pick();
    expect(vm.input).toBe("");
    expect(vm.pickedSkills.map((s) => s.slug)).toEqual(["reply-in-house-style"]);
    vm.removeSkill("reply-in-house-style");
    expect(vm.pickedSkills).toEqual([]);
  });

  it("never opens on a server without skills", async () => {
    const { chat: vm, gateway } = await chat();
    expect(vm.canPickSkills).toBe(false);
    vm.setInput("$");
    expect(vm.skillPicker.isOpen).toBe(false);
    expect(gateway.requests.some((r) => r.path.endsWith("/skills"))).toBe(false);
  });

  it("keeps the picked skills with the transcript", async () => {
    const { chat: vm } = await chat({ skills: SKILLS });
    vm.setInput("$summ");
    await until(() => !vm.skillPicker.isLoading);
    vm.skillPicker.pick();
    await vm.send("Summarise it");
    const id = vm.currentSessionId!;
    vm.newChat();
    await vm.openSession(id);
    expect(vm.turns[0]!.attachments).toEqual([{ title: "Short summary", subtitle: undefined, skill: true }]);
  });
});

describe("the agent's greeting and suggestions", () => {
  it("are in the panel's language when the definition has it, and follow a change of language", async () => {
    const { chat: vm } = await chat({
      ui: {
        greeting: "I read pages.",
        suggestions: ["Summarise this page"],
        languages: { de: { greeting: "Ich lese Seiten.", suggestions: ["Diese Seite zusammenfassen"] }, fr: { greeting: "Je lis les pages." } },
      },
    });
    expect(vm.greeting).toBe("I read pages.");
    await vm.setLanguage("de");
    expect(vm.greeting).toBe("Ich lese Seiten.");
    expect(vm.suggestions).toEqual(["Diese Seite zusammenfassen"]);
    await vm.setLanguage("fr");
    expect(vm.greeting).toBe("Je lis les pages.");
    expect(vm.suggestions).toEqual(["Summarise this page"]); // French has no suggestions of its own
    await vm.setLanguage("es");
    expect(vm.greeting).toBe("I read pages.");
  });
});

describe("an approval for a tool that reaches outside", () => {
  it("says that what it is given leaves the organisation, not what its class means", async () => {
    const gateway = new FakeGateway({
      agents: [{ slug: "page", contract: [{ name: "search_web", risk: "write" }, { name: "fill_field", risk: "write" }] }],
      model: (r) => (r.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: lastUserTextOf(r), arguments: { query: "pumps" } }] }),
    });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const approvals = new ApprovalBroker();
    const built = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
      .addTools(
        defineTool({ name: "search_web", toolClass: "write", openWorld: true, parameters: { type: "object", properties: { query: { type: "string" } } }, run: () => "results" }),
        defineTool({ name: "fill_field", toolClass: "write", parameters: { type: "object", properties: { query: { type: "string" } } }, run: () => "filled" }),
      ).build();
    const vm = new AgentChatViewModel(built, approvals, { scheduler: immediateScheduler, clipboard: new MemoryClipboard(), preferences: new MemoryPreferenceStore() });
    await vm.initialize();
    const card = async (tool: string) => {
      const sending = vm.send(tool);
      await until(() => vm.turns.at(-1)!.parts.some((p) => p instanceof ApprovalPart));
      const part = vm.turns.at(-1)!.parts.find((p) => p instanceof ApprovalPart) as ApprovalPart;
      const seen = { label: part.classLabel, reason: part.reason };
      part.allow();
      await sending;
      return seen;
    };
    expect(await card("search_web")).toEqual({ label: "Goes outside", reason: "What it is given leaves your organisation: it goes to another site." });
    expect(await card("fill_field")).toEqual({ label: "Changes data", reason: "It changes something, which can be changed back." });
  });
});

describe("pictures", () => {
  it("go with the message as an image part, for a model that sees pictures", async () => {
    const { chat: vm, gateway } = await chat({ vision: true });
    expect(vm.canAttachPictures).toBe(true);
    expect(vm.attachPicture({ dataUrl: PICTURE, title: "Screenshot", kind: "screenshot" })).toBe(true);
    expect(vm.attachments[0]!.image).toBe(PICTURE);
    await vm.send("What does this error say?");
    const user = gateway.modelCalls.at(-1)!.messages.at(-1)!;
    expect(user.content).toEqual([
      { type: "image_url", image_url: { url: PICTURE } },
      { type: "text", text: "What does this error say?" },
    ]);
    expect(vm.turns[0]!.attachments[0]).toMatchObject({ title: "Screenshot", image: PICTURE });
  });

  it("are refused, with the reason, when the agent's model does not see pictures", async () => {
    const { chat: vm } = await chat({ vision: false });
    expect(vm.attachPicture({ dataUrl: PICTURE })).toBe(false);
    expect(vm.attachments).toEqual([]);
    expect(vm.error).toBe("This agent's model does not see pictures.");
  });

  it("are refused by a server that does not say whether its model sees them", async () => {
    const { chat: vm } = await chat();
    expect(vm.canAttachPictures).toBe(false);
  });
});
