import { describe, expect, it } from "vitest";

import { FadenstackAgent, MachinePolicy, MemorySessionStore } from "@fadenstack/agents";
import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FakeGateway } from "@fadenstack/testing";
import {
  AgentChatViewModel, ApprovalBroker, ContentLoggingBandViewModel, ContentLoggingSettingsViewModel, MemoryClipboard, builtInStrings, contentLoggingTime,
  englishStrings, germanStrings, immediateScheduler, type UiStrings,
} from "@fadenstack/ui";

import { FakeContentLogging } from "./contentLoggingFakes.js";
import { testServices } from "./services.js";

// Content logging's setting and band (8.1): only when offered and allowed, a time to choose, the end time, Start and Stop.

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;
const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime(); // local noon

describe("the content logging setting", () => {
  it("offers one hour, four hours and a day and starts with one hour", () => {
    const source = new FakeContentLogging(true);
    const vm = new ContentLoggingSettingsViewModel({ source });

    expect(vm.isAvailable).toBe(true);
    expect(vm.choices.map((c) => c.text)).toEqual(["1 hour", "4 hours", "24 hours"]);
    expect(vm.choices.map((c) => c.durationMs)).toEqual([HOUR, 4 * HOUR, 24 * HOUR]);
    expect(vm.selectedIndex).toBe(0);
    expect(vm.introText).toBe(englishStrings.contentLoggingIntro);
    expect(vm.introText).toContain("logs");
    expect(vm.introText).toContain("by itself");
    expect([vm.canStart, vm.canStop, vm.onUntilText]).toEqual([true, false, ""]);
  });

  it("is not available when the app does not offer it or the policy forbids it", async () => {
    expect(new ContentLoggingSettingsViewModel({ source: new FakeContentLogging(false) }).isAvailable).toBe(false);

    const make = async (configure: (b: ReturnType<typeof FadenstackAgent.createBuilder>) => void) => {
      const gateway = new FakeGateway({ agents: [{ slug: "page" }] });
      const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
      await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
      const builder = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore());
      configure(builder);
      return builder.build();
    };
    const notOffered = await make(() => undefined);
    const forbidden = await make((b) => b.useHookContent().useMachinePolicy(MachinePolicy.fromJson('{"contentLogging":"forbidden"}')));
    const offered = await make((b) => b.useHookContent());
    expect(new ContentLoggingSettingsViewModel({ agent: notOffered }).isAvailable).toBe(false);
    expect(new ContentLoggingSettingsViewModel({ agent: forbidden }).isAvailable).toBe(false);
    expect(new ContentLoggingSettingsViewModel({ agent: offered }).isAvailable).toBe(true);
  });

  it("Start switches it on for the chosen time and says until when; Stop switches it off", () => {
    const source = new FakeContentLogging(true);
    const vm = new ContentLoggingSettingsViewModel({ source, now: () => NOW });
    let told = 0;
    vm.subscribe(() => { told += 1; });

    vm.selectedIndex = 1;
    vm.start();

    expect(source.started).toEqual([4 * HOUR]);
    expect([vm.isOn, vm.canStart, vm.canStop]).toEqual([true, false, true]);
    expect(vm.onUntilText).toBe(englishStrings.contentLoggingOnUntil(contentLoggingTime(source.until!, NOW, "en")));
    expect(told).toBeGreaterThan(0);
    vm.start(); // on already: nothing more
    expect(source.started).toHaveLength(1);

    vm.stop();
    expect([vm.isOn, vm.onUntilText, vm.canStart]).toEqual([false, "", true]);
  });

  it("says an end that is not today with its date", () => {
    const today = contentLoggingTime(NOW + HOUR, NOW, "en");
    const later = contentLoggingTime(NOW + 30 * HOUR, NOW, "en");
    expect(today).toBe(new Date(NOW + HOUR).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" }));
    expect(later).toBe(new Date(NOW + 30 * HOUR).toLocaleString("en", { dateStyle: "short", timeStyle: "short" }));
    expect(later.length).toBeGreaterThan(today.length);
  });

  it("follows a change of the source (it ends by itself)", () => {
    const source = new FakeContentLogging(true, true, NOW + HOUR);
    const vm = new ContentLoggingSettingsViewModel({ source });
    let told = 0;
    vm.subscribe(() => { told += 1; });

    source.endByItself();

    expect(told).toBe(1);
    expect(vm.isOn).toBe(false);
  });

  it("says its texts again in a new language and keeps the choice", () => {
    let language: UiStrings = englishStrings;
    const vm = new ContentLoggingSettingsViewModel({ source: new FakeContentLogging(true), strings: () => language });
    vm.selectedIndex = 2;
    language = germanStrings;
    vm.retext();
    expect(vm.choices.map((c) => c.text)).toEqual(["1 Stunde", "4 Stunden", "24 Stunden"]);
    expect(vm.choices[vm.selectedIndex]!.text).toBe("24 Stunden");
    expect(vm.introText).toBe(germanStrings.contentLoggingIntro);
  });

  it("stops watching the source when it is disposed", () => {
    const source = new FakeContentLogging(true);
    const vm = new ContentLoggingSettingsViewModel({ source });
    let told = 0;
    vm.subscribe(() => { told += 1; });
    vm.dispose();
    source.start(HOUR);
    expect(told).toBe(0);
  });
});

describe("the content logging band", () => {
  it("shows only while it is on, says until when, and Stop switches it off", () => {
    const source = new FakeContentLogging(true);
    const band = new ContentLoggingBandViewModel({ source, now: () => NOW });
    expect([band.isShown, band.text]).toEqual([false, ""]);

    source.start(HOUR);

    expect(band.isShown).toBe(true);
    expect(band.text).toBe(`Content logging is on until ${contentLoggingTime(source.until!, NOW, "en")}. Prompts and answers are written to the app's logs.`);
    expect([band.stopText, band.stopName]).toEqual(["Stop", "Stop content logging"]);

    band.stop();
    expect(source.stops).toBe(1);
    expect(band.isShown).toBe(false);
  });

  it("goes when the time runs out", () => {
    const source = new FakeContentLogging(true, true, NOW + HOUR);
    const band = new ContentLoggingBandViewModel({ source });
    let told = 0;
    band.subscribe(() => { told += 1; });
    source.endByItself();
    expect([told, band.isShown]).toEqual([1, false]);
  });

  it("is on the chat and follows the agent", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant" }], model: () => ({ text: "ok" }) });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const approvals = new ApprovalBroker();
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).useHookContent().build();
    const chat = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, clipboard: new MemoryClipboard() });

    expect(chat.contentLogging.isShown).toBe(false); // offered is not on
    agent.startContentLogging(HOUR);
    expect(chat.contentLogging.isShown).toBe(true);
    expect(chat.contentLogging.text.startsWith("Content logging is on until ")).toBe(true);
    chat.contentLogging.stop();
    expect(agent.contentLogging.isOn).toBe(false);
    expect(chat.contentLogging.isShown).toBe(false);
    chat.dispose();
  });
});

describe("the texts of content logging", () => {
  const keys = ["contentLoggingTitle", "contentLoggingIntro", "contentLoggingDuration", "contentLoggingOneHour", "contentLoggingFourHours",
    "contentLoggingDay", "contentLoggingStart", "contentLoggingStartName", "contentLoggingStopName", "markerStop"] as const;

  it.each(LANGUAGES)("are all there in %s, filled in, with no placeholder left", (language) => {
    const s = builtInStrings[language]!;
    for (const key of keys) expect(s[key].length, `${language}: ${key}`).toBeGreaterThan(0);
    for (const text of [s.contentLoggingBand("14:30"), s.contentLoggingOnUntil("14:30")]) {
      expect(text).not.toMatch(/[{}]|undefined/);
      expect(text).toContain("14:30");
    }
    // WCAG 2.5.3: the accessible name of a button contains what the button says.
    expect(s.contentLoggingStopName.toLowerCase()).toContain(s.markerStop.toLowerCase());
    expect(s.contentLoggingStartName.toLowerCase()).toContain(s.contentLoggingStart.toLowerCase());
  });

  it.each(LANGUAGES.filter((l) => l !== "en"))("are translated in %s, not left in English", (language) => {
    const s = builtInStrings[language]!;
    for (const key of keys.filter((k) => !["markerStop"].includes(k))) {
      expect(s[key], `${language}: ${key} is English`).not.toBe(englishStrings[key]);
    }
  });
});
