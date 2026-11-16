import { describe, expect, it } from "vitest";

import { MyDataSettingsViewModel, builtInStrings, englishStrings, type MyDataSaveRequest, type UiStrings } from "@fadenstack/ui";

import { FakeMyData } from "./myDataFakes.js";

// The record of tool calls in "Your data" (sdk/51 8.10): its line, and the button that saves it as a web page. Port of the .NET tests.

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;

const model = (configure: (source: FakeMyData) => void = () => undefined, strings: UiStrings = englishStrings) => {
  const source = new FakeMyData("alone").withAudit();
  configure(source);
  const vm = new MyDataSettingsViewModel({ source, strings: () => strings });
  const saved: MyDataSaveRequest[] = [];
  vm.onSaveRequest((r) => saved.push(r));
  return { source, vm, saved };
};

const since = (strings: UiStrings = englishStrings) => new Intl.DateTimeFormat(strings.language, { dateStyle: "short" }).format(new Date("2026-08-01T10:00:00.000Z"));

describe("the record of tool calls in the Your data control", () => {
  it("shows how many entries since when, and that it is intact", async () => {
    const { vm, source } = model();
    expect(vm.auditLine).toBe(""); // until the first check
    await vm.load();

    expect(vm.hasAudit).toBe(true);
    expect(vm.auditLine).toBe(`Record of tool calls: 12 entries since ${since()}, intact`);
    expect([vm.hasAuditLine, vm.auditDamaged]).toEqual([true, false]);
    expect(source.calls.filter((c) => c === "audit")).toHaveLength(1);
  });

  it("has a sentence for one entry, none, a damaged record and a check that failed", async () => {
    const one = model((s) => { s.verification = { ...s.verification, entries: 1 }; });
    await one.vm.load();
    expect(one.vm.auditLine).toBe(`Record of tool calls: 1 entry since ${since()}, intact`);

    const none = model((s) => { s.verification = { intact: true, entries: 0 }; });
    await none.vm.load();
    expect(none.vm.auditLine).toBe("Record of tool calls: no entries yet");

    const damaged = model((s) => { s.verification = { intact: false, entries: 7, firstSeq: 1, brokenAtSeq: 8, problem: "seal_mismatch" }; });
    await damaged.vm.load();
    expect(damaged.vm.auditLine).toBe("Record of tool calls: damaged at entry 8");
    expect(damaged.vm.auditDamaged).toBe(true);
    expect(damaged.vm.auditLine).not.toContain("seal_mismatch"); // the kind of problem is for the export, not for a sentence

    const failed = model((s) => { s.failAudit = true; });
    await failed.vm.load();
    expect(failed.vm.auditLine).toBe("Record of tool calls: could not be checked");
    expect(failed.vm.auditLine).not.toContain("secret");
    expect(failed.vm.auditDamaged).toBe(true);
  });

  it("saves the record as one web page through the host's save path", async () => {
    const { vm, saved, source } = model();
    await vm.load();

    await vm.exportAudit();

    expect(source.calls).toContain("audit-export");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: "audit", scope: "allApps", text: "<!DOCTYPE html><title>Record</title>" });
    expect(saved[0]!.fileName).toMatch(/^fadenstack-tool-calls-\d{4}-\d{2}-\d{2}\.html$/);
    expect(saved[0]!.content.type).toBe("text/html");
    expect([vm.phase, vm.isError]).toEqual(["done", false]);
    expect(vm.statusText).toContain(saved[0]!.fileName);
  });

  it("says a failed export in a sentence, without the reason", async () => {
    const { vm, saved } = model((s) => { s.failAuditExport = true; });
    await vm.load();

    await vm.exportAudit();

    expect(saved).toEqual([]);
    expect([vm.phase, vm.isError]).toEqual(["error", true]);
    expect(vm.statusText).toBe(englishStrings.myDataExportFailed);
    expect(vm.statusText).not.toContain("secret");
  });

  it("checks the record again after a removal, which may have taken it", async () => {
    const { vm, source } = model();
    await vm.load();
    await vm.askRemoveAll();
    await vm.confirm();

    expect(source.calls.filter((c) => c === "audit")).toHaveLength(2);
  });

  it("a source that keeps no record shows neither the line nor the button", async () => {
    const source = new FakeMyData("alone"); // no withAudit()
    const vm = new MyDataSettingsViewModel({ source, strings: () => englishStrings });
    await vm.load();

    expect([vm.hasAudit, vm.auditLine, vm.hasAuditLine]).toEqual([false, "", false]);
    await vm.exportAudit();
    expect([vm.phase, vm.statusText]).toEqual(["idle", ""]);
  });

  it.each(LANGUAGES)("has its texts in %s, and the name of the button says what the button says", async (language) => {
    const strings = builtInStrings[language]!;
    const texts = [strings.myDataAuditIntact("12", "1.8.2026"), strings.myDataAuditIntactOne("1.8.2026"), strings.myDataAuditDamaged("8"), strings.myDataAuditEmpty,
      strings.myDataAuditUnreadable, strings.myDataAuditExport, strings.myDataAuditExportName];

    for (const text of texts) expect(text.trim()).not.toBe("");
    expect(texts[0]).toContain("12");
    expect(texts[0]).toContain("1.8.2026");
    expect(texts[2]).toContain("8");
    expect(strings.myDataAuditExportName).toContain(strings.myDataAuditExport); // WCAG 2.5.3
    if (language !== "en") expect(strings.myDataAuditExport).not.toBe(englishStrings.myDataAuditExport);
    if (language === "fr") for (const text of [texts[0]!, texts[3]!]) expect(text).toContain("\u00a0:");
  });
});
