import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import {
  AUTOMATIC_LANGUAGE,
  AgentChatViewModel,
  ApprovalBroker,
  MemoryPreferenceStore,
  NoticePart,
  ToolCallPart,
  builtInStrings,
  englishStrings,
  immediateScheduler,
  type AgentChatOptions,
  type PreferenceStore,
  type UiStrings,
} from "@fadenstack/ui";
import { FakeGateway, lastToolResults } from "@fadenstack/testing";

async function chat(options: AgentChatOptions = {}, gateway = pageGateway(), fetch: FakeGateway["fetch"] = gateway.fetch) {
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .addTools(defineTool({ name: "read_page", toolClass: "read", run: () => "The page text." })).build();
  return new AgentChatViewModel(agent, approvals, { scheduler: immediateScheduler, preferences: new MemoryPreferenceStore(), ...options });
}

/** The user's language, as the server keeps it for all their clients. */
function pageGateway(language?: string | null) {
  return new FakeGateway({
    users: [{ email: "user@example.com", password: "secret", language }],
    agents: [{ slug: "page", name: "Seitenhelfer", contract: [{ name: "read_page", risk: "read" }] }],
    model: (r) => lastToolResults(r).size
      ? { text: "Fertig.", events: [{ type: "CUSTOM", name: "faden.pii", value: { entities: { PERSON: 2 } } }] }
      : { toolCalls: [{ name: "read_page" }] },
  });
}

describe("the language the user picks in the panel", () => {
  it("starts in the host's language and lists every language in its own name, Automatic first", async () => {
    const vm = await chat({ automaticLanguage: "de-AT" });
    expect(vm.strings.language).toBe("de");
    expect(vm.language).toBe(AUTOMATIC_LANGUAGE);
    expect(vm.canChangeLanguage).toBe(true);
    expect(vm.languageOptions.map((o) => [o.id, o.label, o.lang, o.selected])).toEqual([
      ["auto", "Automatisch (Deutsch)", "de", true],
      ["en", "English", "en", false],
      ["de", "Deutsch", "de", false],
      ["fr", "Français", "fr", false],
      ["es", "Español", "es", false],
      ["zh-Hans", "中文（简体）", "zh-Hans", false],
    ]);
  });

  it("draws everything again in the new language, the conversation too, and remembers it", async () => {
    const preferences = new MemoryPreferenceStore();
    const vm = await chat({ automaticLanguage: "de-DE", preferences });
    await vm.initialize();
    await vm.send("Lies die Seite");
    const turn = vm.turns[0]!;
    const tool = turn.parts.find((p): p is ToolCallPart => p instanceof ToolCallPart)!;
    const notice = turn.parts.find((p): p is NoticePart => p instanceof NoticePart)!;
    expect([tool.title, notice.title, turn.usageText.endsWith("Tokens"), vm.toolModes[2]!.label, vm.greeting])
      .toEqual(["read_page ausgeführt", "Personenbezogene Daten geschützt", true, "Nachfragen", "Was möchten Sie Seitenhelfer fragen?"]);

    let redrawn = 0;
    turn.subscribe(() => redrawn++);
    tool.subscribe(() => redrawn++);
    vm.setSettingsOpen(true);
    await vm.setLanguage("fr");
    expect(redrawn).toBe(2);
    expect(vm.isSettingsOpen).toBe(false);
    expect([vm.strings.language, tool.title, notice.title, turn.usageText.endsWith("jetons"), vm.toolModes[2]!.label, vm.greeting])
      .toEqual(["fr", "read_page exécuté", "Données personnelles protégées", true, "Demander", "Posez votre question à Seitenhelfer."]);
    expect(vm.languageOptions[0]!.label).toBe("Automatique (Deutsch)");
    expect(preferences.get("language")).toBe("fr");

    const again = await chat({ automaticLanguage: "de-DE", preferences });
    expect(again.strings.language).toBe("fr"); // from the first paint: this store answers at once

    await vm.setLanguage(AUTOMATIC_LANGUAGE);
    expect([vm.strings.language, tool.title, preferences.get("language")]).toEqual(["de", "read_page ausgeführt", undefined]);
  });

  it("reads a store that answers later when the chat starts", async () => {
    const values = new Map([["language", "es"]]);
    const slow: PreferenceStore = {
      get: async (name) => values.get(name),
      set: async (name, value) => void (value === undefined ? values.delete(name) : values.set(name, value)),
    };
    const vm = await chat({ automaticLanguage: "en", preferences: slow });
    expect(vm.strings.language).toBe("en");
    await vm.initialize();
    expect(vm.strings.language).toBe("es");
  });

  it("keeps the language the organisation fixed: no choice, the user's old pick ignored", async () => {
    const preferences = new MemoryPreferenceStore();
    preferences.set("language", "de");
    const vm = await chat({ automaticLanguage: "fr", lockedLanguage: "es-MX", preferences });
    await vm.initialize();
    expect([vm.strings.language, vm.language, vm.canChangeLanguage, vm.isLanguageLocked]).toEqual(["es", "es", false, true]);
    expect(vm.languageOptions.find((o) => o.selected)?.id).toBe("es");
    await vm.setLanguage("de");
    expect(vm.strings.language).toBe("es");
    expect(preferences.get("language")).toBe("de"); // untouched
  });

  it("offers no choice when the host fixed the texts, and ignores a language it does not have", async () => {
    const fixed = await chat({ strings: { send: "Go" } });
    expect([fixed.canChangeLanguage, fixed.languageOptions, fixed.strings.send]).toEqual([false, [], "Go"]);

    const vm = await chat({ automaticLanguage: "en" });
    await vm.setLanguage("klingon");
    await vm.setLanguage("toString");
    expect(vm.strings.language).toBe("en");
  });

  it("follows the language the user picked in another client or the console, and remembers it here", async () => {
    const preferences = new MemoryPreferenceStore();
    preferences.set("language", "fr");
    const vm = await chat({ automaticLanguage: "en", preferences }, pageGateway("de-AT"));
    expect(vm.strings.language).toBe("fr"); // this device's, until the server answers
    await vm.initialize();
    expect([vm.language, vm.strings.language, preferences.get("language")]).toEqual(["de", "de", "de"]);

    const chinese = await chat({ automaticLanguage: "en" }, pageGateway("zh")); // as the console writes it
    await chinese.initialize();
    expect(chinese.language).toBe("zh-Hans");
  });

  it("keeps a pick for the user, so every client of theirs follows; Automatic forgets it", async () => {
    const gateway = pageGateway();
    const vm = await chat({ automaticLanguage: "en" }, gateway);
    await vm.initialize();
    await vm.setLanguage("es");
    expect(gateway.languageOf("user@example.com")).toBe("es");
    expect(vm.agent.profile.user.language).toBe("es");
    await vm.setLanguage(AUTOMATIC_LANGUAGE);
    expect(gateway.languageOf("user@example.com")).toBeNull();
  });

  it("leaves the language as it is for one it does not offer, one fixed, or a pick made while it started", async () => {
    const italian = await chat({ automaticLanguage: "de" }, pageGateway("it"));
    await italian.initialize();
    expect([italian.language, italian.strings.language]).toEqual([AUTOMATIC_LANGUAGE, "de"]);

    const gateway = pageGateway("fr");
    const locked = await chat({ lockedLanguage: "de" }, gateway);
    await locked.initialize();
    await locked.setLanguage("es");
    expect([locked.strings.language, gateway.languageOf("user@example.com")]).toEqual(["de", "fr"]);

    const early = await chat({ automaticLanguage: "en" }, pageGateway("fr"));
    await early.setLanguage("es");
    await early.initialize();
    expect(early.language).toBe("es");
  });

  it("still changes the language when the server cannot keep it", async () => {
    const gateway = pageGateway();
    let down = false;
    const vm = await chat({ automaticLanguage: "en" }, gateway, async (input, init) =>
      down ? new Response("down", { status: 503 }) : gateway.fetch(input, init));
    await vm.initialize();
    down = true;
    await vm.setLanguage("de");
    expect([vm.language, vm.strings.language, vm.error]).toEqual(["de", "de", undefined]);
  });

  it("offers the host's own languages beside the built-in ones", async () => {
    const italian: UiStrings = { ...englishStrings, language: "it", languageName: "Italiano", send: "Invia" };
    const vm = await chat({ languages: { ...builtInStrings, it: italian }, automaticLanguage: "en" });
    expect(vm.languageOptions.map((o) => o.label)).toContain("Italiano");
    await vm.setLanguage("it");
    expect([vm.strings.send, vm.strings.language]).toEqual(["Invia", "it"]);
  });
});
