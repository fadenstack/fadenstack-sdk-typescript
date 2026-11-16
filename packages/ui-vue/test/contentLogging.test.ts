// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import {
  AgentChatViewModel, ApprovalBroker, ContentLoggingBandViewModel, ContentLoggingSettingsViewModel, MemoryClipboard, builtInStrings, immediateScheduler,
} from "@fadenstack/ui";
import { ChatPanel, ContentLoggingBand, ContentLoggingSettings } from "@fadenstack/ui-vue";
import { FakeGateway } from "@fadenstack/testing";

import { FakeContentLogging, STATES } from "../../ui/test/contentLoggingFakes.js";
import { testServices } from "./helpers.js";

// The same checks as @fadenstack/ui-react's contentLogging.test.tsx, on the Vue skin (parity), over the real view models.

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
});

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;
const NAMES = Object.keys(STATES) as (keyof typeof STATES)[];

function show(state: keyof typeof STATES, language: string = "en") {
  const source = STATES[state]();
  const strings = builtInStrings[language]!;
  const vm = new ContentLoggingSettingsViewModel({ source, strings: () => strings });
  const wrapper = mount(ContentLoggingSettings, { props: { settings: vm }, attachTo: document.body });
  wrappers.push(wrapper);
  return { source, vm, strings, wrapper };
}

describe("the content logging setting (Vue)", () => {
  describe.each(LANGUAGES)("in %s", (language) => {
    it.each(NAMES)("draws the %s state", (state) => {
      const { strings, wrapper, vm } = show(state, language);
      if (state === "unavailable") {
        expect(wrapper.text()).toBe("");
        return;
      }
      expect(wrapper.find("h2").text()).toBe(strings.contentLoggingTitle);
      expect(wrapper.find(".fdn-wizard").attributes("lang")).toBe(strings.language);
      expect(wrapper.text()).toContain(strings.contentLoggingIntro);
      const label = [...wrapper.element.querySelectorAll("label")].find((l) => l.textContent === strings.contentLoggingDuration)!;
      const select = document.getElementById(label.htmlFor) as HTMLSelectElement;
      expect([...select.options].map((o) => o.text)).toEqual([strings.contentLoggingOneHour, strings.contentLoggingFourHours, strings.contentLoggingDay]);
      expect(select.disabled).toBe(state === "on");
      expect(wrapper.find<HTMLButtonElement>(`button[aria-label="${strings.contentLoggingStartName}"]`).element.disabled).toBe(state === "on");
      expect(wrapper.find<HTMLButtonElement>(`button[aria-label="${strings.contentLoggingStopName}"]`).element.disabled).toBe(state === "off");
      expect(wrapper.find("[role=status]").text()).toBe(state === "on" ? vm.onUntilText : "");
    });
  });

  it("Start switches it on for the chosen time and Stop switches it off", async () => {
    const { source, strings, wrapper } = show("off");
    const select = wrapper.find("select");
    (select.element as HTMLSelectElement).value = "1";
    await select.trigger("change");
    await wrapper.find(`button[aria-label="${strings.contentLoggingStartName}"]`).trigger("click");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(source.started).toEqual([4 * 60 * 60 * 1000]);
    expect(wrapper.find<HTMLButtonElement>(`button[aria-label="${strings.contentLoggingStopName}"]`).element.disabled).toBe(false);
    expect(wrapper.find("[role=status]").text()).toMatch(/^On until /);

    await wrapper.find(`button[aria-label="${strings.contentLoggingStopName}"]`).trigger("click");
    expect(source.stops).toBe(1);
    expect(wrapper.find("[role=status]").text()).toBe("");
  });
});

describe("the content logging band (Vue)", () => {
  it("is not there while off; while on it says until when and Stop ends it", async () => {
    const source = new FakeContentLogging(true);
    const band = new ContentLoggingBandViewModel({ source });
    const wrapper = mount(ContentLoggingBand, { props: { band }, attachTo: document.body });
    wrappers.push(wrapper);
    expect(wrapper.text()).toBe("");

    source.start(60 * 60 * 1000);
    await flushPromises();
    const strings = builtInStrings.en!;
    expect(wrapper.find("[role=status]").text()).toBe(band.text + strings.markerStop);
    expect(band.text.startsWith("Content logging is on until ")).toBe(true);
    const stop = wrapper.find(`button[aria-label="${strings.contentLoggingStopName}"]`);
    expect(stop.text()).toBe("Stop");

    await stop.trigger("click");
    expect(source.stops).toBe(1);
    expect(wrapper.text()).toBe("");
  });

  it("says its texts in every language", () => {
    for (const language of LANGUAGES) {
      const source = new FakeContentLogging(true, true, Date.now() + 3600000);
      const strings = builtInStrings[language]!;
      const band = new ContentLoggingBandViewModel({ source, strings: () => strings });
      const wrapper = mount(ContentLoggingBand, { props: { band }, attachTo: document.body });
      expect(wrapper.find(`button[aria-label="${strings.contentLoggingStopName}"]`).text()).toBe(strings.markerStop);
      expect(wrapper.text()).toContain(band.text);
      wrapper.unmount();
    }
  });
});

describe("the content logging band in the chat panel (Vue)", () => {
  it("shows above the composer while content logging is on, and its Stop ends it", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant" }], model: () => ({ text: "ok" }) });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const approvals = new ApprovalBroker();
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).useHookContent().build();
    const chat = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, clipboard: new MemoryClipboard() });
    await chat.initialize();
    const wrapper = mount(ChatPanel, { props: { chat }, attachTo: document.body });
    wrappers.push(wrapper);
    await flushPromises();
    expect(wrapper.find(".fdn-content-logging-band").exists()).toBe(false); // offered is not on

    agent.startContentLogging(60 * 60 * 1000);
    await flushPromises();
    const band = wrapper.find(".fdn-content-logging-band");
    expect(band.text()).toContain("Prompts and answers are written to the app's logs.");
    expect(band.element.compareDocumentPosition(wrapper.find(".fdn-composer").element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await wrapper.find('button[aria-label="Stop content logging"]').trigger("click");
    await flushPromises();
    expect(agent.contentLogging.isOn).toBe(false);
    expect(wrapper.find(".fdn-content-logging-band").exists()).toBe(false);
  });
});
