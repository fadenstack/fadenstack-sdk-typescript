// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { MyDataSettingsViewModel, builtInStrings, type MyDataSaveRequest } from "@fadenstack/ui";
import { MyDataSettings } from "@fadenstack/ui-vue";

import { APP_A, APP_B, FakeMyData, type ScenarioName } from "../../ui/test/myDataFakes.js";

// The same checks as @fadenstack/ui-react's myData.test.tsx, on the Vue skin (parity), over the real view model.

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
});

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;

function show(scenario: ScenarioName, language: string = "en") {
  const source = new FakeMyData(scenario);
  const strings = builtInStrings[language]!;
  const vm = new MyDataSettingsViewModel({ source, strings: () => strings });
  const saved: MyDataSaveRequest[] = [];
  vm.onSaveRequest((r) => saved.push(r));
  const wrapper = mount(MyDataSettings, { props: { settings: vm }, attachTo: document.body });
  wrappers.push(wrapper);
  return { source, vm, strings, wrapper, saved };
}

const button = (wrapper: VueWrapper, name: string) => wrapper.find<HTMLButtonElement>(`button[aria-label="${name}"]`);
const press = async (wrapper: VueWrapper, name: string) => {
  await button(wrapper, name).trigger("click");
  await flushPromises();
};

describe("the Your data control (Vue)", () => {
  it("reads the record of tool calls when it is shown: an entry added after load() is counted", async () => {
    const source = new FakeMyData("alone").withAudit();
    source.verification = { intact: true, entries: 0 };
    const vm = new MyDataSettingsViewModel({ source, strings: () => builtInStrings.en! });
    await vm.load();
    source.verification = { intact: true, entries: 1, firstSeq: 1, firstTime: "2026-08-01T10:00:00.000Z" };
    const wrapper = mount(MyDataSettings, { props: { settings: vm }, attachTo: document.body });
    wrappers.push(wrapper);
    await flushPromises();
    expect(wrapper.find("[data-audit-line]").text()).toContain("1 entry");

    source.verification = { intact: true, entries: 2, firstSeq: 1, firstTime: "2026-08-01T10:00:00.000Z" };
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(wrapper.find("[data-audit-line]").text()).toContain("2 entries");
  });

  describe.each(LANGUAGES)("in %s", (language) => {
    it("draws the idle state with four named actions", () => {
      const { strings, wrapper } = show("others", language);
      expect(wrapper.find("h2").text()).toBe(strings.myDataTitle);
      expect(wrapper.find(".fdn-wizard").attributes("lang")).toBe(strings.language);
      for (const [visible, name] of [[strings.myDataExport, strings.myDataExportName], [strings.myDataRemove, strings.myDataRemoveName],
        [strings.myDataExportAll, strings.myDataExportAllName], [strings.myDataRemoveAll, strings.myDataRemoveAllName]] as const) {
        const b = button(wrapper, name);
        expect(b.text()).toBe(visible);
        expect(b.element.disabled).toBe(false);
        expect(name.toLowerCase()).toContain(visible.toLowerCase());
      }
      expect(wrapper.find("[role=alertdialog]").exists()).toBe(false);
    });

    it("asks for this app with other apps, and the dialog takes the focus on its safe answer", async () => {
      const { strings, wrapper } = show("shared-agent", language);
      await press(wrapper, strings.myDataRemoveName);
      const dialog = wrapper.find("[role=alertdialog]");
      expect(dialog.attributes("aria-labelledby")).toBeTruthy();
      expect(dialog.text()).toContain(APP_A);
      expect(dialog.text()).toContain(APP_B);
      expect(document.activeElement).toBe(button(wrapper, strings.myDataCancelName).element);
      expect(button(wrapper, strings.myDataConfirmRemoveName).text()).toBe(strings.myDataConfirmRemove);
      expect(button(wrapper, strings.myDataExportName).exists()).toBe(false);
    });

    it("asks for this app alone with the words for everything going", async () => {
      const { strings, wrapper } = show("alone", language);
      await press(wrapper, strings.myDataRemoveName);
      expect(wrapper.find("[role=alertdialog]").text()).toContain(strings.myDataConfirmNoOtherApps);
    });

    it("asks for all with the list of the apps it affects", async () => {
      const { strings, wrapper } = show("others", language);
      await press(wrapper, strings.myDataRemoveAllName);
      const text = wrapper.find("[role=alertdialog]").text();
      expect(text).toContain(strings.myDataConfirmAllTitle);
      for (const name of [APP_A, APP_B, "excel-assistant"]) expect(text).toContain(name);
      expect(button(wrapper, strings.myDataConfirmRemoveAllName).text()).toBe(strings.myDataConfirmRemoveAll);
    });

    it("says it is busy, then done with what stayed", async () => {
      const { strings, source, wrapper } = show("others", language);
      let release!: () => void;
      source.gate = new Promise<void>((resolve) => { release = resolve; });
      await press(wrapper, strings.myDataRemoveName);
      await press(wrapper, strings.myDataConfirmRemoveName);
      expect(wrapper.find("[role=status]").text()).toBe(strings.myDataWorking);
      expect(button(wrapper, strings.myDataRemoveName).element.disabled).toBe(true);
      expect(wrapper.find(".fdn-skills-column").attributes("aria-busy")).toBe("true");
      release();
      await flushPromises();
      expect(wrapper.find("[role=status]").text()).toContain(strings.myDataRemoved(APP_A));
      expect(wrapper.find("[role=status]").text()).toContain(APP_B);
      expect(button(wrapper, strings.myDataRemoveName).element.disabled).toBe(false);
    });

    it("shows an error as a sentence in an alert, without the exception's text", async () => {
      const { strings, source, wrapper } = show("others", language);
      source.failExport = true;
      await press(wrapper, strings.myDataExportName);
      expect(wrapper.find("[role=alert]").text()).toBe(strings.myDataExportFailed);
      source.failRemove = true;
      await press(wrapper, strings.myDataRemoveAllName);
      await press(wrapper, strings.myDataConfirmRemoveAllName);
      expect(wrapper.find("[role=alert]").text()).toBe(strings.myDataRemoveFailed);
      expect(document.body.textContent).not.toContain("boom");
    });
  });

  it("Cancel and Escape say no, and the focus goes back to the first action", async () => {
    const { strings, source, wrapper } = show("others");
    await press(wrapper, strings.myDataRemoveName);
    await press(wrapper, strings.myDataCancelName);
    expect(wrapper.find("[role=alertdialog]").exists()).toBe(false);
    expect(document.activeElement).toBe(button(wrapper, strings.myDataExportName).element);
    await press(wrapper, strings.myDataRemoveAllName);
    await wrapper.find(".fdn-wizard").trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.find("[role=alertdialog]").exists()).toBe(false);
    expect(source.calls).toEqual([]);
  });

  it("Yes removes this app's data only, and the result line names who kept the shared data", async () => {
    const { strings, source, wrapper } = show("others");
    await press(wrapper, strings.myDataRemoveName);
    await press(wrapper, strings.myDataConfirmRemoveName);
    expect(source.calls).toEqual(["remove:thisApp"]);
    expect(wrapper.find("[role=status]").text()).toContain("Skills, MCP servers, keys and provenance records stayed");
  });

  it("an export hands the app a document to save and says its name", async () => {
    const { strings, saved, wrapper } = show("others");
    await press(wrapper, strings.myDataExportAllName);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.scope).toBe("allApps");
    expect(wrapper.find("[role=status]").text()).toBe(strings.myDataExported(saved[0]!.fileName));
  });
});

describe("the record of tool calls in the Your data control (Vue)", () => {
  const showWithAudit = async (language: string = "en", configure: (s: FakeMyData) => void = () => undefined) => {
    const source = new FakeMyData("others").withAudit();
    configure(source);
    const strings = builtInStrings[language]!;
    const vm = new MyDataSettingsViewModel({ source, strings: () => strings });
    const saved: MyDataSaveRequest[] = [];
    vm.onSaveRequest((r) => saved.push(r));
    await vm.load();
    const wrapper = mount(MyDataSettings, { props: { settings: vm }, attachTo: document.body });
    wrappers.push(wrapper);
    await flushPromises();
    return { source, vm, strings, wrapper, saved };
  };

  it.each(LANGUAGES)("shows its line and a named button in %s", async (language) => {
    const { strings, vm, wrapper } = await showWithAudit(language);
    expect(wrapper.find("[data-audit-line]").text()).toBe(vm.auditLine);
    expect(vm.auditLine).not.toBe("");
    const b = button(wrapper, strings.myDataAuditExportName);
    expect(b.text()).toBe(strings.myDataAuditExport);
    expect(b.element.disabled).toBe(false);
    expect(strings.myDataAuditExportName.toLowerCase()).toContain(strings.myDataAuditExport.toLowerCase());
  });

  it("says a damaged record as a warning, and still in words", async () => {
    const { wrapper } = await showWithAudit("en", (s) => { s.verification = { intact: false, entries: 3, firstSeq: 1, brokenAtSeq: 4, problem: "hash_mismatch" }; });
    const line = wrapper.find("[data-audit-line]");
    expect(line.text()).toBe("Record of tool calls: damaged at entry 4");
    expect(line.classes()).toContain("fdn-skills-message-warning");
  });

  it("the button saves the record as a web page, and the result line says its name", async () => {
    const { strings, saved, wrapper } = await showWithAudit();
    await press(wrapper, strings.myDataAuditExportName);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: "audit", scope: "allApps" });
    expect(wrapper.find("[role=status]").text()).toBe(strings.myDataExported(saved[0]!.fileName));
  });

  it("a control without a record has neither the line nor the button", () => {
    const { strings, wrapper } = show("others");
    expect(wrapper.find("[data-audit-line]").exists()).toBe(false);
    expect(button(wrapper, strings.myDataAuditExportName).exists()).toBe(false);
  });
});
