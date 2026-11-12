import { afterEach, describe, expect, it, vi } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import {
  AgentChatViewModel,
  ApprovalBroker,
  MAX_PROMPTS,
  MAX_PROMPT_LENGTH,
  MemoryClipboard,
  MemoryPreferenceStore,
  MemoryPromptStore,
  PromptStoreError,
  browserPromptStore,
  germanStrings,
  immediateScheduler,
  matchPrompts,
  promptTitle,
  type AgentChatOptions,
  type PromptStore,
  type SavedPrompt,
} from "@fadenstack/ui";
import { FakeGateway, type FakeAgent } from "@fadenstack/testing";

afterEach(() => vi.unstubAllGlobals());

const SKILLS = [
  { slug: "reply", name: "Reply in our style", description: "Answers a customer mail" },
  { slug: "summary", name: "Short summary", description: "Five bullet points" },
];

async function chat(options: AgentChatOptions = {}, agent: Partial<FakeAgent> = {}) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant", ...agent }] });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const built = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  const vm = new AgentChatViewModel(built, approvals, {
    scheduler: immediateScheduler, clipboard: new MemoryClipboard(), preferences: new MemoryPreferenceStore(), locale: "en-GB", ...options,
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

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("promptTitle", () => {
  it("is the first non-empty line, trimmed, and cut to 60 characters with an ellipsis", () => {
    expect(promptTitle("\n  \n  Summarise this page  \nin five points")).toBe("Summarise this page");
    const long = promptTitle("x".repeat(100));
    expect(Array.from(long).length).toBe(60);
    expect(long.endsWith("…")).toBe(true);
    expect(promptTitle("y".repeat(60))).toBe("y".repeat(60));
  });
});

describe("MemoryPromptStore", () => {
  it("saves a prompt with a title, an id and a date, lists the newest first, and removes by id", async () => {
    const store = new MemoryPromptStore({ now: () => new Date("2026-11-12T10:00:00Z") });
    const first = await store.save("  First prompt\nwith a second line ");
    const second = await store.save("Second prompt");
    expect(first).toMatchObject({ title: "First prompt", text: "First prompt\nwith a second line", savedAt: "2026-11-12T10:00:00.000Z" });
    expect(first.id).not.toBe(second.id);
    expect((await store.list()).map((p) => p.title)).toEqual(["Second prompt", "First prompt"]);
    await store.remove(first.id);
    expect((await store.list()).map((p) => p.id)).toEqual([second.id]);
    await store.remove("unknown"); // nothing to do, no error
  });

  it("refuses a prompt over 4,000 characters, and accepts exactly 4,000", async () => {
    const store = new MemoryPromptStore();
    expect(MAX_PROMPT_LENGTH).toBe(4000);
    const error = await failure(store.save("a".repeat(4001)));
    expect(error).toBeInstanceOf(PromptStoreError);
    expect((error as PromptStoreError).code).toBe("too_long");
    expect((await store.save("a".repeat(4000))).text.length).toBe(4000);
  });

  it("refuses the 101st prompt with a typed error, and keeps the same text once", async () => {
    const store = new MemoryPromptStore();
    expect(MAX_PROMPTS).toBe(100);
    for (let i = 0; i < 100; i++) await store.save(`prompt ${i}`);
    const again = await store.save("prompt 5"); // already kept: not a new one
    expect(again.text).toBe("prompt 5");
    expect((await store.list()).length).toBe(100);
    const error = await failure(store.save("one more"));
    expect((error as PromptStoreError).code).toBe("too_many");
    await store.remove(again.id);
    expect((await store.save("one more")).text).toBe("one more");
  });

  it("refuses nothing but white space", async () => {
    const error = await failure(new MemoryPromptStore().save("  \n "));
    expect((error as PromptStoreError).code).toBe("empty");
  });
});

describe("browserPromptStore", () => {
  function storage(initial: Record<string, string> = {}, failWrites = false) {
    const values = new Map(Object.entries(initial));
    return {
      values,
      api: {
        getItem: (k: string) => values.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (failWrites) throw new Error("quota");
          values.set(k, v);
        },
        removeItem: (k: string) => void values.delete(k),
      },
    };
  }

  it("keeps the list in localStorage under fadenstack.prompts, shared by every store on the page", async () => {
    const s = storage();
    vi.stubGlobal("localStorage", s.api);
    const a = browserPromptStore();
    const saved = await a.save("Kept");
    expect(JSON.parse(s.values.get("fadenstack.prompts")!)).toEqual([saved]);
    expect((await browserPromptStore().list()).map((p) => p.text)).toEqual(["Kept"]);
    await a.remove(saved.id);
    expect(await browserPromptStore().list()).toEqual([]);
  });

  it("ignores a damaged list, entries that are not prompts, and falls back to memory when writes fail", async () => {
    const damaged = storage({ "fadenstack.prompts": "{not json" });
    vi.stubGlobal("localStorage", damaged.api);
    expect(await browserPromptStore().list()).toEqual([]);

    const mixed = storage({ "fadenstack.prompts": JSON.stringify([{ id: "a", text: "Good", title: "Good", savedAt: "x" }, { id: 5 }, "x", { id: "b", text: "" }]) });
    vi.stubGlobal("localStorage", mixed.api);
    expect((await browserPromptStore().list()).map((p) => p.id)).toEqual(["a"]);

    const full = storage({}, true);
    vi.stubGlobal("localStorage", full.api);
    const store = browserPromptStore();
    await store.save("In memory only");
    expect((await store.list()).map((p) => p.text)).toEqual(["In memory only"]);
  });

  it("is a memory store where there is no localStorage", async () => {
    vi.stubGlobal("localStorage", undefined);
    const store = browserPromptStore();
    await store.save("x");
    expect((await store.list()).length).toBe(1);
  });
});

describe("matchPrompts", () => {
  const prompts: SavedPrompt[] = [
    { id: "1", title: "Überprüfung des Vertrags", text: "Prüfe den Vertrag", savedAt: "" },
    { id: "2", title: "Summary", text: "Make a summary of the Überprüfung", savedAt: "" },
    { id: "3", title: "Other", text: "nothing", savedAt: "" },
  ];

  it("matches title and text without regard to case or accents, titles first", () => {
    expect(matchPrompts(prompts, "uberprufung").map((p) => p.id)).toEqual(["1", "2"]);
    expect(matchPrompts(prompts, "PRUFE").map((p) => p.id)).toEqual(["1"]);
    expect(matchPrompts(prompts, "").length).toBe(3);
    expect(matchPrompts(prompts, "zzz")).toEqual([]);
  });
});

describe("the picker with a prompt store", () => {
  async function withPrompts(agent: Partial<FakeAgent> = {}, options: AgentChatOptions = {}) {
    const prompts = new MemoryPromptStore();
    await prompts.save("Summarise this page in five points");
    await prompts.save("Antworte freundlich auf diese Mail");
    const made = await chat({ prompts, ...options }, agent);
    return { ...made, prompts };
  }

  it("opens on $ even when the server offers no skills; without a store it stays shut, as before", async () => {
    const { chat: vm } = await withPrompts();
    expect(vm.canPickSkills).toBe(false);
    expect(vm.canPick).toBe(true);
    vm.setInput("Please $");
    expect(vm.skillPicker.isOpen).toBe(true);
    await until(() => vm.skillPicker.promptOptions.length === 2);
    expect(vm.skillPicker.hasSkillSection).toBe(false);
    expect(vm.skillPicker.isLoading).toBe(false);

    const { chat: plain } = await chat();
    plain.setInput("Please $");
    expect(plain.canPick).toBe(false);
    expect(plain.skillPicker.isOpen).toBe(false);
    expect(plain.canSavePrompts).toBe(false);
  });

  it("lists My prompts first, then the skills, narrowed by one query (accent-insensitive)", async () => {
    const { chat: vm } = await withPrompts({ skills: SKILLS });
    vm.setInput("$");
    await until(() => vm.skillPicker.entries.length === 4);
    expect(vm.skillPicker.entries.map((e) => (e.kind === "prompt" ? e.prompt.title : e.skill.slug))).toEqual([
      "Antworte freundlich auf diese Mail", "Summarise this page in five points", "reply", "summary",
    ]);
    vm.setInput("$summ");
    expect(vm.skillPicker.entries.map((e) => e.kind)).toEqual(["prompt", "skill"]);
    vm.setInput("$freundl");
    expect(vm.skillPicker.entries.map((e) => e.kind)).toEqual(["prompt"]);
    vm.setInput("$nothing-like-it");
    expect(vm.skillPicker.entries).toEqual([]);
    expect(vm.skillPicker.hasPrompts).toBe(true);
  });

  it("moves with the arrows across both sections, round the ends", async () => {
    const { chat: vm } = await withPrompts({ skills: SKILLS });
    vm.setInput("$");
    await until(() => vm.skillPicker.entries.length === 4);
    const picker = vm.skillPicker;
    expect(picker.activeIndex).toBe(0);
    picker.move(1);
    picker.move(1);
    expect(picker.entries[picker.activeIndex]).toMatchObject({ kind: "skill" }); // crossed from the prompts into the skills
    picker.move(1);
    picker.move(1);
    expect(picker.activeIndex).toBe(0);
    picker.move(-1);
    expect(picker.activeIndex).toBe(3);
  });

  it("Enter on a prompt puts its text where the $ was, is not a skill chip, closes the list and asks for the focus", async () => {
    const { chat: vm } = await withPrompts({ skills: SKILLS });
    let focused = 0;
    vm.onComposerFocus(() => void focused++);
    vm.setInput("Hello, please $summ");
    await until(() => vm.skillPicker.promptOptions.length === 1);
    vm.skillPicker.pick();
    expect(vm.input).toBe("Hello, please Summarise this page in five points");
    expect(vm.pickedSkills).toEqual([]);
    expect(vm.skillPicker.isOpen).toBe(false);
    expect(focused).toBe(1);

    vm.setInput("/");
    await until(() => vm.skillPicker.entries.length === 4);
    vm.skillPicker.pickPrompt(vm.skillPicker.promptOptions[0]!);
    expect(vm.input).toBe("Antworte freundlich auf diese Mail");
  });

  it("still picks a skill as a chip from the second section", async () => {
    const { chat: vm } = await withPrompts({ skills: SKILLS });
    vm.setInput("Answer $reply");
    await until(() => vm.skillPicker.options.length === 1);
    expect(vm.skillPicker.activeIndex).toBe(vm.skillPicker.promptOptions.length);
    vm.skillPicker.pick();
    expect(vm.pickedSkills.map((s) => s.slug)).toEqual(["reply"]);
    expect(vm.input).toBe("Answer ");
  });

  it("deletes a prompt without picking it", async () => {
    const { chat: vm, prompts } = await withPrompts();
    vm.setInput("$");
    await until(() => vm.skillPicker.promptOptions.length === 2);
    const target = vm.skillPicker.promptOptions[0]!;
    await vm.skillPicker.removePrompt(target.id);
    expect(vm.skillPicker.promptOptions.map((p) => p.id)).not.toContain(target.id);
    expect((await prompts.list()).length).toBe(1);
    expect(vm.input).toBe("$");
    expect(vm.skillPicker.isOpen).toBe(true);
  });

  it("reads the prompts again whenever the list opens, so a prompt saved meanwhile is there", async () => {
    const { chat: vm, prompts } = await withPrompts();
    vm.setInput("$");
    await until(() => vm.skillPicker.promptOptions.length === 2);
    vm.setInput("");
    await prompts.save("A third one");
    vm.setInput("$");
    await until(() => vm.skillPicker.promptOptions.length === 3);
  });

  it("says there are no prompts yet while the store is empty", async () => {
    const { chat: vm } = await chat({ prompts: new MemoryPromptStore() });
    vm.setInput("$");
    await until(() => vm.skillPicker.hasPromptStore);
    expect(vm.skillPicker.hasPrompts).toBe(false);
    expect(vm.skillPicker.entries).toEqual([]);
    expect(vm.strings.noPrompts).toContain("Save as prompt");
  });
});

describe("saving a sent message as a prompt", () => {
  it("is offered on a message when there is a store, and keeps its text; the answer is a translated confirmation", async () => {
    const prompts = new MemoryPromptStore();
    const { chat: vm } = await chat({ prompts });
    await vm.send("Summarise this page");
    const turn = vm.turns[0]!;
    expect(turn.canSavePrompt).toBe(true);
    expect(await turn.savePrompt()).toEqual({ saved: true, message: "Saved as a prompt" });
    expect((await prompts.list()).map((p) => p.text)).toEqual(["Summarise this page"]);
    expect(await turn.savePrompt()).toEqual({ saved: true, message: "Saved as a prompt" });
    expect((await prompts.list()).length).toBe(1);
  });

  it("is not offered without a store", async () => {
    const { chat: vm } = await chat();
    await vm.send("Hello");
    expect(vm.turns[0]!.canSavePrompt).toBe(false);
    expect((await vm.turns[0]!.savePrompt()).saved).toBe(false);
  });

  it("tells, translated, when the text is too long or the user keeps too many", async () => {
    const prompts = new MemoryPromptStore();
    const { chat: vm } = await chat({ prompts });
    expect(await vm.savePrompt("x".repeat(4001))).toEqual({ saved: false, message: "A prompt can have at most 4,000 characters." });
    for (let i = 0; i < 100; i++) await prompts.save(`prompt ${i}`);
    expect(await vm.savePrompt("one more")).toEqual({ saved: false, message: "You can keep at most 100 prompts. Delete one first." });
    expect((await vm.savePrompt("  ")).message).toBe("The prompt could not be saved.");

    const { chat: de } = await chat({ prompts: new MemoryPromptStore(), automaticLanguage: "de", locale: "de-DE" });
    expect(await de.savePrompt("x".repeat(4001))).toEqual({ saved: false, message: germanStrings.promptTooLong("4.000") });
    expect(germanStrings.promptTooLong("4.000")).toBe("Ein Prompt darf höchstens 4.000 Zeichen lang sein.");
    expect((await de.savePrompt("Hallo")).message).toBe("Als Prompt gespeichert");
  });

  it("copes with a store that fails", async () => {
    const broken: PromptStore = { list: () => Promise.reject(new Error("no")), save: () => Promise.reject(new Error("no")), remove: () => Promise.reject(new Error("no")) };
    const { chat: vm } = await chat({ prompts: broken });
    expect(await vm.savePrompt("Hello")).toEqual({ saved: false, message: "The prompt could not be saved." });
    vm.setInput("$");
    await new Promise((r) => setTimeout(r, 10));
    expect(vm.skillPicker.promptOptions).toEqual([]);
    await vm.skillPicker.removePrompt("x"); // no throw
  });
});
