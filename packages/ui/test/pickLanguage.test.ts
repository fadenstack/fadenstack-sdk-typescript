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

async function chat(options: AgentChatOptions = {}) {
  const gateway = new FakeGateway({
    agents: [{ slug: "page", name: "Seitenhelfer", contract: [{ name: "read_page", risk: "read" }] }],
    model: (r) => lastToolResults(r).size
      ? { text: "Fertig.", events: [{ type: "CUSTOM", name: "faden.pii", value: { entities: { PERSON: 2 } } }] }
      : { toolCalls: [{ name: "read_page" }] },
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .addTools(defineTool({ name: "read_page", toolClass: "read", run: () => "The page text." })).build();
  return new AgentChatViewModel(agent, approvals, { scheduler: immediateScheduler, preferences: new MemoryPreferenceStore(), ...options });
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

  it("offers the host's own languages beside the built-in ones", async () => {
    const italian: UiStrings = { ...englishStrings, language: "it", languageName: "Italiano", send: "Invia" };
    const vm = await chat({ languages: { ...builtInStrings, it: italian }, automaticLanguage: "en" });
    expect(vm.languageOptions.map((o) => o.label)).toContain("Italiano");
    await vm.setLanguage("it");
    expect([vm.strings.send, vm.strings.language]).toEqual(["Invia", "it"]);
  });
});
