// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatRetentionSettingsViewModel, builtInStrings } from "@fadenstack/ui";
import { ChatRetentionSettings } from "@fadenstack/ui-react";

import { FakeSource, STATES } from "../../ui/test/chatRetentionFakes.js";

// The setting for old chats in the React skin, over the real view model: every state in the five languages, the names screen readers
// need, and the buttons that do what the view model says.

afterEach(() => cleanup());

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;
const NAMES = Object.keys(STATES) as (keyof typeof STATES)[];

function show(state: keyof typeof STATES, language: string = "en") {
  const source = new FakeSource(STATES[state]);
  const strings = builtInStrings[language]!;
  const vm = new ChatRetentionSettingsViewModel({ source, strings: () => strings });
  const view = render(<ChatRetentionSettings settings={vm} />);
  return { source, vm, strings, view };
}

describe("the setting for old chats (React)", () => {
  describe.each(LANGUAGES)("in %s", (language) => {
    it.each(NAMES)("draws the %s state", (state) => {
      const { strings, view } = show(state, language);
      const governed = state.startsWith("organisation");
      const policy = state === "policy";
      expect(screen.getByRole("heading", { name: strings.chatRetentionTitle })).toBeTruthy();
      expect(view.container.querySelector(".fdn-wizard")!.getAttribute("lang")).toBe(strings.language);
      expect(screen.queryByRole("switch") === null).toBe(governed);
      if (!governed) {
        expect(screen.getByLabelText(strings.chatRetentionMaxAge)).toBeTruthy();
        expect(screen.getByLabelText(strings.chatRetentionMaxSessions)).toBeTruthy();
        const toggle = screen.getByRole("switch") as HTMLInputElement;
        expect(toggle.disabled).toBe(policy);
        expect(toggle.checked).toBe(state !== "person-off");
        expect((screen.getByLabelText(strings.chatRetentionMaxAge) as HTMLInputElement).disabled).toBe(state !== "person");
        expect(screen.queryByRole("button", { name: strings.chatRetentionSaveName }) === null).toBe(policy);
      }
      expect(view.container.querySelector("[role=status].fdn-wizard-note") !== null).toBe(governed || policy);
      if (governed || policy) expect(view.container.querySelector("[role=status].fdn-wizard-note")!.textContent).toBe(state === "organisation" ? strings.chatRetentionOrganisationLimit(30, 14) : governed ? strings.chatRetentionDeviceLimit(50, 90) : strings.chatRetentionPolicyFixed);
    });
  });

  it("typing a bad number shows the error and stops Save; a good one lets Save save", async () => {
    const { source, strings } = show("person");
    const save = screen.getByRole("button", { name: strings.chatRetentionSaveName }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const days = screen.getByLabelText(strings.chatRetentionMaxAge) as HTMLInputElement;

    fireEvent.change(days, { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toContain("3650");
    expect(days.getAttribute("aria-invalid")).toBe("true");
    expect(save.disabled).toBe(true);

    fireEvent.change(days, { target: { value: "30" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(save.disabled).toBe(false);
    await act(async () => { fireEvent.click(save); });

    expect(source.saved).toEqual([{ autoDelete: true, maxAgeDays: 30, maxSessions: 50 }]);
    expect(screen.getByText(strings.chatRetentionSaved)).toBeTruthy();
  });

  it("the switch turns the fields off, and Cancel puts things back", () => {
    const { strings } = show("person");
    const toggle = screen.getByRole("switch") as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect((screen.getByLabelText(strings.chatRetentionMaxAge) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: strings.chatRetentionCancelName }));
    expect(toggle.checked).toBe(true);
    expect((screen.getByLabelText(strings.chatRetentionMaxAge) as HTMLInputElement).disabled).toBe(false);
  });

  it("every control has a name, and a button's name says what the button says", () => {
    const { view } = show("person", "de");
    for (const control of view.container.querySelectorAll("input, button")) {
      const name = control.getAttribute("aria-label") ?? view.container.querySelector(`label[for="${control.id}"]`)?.textContent ?? control.textContent;
      expect((name ?? "").trim().length).toBeGreaterThan(0);
      if (control.tagName === "BUTTON") expect(name!.toLowerCase()).toContain(control.textContent!.toLowerCase());
    }
  });

  it("says the governed sentence in the language of the texts", () => {
    show("organisation", "de");
    expect(screen.getByText("Ihre Organisation behält auf diesem Gerät höchstens 30 Chats für 14 Tage.")).toBeTruthy();
  });
});
