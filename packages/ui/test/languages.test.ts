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
  minutesAndSeconds,
  stringsFor,
  withStrings,
  type UiStrings,
} from "@fadenstack/ui";
import { FakeGateway } from "@fadenstack/testing";
import { testServices } from "./services.js";

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
      // Every text is translated, not left in English (a word may be the same in both, like "Source": French has it three times, as the .NET texts do; German keeps the loanwords Skills, Skill, Chat and Tools).
      const same = Object.keys(englishStrings).filter((key) => {
        const a = englishStrings[key as keyof UiStrings], b = strings[key as keyof UiStrings];
        return typeof a === "string" && a === b && key !== "direction";
      });
      expect(same.length, `${tag}: ${same.join(", ")}`).toBeLessThanOrEqual(17); // 6 as the .NET test allows, and the report mail's five labels that are the same word in German (App, SDK, System, Agent, Server), and the Tools view's "Name" (twice in German) and its row of dots, which are no words: the wizard's example address "https://…/v1" is no word; and the three product names of the web search sheet (Brave, Brave Search, SearXNG)
    }
  });
});

describe("the connection wizard's texts", () => {
  const wizardKeys = Object.keys(englishStrings).filter((key) => key.startsWith("wizard"));
  const SENTINEL = "§x§";
  /** What a text says for a sentinel (or a countdown of 9:41), whatever shape the text has. */
  const said = (strings: UiStrings, key: string): string | Record<string, string> => {
    const value = (strings as unknown as Record<string, unknown>)[key];
    if (typeof value === "function") return (value as (arg: unknown) => string)(key.startsWith("wizardWaiting") ? 580_500 : SENTINEL);
    return value as string | Record<string, string>;
  };

  it("has 137 texts: 106 members and the 31 values of four enum-keyed ones", () => {
    let count = 0;
    for (const key of wizardKeys) {
      const value = said(englishStrings, key);
      count += typeof value === "string" ? 1 : Object.keys(value).length;
    }
    expect(wizardKeys).toHaveLength(110);
    expect(count).toBe(137);
  });

  it.each(Object.entries(builtInStrings))("%s has every wizard text, and its placeholders are English's", (tag, strings) => {
    expect(wizardKeys.filter((key) => (strings as unknown as Record<string, unknown>)[key] === undefined)).toEqual([]);
    for (const key of wizardKeys) {
      const mine = said(strings, key), english = said(englishStrings, key);
      if (typeof english === "string") {
        expect(typeof mine, `${tag} ${key}`).toBe("string");
        expect((mine as string).trim(), `${tag} ${key}`).not.toBe("");
        // the argument, or the countdown, appears as often as it does in English
        const filled = key.startsWith("wizardWaiting") ? "9:41" : SENTINEL;
        expect((mine as string).split(filled).length, `${tag} ${key}`).toBe(english.split(filled).length);
        expect(mine as string, `${tag} ${key}`).not.toMatch(/\{\d\}|[\u200B\u2060\uFEFF]/);
      } else {
        expect(Object.keys(mine as Record<string, string>).sort(), `${tag} ${key}`).toEqual(Object.keys(english).sort());
        for (const [value, text] of Object.entries(mine as Record<string, string>)) {
          expect(text.trim(), `${tag} ${key}.${value}`).not.toBe("");
          expect(text, `${tag} ${key}.${value}`).not.toMatch(/\{\d\}|[\u200B\u2060\uFEFF]/);
        }
      }
    }
  });

  it("counts down as m:ss, rounded up and never below zero", () => {
    expect(minutesAndSeconds(581_000)).toBe("9:41");
    expect(minutesAndSeconds(580_100)).toBe("9:41");
    expect(minutesAndSeconds(600_000)).toBe("10:00");
    expect(minutesAndSeconds(5_000)).toBe("0:05");
    expect(minutesAndSeconds(-3_000)).toBe("0:00");
    expect(englishStrings.wizardWaiting(581_000)).toBe("Waiting for your approval… The code expires in 9:41.");
    expect(germanStrings.wizardWaitingRetry(0)).toContain("0:00");
  });

  it("keeps the French no-break spaces and a host's partial override of an enum-keyed text", () => {
    expect(builtInStrings["fr"]!.wizardChooseTitle("X")).toContain("\u00A0");
    const changed = withStrings({ wizardProblem: { KeyRejected: "Nein." } as UiStrings["wizardProblem"] }, germanStrings);
    expect(changed.wizardProblem.KeyRejected).toBe("Nein.");
    expect(changed.wizardProblem.Unreachable).toBe(germanStrings.wizardProblem.Unreachable);
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
    const vm = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, strings: stringsFor("de-DE"), locale: "de-DE" });
    await vm.initialize();
    expect(vm.greeting).toBe("Was möchten Sie Seitenhelfer fragen?");
    expect(vm.toolModes.map((o) => o.label)).toEqual(["Aus", "Nur lesen", "Nachfragen", "Automatisch"]);
    await vm.send("Hallo");
    expect(vm.sessions[0]!.title).toBe("Hallo");
  });
});

describe("the thinking pill's texts", () => {
  it("are in no skin: the pill, its menu and the slot line take every word from the chat's strings", async () => {
    const { readFileSync } = await import("node:fs");
    const files = ["ui-react/src/ReasoningMenu.tsx", "ui-vue/src/ReasoningMenu.vue", "ui-react/src/Turn.tsx", "ui-vue/src/TurnView.vue"]
      .map((f) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"));
    const words = [englishStrings.reasoningMenu, englishStrings.waitingForSlot, ...Object.values(englishStrings.reasoningLabel),
      ...Object.values(englishStrings.reasoningDescription), englishStrings.reasoningPill("")];
    for (const word of words) for (const source of files) {
      expect(source).not.toContain(`>${word}<`);
      expect(source).not.toContain(`"${word}"`);
    }
  });
});

describe("the approval texts", () => {
  it("are in no skin: the cards, markers and Settings section take every word from the chat's strings", async () => {
    const { readFileSync } = await import("node:fs");
    const files = ["ui-react/src/Grants.tsx", "ui-vue/src/GrantsBar.vue", "ui-vue/src/GrantMarker.vue", "ui-vue/src/ApprovalsSection.vue",
      "ui-vue/src/parts/GrantCardView.vue", "ui-vue/src/parts/BypassCardView.vue"]
      .map((f) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"));
    const words = [englishStrings.grantNotNow, englishStrings.bypassAllow, englishStrings.markerStop, englishStrings.revoke,
      englishStrings.bypassOpenAgain, englishStrings.grantAllow, englishStrings.settingsApprovals, englishStrings.bypassSwitchOnAgain];
    for (const word of words) for (const source of files) expect(source).not.toContain(`>${word}<`);
  });
});

describe("the unmarked-answer setting", () => {
  it("has no English text in a skin", async () => {
    const { readFileSync } = await import("node:fs");
    const files = ["ui-react/src/Header.tsx", "ui-vue/src/SettingsMenu.vue"].map((f) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"));
    for (const word of [englishStrings.settingsUnmarked, englishStrings.unmarkedTitle, englishStrings.unmarkedMessage]) {
      for (const source of files) expect(source).not.toContain(word);
    }
  });
});
