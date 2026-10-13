import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import {
  AgentChatViewModel,
  ApprovalBroker,
  builtInStrings,
  englishStrings,
  germanStrings,
  immediateScheduler,
  stringsFor,
  withStrings,
  type UiStrings,
} from "@fadenstack/ui";
import { FakeGateway } from "@fadenstack/testing";

describe("stringsFor", () => {
  it.each([
    ["de", "de"], ["de-AT", "de"], ["de_DE", "de"], ["DE-ch", "de"], ["fr-CA", "fr"], ["es-419", "es"],
    ["zh", "zh-Hans"], ["zh-CN", "zh-Hans"], ["zh-Hans-SG", "zh-Hans"], ["en-GB", "en"],
  ])("gives %s the %s texts", (locale, language) => {
    expect(stringsFor(locale).language).toBe(language);
  });

  it("takes the first locale it has texts for, and English when it has none", () => {
    expect(stringsFor(["pt-BR", "fr-FR", "de"]).language).toBe("fr");
    expect(stringsFor(["pt-BR", "ja"]).language).toBe("en");
    expect(stringsFor("zh-TW").language).toBe("en"); // Traditional is not the Simplified script
    expect(stringsFor(["", "not a tag!"]).language).toBe("en");
  });

  it("takes a host's own languages", () => {
    const italian: UiStrings = { ...englishStrings, language: "it", send: "Invia" };
    expect(stringsFor("it-IT", { ...builtInStrings, it: italian }).send).toBe("Invia");
    expect(stringsFor("it-IT").language).toBe("en");
  });

  it("ships every language complete, with its own words", () => {
    for (const [tag, strings] of Object.entries(builtInStrings)) {
      expect(strings.language).toBe(tag);
      expect(Object.keys(strings).sort()).toEqual(Object.keys(englishStrings).sort());
      if (tag === "en") continue;
      // Every text is translated, not left in English (a word may be the same in both, like "Source").
      const same = Object.keys(englishStrings).filter((key) => {
        const a = englishStrings[key as keyof UiStrings], b = strings[key as keyof UiStrings];
        return typeof a === "string" && a === b && key !== "direction";
      });
      expect(same.length, `${tag}: ${same.join(", ")}`).toBeLessThanOrEqual(2);
    }
  });
});

describe("withStrings", () => {
  it("completes a partial set from English, or from another language, key by key", () => {
    expect(withStrings({ send: "Go" }).stop).toBe("Stop");
    const changed = withStrings({ approvalWhy: { destructive: "Einzeln freigeben." } as UiStrings["approvalWhy"] }, germanStrings);
    expect(changed.approvalWhy.destructive).toBe("Einzeln freigeben.");
    expect(changed.approvalWhy.read).toBe(germanStrings.approvalWhy.read);
    expect(changed.send).toBe("Senden");
  });
});

describe("a chat in German", () => {
  it("names its modes, greets and dates in German", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Seitenhelfer" }], model: () => ({ text: "ok" }) });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const approvals = new ApprovalBroker();
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
    const vm = new AgentChatViewModel(agent, approvals, { scheduler: immediateScheduler, strings: stringsFor("de-DE"), locale: "de-DE" });
    await vm.initialize();
    expect(vm.greeting).toBe("Was möchten Sie Seitenhelfer fragen?");
    expect(vm.toolModes.map((o) => o.label)).toEqual(["Aus", "Nur lesen", "Nachfragen", "Automatisch"]);
    await vm.send("Hallo");
    expect(vm.sessions[0]!.title).toBe("Hallo");
  });
});
