// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { ChatRetentionSettingsViewModel, builtInStrings } from "@fadenstack/ui";
import { ChatRetentionSettings } from "@fadenstack/ui-vue";

import { FakeSource, STATES } from "../../ui/test/chatRetentionFakes.js";

// The same checks as @fadenstack/ui-react's chatRetention.test.tsx, on the Vue skin (parity), over the real view model.

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
});

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;
const NAMES = Object.keys(STATES) as (keyof typeof STATES)[];

function show(state: keyof typeof STATES, language: string = "en") {
  const source = new FakeSource(STATES[state]);
  const strings = builtInStrings[language]!;
  const vm = new ChatRetentionSettingsViewModel({ source, strings: () => strings });
  const wrapper = mount(ChatRetentionSettings, { props: { settings: vm }, attachTo: document.body });
  wrappers.push(wrapper);
  return { source, vm, strings, wrapper };
}

const byLabel = (wrapper: VueWrapper, text: string): HTMLInputElement => {
  const label = [...wrapper.element.querySelectorAll("label")].find((l) => l.textContent === text)!;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
};

describe("the setting for old chats (Vue)", () => {
  describe.each(LANGUAGES)("in %s", (language) => {
    it.each(NAMES)("draws the %s state", (state) => {
      const { strings, wrapper } = show(state, language);
      const governed = state.startsWith("organisation");
      const policy = state === "policy";
      expect(wrapper.find("h2").text()).toBe(strings.chatRetentionTitle);
      expect(wrapper.find(".fdn-wizard").attributes("lang")).toBe(strings.language);
      expect(wrapper.find("[role=switch]").exists()).toBe(!governed);
      if (!governed) {
        const toggle = wrapper.find<HTMLInputElement>("[role=switch]").element;
        expect(toggle.disabled).toBe(policy);
        expect(toggle.checked).toBe(state !== "person-off");
        expect(byLabel(wrapper, strings.chatRetentionMaxAge).disabled).toBe(state !== "person");
        expect(byLabel(wrapper, strings.chatRetentionMaxSessions)).toBeTruthy();
        expect(wrapper.find(`button[aria-label="${strings.chatRetentionSaveName}"]`).exists()).toBe(!policy);
      }
      expect(wrapper.find(".fdn-wizard-note[role=status]").exists()).toBe(governed || policy);
    });
  });

  it("typing a bad number shows the error and stops Save; a good one lets Save save", async () => {
    const { source, strings, wrapper } = show("person");
    const save = wrapper.find<HTMLButtonElement>(`button[aria-label="${strings.chatRetentionSaveName}"]`);
    expect(save.element.disabled).toBe(true);
    const days = wrapper.findAll<HTMLInputElement>("input[inputmode=numeric]")[0]!;

    await days.setValue("0");
    expect(wrapper.find("[role=alert]").text()).toContain("3650");
    expect(days.attributes("aria-invalid")).toBe("true");
    expect(save.element.disabled).toBe(true);

    await days.setValue("30");
    expect(wrapper.find("[role=alert]").exists()).toBe(false);
    expect(save.element.disabled).toBe(false);
    await save.trigger("click");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(source.saved).toEqual([{ autoDelete: true, maxAgeDays: 30, maxSessions: 50 }]);
    expect(wrapper.text()).toContain(strings.chatRetentionSaved);
  });

  it("the switch turns the fields off, and Cancel puts things back", async () => {
    const { strings, wrapper } = show("person");
    const toggle = wrapper.find<HTMLInputElement>("[role=switch]");
    await toggle.setValue(false);
    expect(toggle.element.checked).toBe(false);
    expect(byLabel(wrapper, strings.chatRetentionMaxAge).disabled).toBe(true);
    await wrapper.find(`button[aria-label="${strings.chatRetentionCancelName}"]`).trigger("click");
    expect(toggle.element.checked).toBe(true);
    expect(byLabel(wrapper, strings.chatRetentionMaxAge).disabled).toBe(false);
  });

  it("every control has a name, and a button's name says what the button says", () => {
    const { wrapper } = show("person", "de");
    for (const control of wrapper.element.querySelectorAll("input, button")) {
      const name = control.getAttribute("aria-label") ?? wrapper.element.querySelector(`label[for="${control.id}"]`)?.textContent ?? control.textContent;
      expect((name ?? "").trim().length).toBeGreaterThan(0);
      if (control.tagName === "BUTTON") expect(name!.toLowerCase()).toContain(control.textContent!.toLowerCase());
    }
  });

  it("says the governed sentence in the language of the texts", () => {
    const { wrapper } = show("organisation", "de");
    expect(wrapper.text()).toContain("Ihre Organisation behält auf diesem Gerät höchstens 30 Chats für 14 Tage.");
  });
});
