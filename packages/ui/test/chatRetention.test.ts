import { describe, expect, it } from "vitest";

import type { ChatRetentionState } from "@fadenstack/agents";
import { ChatRetentionSettingsViewModel, builtInStrings, englishStrings, germanStrings, type UiStrings } from "@fadenstack/ui";

import { FakeSource, STATES } from "./chatRetentionFakes.js";

// The setting for old chats (.NET: ChatRetentionSettingsViewModelTests.cs): the person's form, and what the organisation or the machine
// policy fixes.

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;

const model = (state: ChatRetentionState, strings: UiStrings = englishStrings) => {
  const source = new FakeSource(state);
  return { source, vm: new ChatRetentionSettingsViewModel({ source, strings: () => strings }) };
};

describe("the setting for old chats", () => {
  it("shows the defaults in standalone, with nothing to save", async () => {
    const { vm } = model(STATES.person);
    await vm.load();
    expect([vm.autoDelete, vm.maxAgeDaysText, vm.maxSessionsText]).toEqual([true, "90", "50"]);
    expect([vm.canEdit, vm.showControls, vm.showNote, vm.limitsEnabled]).toEqual([true, true, false, true]);
    expect([vm.canSave, vm.canCancel]).toEqual([false, false]);
  });

  it("saves a change and shows Saved until the next change", async () => {
    const { vm, source } = model(STATES.person);
    vm.maxAgeDaysText = "30";
    vm.maxSessionsText = " 20 ";
    expect([vm.isDirty, vm.canSave]).toEqual([true, true]);
    await vm.save();
    expect(source.saved).toEqual([{ autoDelete: true, maxAgeDays: 30, maxSessions: 20 }]);
    expect(vm.statusText).toBe("Saved.");
    expect(vm.isDirty).toBe(false);
    vm.maxSessionsText = "21";
    expect(vm.statusText).toBe("");
  });

  it("keeps the limits it had when it saves with the switch off, without checking what was typed", async () => {
    const { vm, source } = model(STATES.person);
    vm.maxAgeDaysText = "nonsense";
    expect(vm.hasDaysError).toBe(true);
    vm.autoDelete = false;
    expect([vm.limitsEnabled, vm.hasDaysError, vm.canSave]).toEqual([false, false, true]);
    await vm.save();
    expect(source.saved).toEqual([{ autoDelete: false, maxAgeDays: 90, maxSessions: 50 }]);
    expect(vm.maxAgeDaysText).toBe("90");
  });

  it.each([["0", "50"], ["3651", "50"], ["-5", "50"], ["1.5", "50"], ["", "50"], ["ten", "50"], ["90", "0"], ["90", "10001"], ["1e2", "50"]])(
    "cannot save %j days and %j chats", (days, chats) => {
      const { vm } = model(STATES.person);
      vm.maxAgeDaysText = days;
      vm.maxSessionsText = chats;
      expect([vm.isValid, vm.canSave]).toEqual([false, false]);
      expect(vm.hasDaysError || vm.hasChatsError).toBe(true);
      expect(vm.daysError + vm.chatsError).toMatch(/days from 1 to 3650|chats from 1 to 10000/);
    });

  it("accepts the bounds", () => {
    const { vm } = model(STATES.person);
    vm.maxAgeDaysText = "1";
    vm.maxSessionsText = "10000";
    expect(vm.canSave).toBe(true);
    vm.maxAgeDaysText = "3650";
    expect(vm.canSave).toBe(true);
  });

  it("Cancel puts back what is kept", () => {
    const { vm } = model(STATES.person);
    vm.autoDelete = false;
    vm.maxAgeDaysText = "7";
    vm.cancel();
    expect([vm.autoDelete, vm.maxAgeDaysText, vm.isDirty]).toEqual([true, "90", false]);
  });

  it("governed is read only and says what the organisation keeps", () => {
    const { vm } = model(STATES.organisation);
    expect([vm.isReadOnly, vm.canEdit, vm.showControls, vm.showNote]).toEqual([true, false, false, true]);
    expect(vm.note).toBe("Your organisation keeps at most 30 chats for 14 days on this device.");
    vm.autoDelete = false;
    vm.maxAgeDaysText = "5";
    expect([vm.autoDelete, vm.maxAgeDaysText, vm.canSave]).toEqual([true, "14", false]);
    // Without a server limit the card states the app's limits, which still apply; in German too.
    expect(model(STATES["organisation-none"]).vm.note).toBe("This device keeps at most 50 chats for 90 days.");
    expect(model(STATES["organisation-none"], germanStrings).vm.note).toBe("Dieses Gerät behält höchstens 50 Chats für 90 Tage.");
    expect(model(STATES.organisation, germanStrings).vm.note).toBe("Ihre Organisation behält auf diesem Gerät höchstens 30 Chats für 14 Tage.");
  });

  it("the machine policy fixes it and the values are shown", () => {
    const { vm } = model(STATES.policy);
    expect([vm.isReadOnly, vm.showControls, vm.showNote, vm.limitsEnabled]).toEqual([true, true, true, false]);
    expect(vm.note).toBe("Set by your organisation's policy on this computer.");
    expect([vm.autoDelete, vm.maxAgeDaysText, vm.maxSessionsText]).toEqual([true, "30", "100"]);
    vm.autoDelete = false;
    vm.maxSessionsText = "5";
    expect([vm.autoDelete, vm.maxSessionsText, vm.canSave]).toEqual([true, "100", false]);
  });

  it("says its texts again in a new language on retext()", () => {
    let language: UiStrings = englishStrings;
    const source = new FakeSource(STATES.organisation);
    const vm = new ChatRetentionSettingsViewModel({ source, strings: () => language });
    let told = 0;
    vm.subscribe(() => { told += 1; });
    language = germanStrings;
    vm.retext();
    expect(told).toBe(1);
    expect(vm.note).toBe("Ihre Organisation behält auf diesem Gerät höchstens 30 Chats für 14 Tage.");
  });
});

describe("the texts of the setting", () => {
  const keys = ["chatRetentionTitle", "chatRetentionAutoDelete", "chatRetentionAutoDeleteHint", "chatRetentionMaxAge", "chatRetentionMaxSessions",
    "chatRetentionMaxAgeName", "chatRetentionMaxSessionsName", "chatRetentionSave", "chatRetentionCancel", "chatRetentionSaveName",
    "chatRetentionCancelName", "chatRetentionSaved", "chatRetentionPolicyFixed"] as const;

  it.each(LANGUAGES)("are all there in %s, filled in, with no placeholder left", (language) => {
    const s = builtInStrings[language]!;
    for (const key of keys) expect(s[key].length, `${language}: ${key}`).toBeGreaterThan(0);
    for (const text of [s.chatRetentionOrganisationLimit(30, 14), s.chatRetentionDeviceLimit(50, 90), s.chatRetentionDaysError(1, 3650), s.chatRetentionChatsError(1, 10000)]) {
      expect(text).not.toMatch(/[{}]|undefined/);
    }
    expect(s.chatRetentionOrganisationLimit(30, 14)).toContain("30");
    expect(s.chatRetentionOrganisationLimit(30, 14)).toContain("14");
    expect(s.chatRetentionDaysError(1, 3650)).toContain("3650");
    expect(s.chatRetentionChatsError(1, 10000)).toContain("10000");
    // WCAG 2.5.3: the accessible name of a button contains what the button says.
    expect(s.chatRetentionSaveName.toLowerCase()).toContain(s.chatRetentionSave.toLowerCase());
    expect(s.chatRetentionCancelName.toLowerCase()).toContain(s.chatRetentionCancel.toLowerCase());
  });

  it.each(LANGUAGES.filter((l) => l !== "en"))("are translated in %s, not left in English", (language) => {
    const s = builtInStrings[language]!;
    for (const key of keys.filter((k) => !["chatRetentionSave", "chatRetentionCancel"].includes(k))) {
      expect(s[key], `${language}: ${key} is English`).not.toBe(englishStrings[key]);
    }
  });
});
