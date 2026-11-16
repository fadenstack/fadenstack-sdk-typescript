import { describe, expect, it } from "vitest";

import { AgentDefinition, FadenstackAgent, MemoryApprovalStore, MemorySessionStore } from "@fadenstack/agents";
import { EndpointDialect } from "@fadenstack/client";
import { OpenAiFake } from "@fadenstack/testing";
import {
  MyDataSettingsViewModel, builtInStrings, englishStrings, germanStrings, type MyDataSaveRequest, type UiStrings,
} from "@fadenstack/ui";

import { APP_A, APP_B, FakeMyData, type ScenarioName } from "./myDataFakes.js";

// The "Your data" control (GDPR Art. 15, 17, 20): every state, what a removal asks first, and that nothing is removed without a yes.

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;

const model = (scenario: ScenarioName, strings: UiStrings = englishStrings) => {
  const source = new FakeMyData(scenario);
  const vm = new MyDataSettingsViewModel({ source, strings: () => strings });
  const saved: MyDataSaveRequest[] = [];
  vm.onSaveRequest((r) => saved.push(r));
  return { source, vm, saved };
};

describe("the Your data control", () => {
  it("starts idle with the four actions and no status", async () => {
    const { vm } = model("others");
    await vm.load();
    expect([vm.phase, vm.showActions, vm.canAct, vm.showConfirm, vm.isBusy, vm.statusText]).toEqual(["idle", true, true, false, false, ""]);
    expect(vm.apps.map((a) => a.name)).toEqual([APP_A, APP_B, "excel-assistant"]);
  });

  it("asks before it removes this app's data, and names the apps that keep the shared data", async () => {
    const { vm, source } = model("others");
    await vm.askRemoveThisApp();
    expect([vm.phase, vm.confirmsAll, vm.showActions]).toEqual(["confirmThisApp", false, false]);
    expect(vm.confirmTitle).toBe(`Remove your data from ${APP_A}?`);
    expect(vm.confirmLines).toEqual([
      expect.stringContaining(APP_A),
      `Your skills, MCP servers, keys and provenance records stay, because they are also used by ${APP_B} and excel-assistant.`,
    ]);
    expect(vm.confirmLabel).toBe("Remove");
    expect(source.calls).toEqual([]); // nothing yet
  });

  it("says that everything goes when no other app uses the data", async () => {
    const { vm } = model("alone");
    await vm.askRemoveThisApp();
    expect(vm.confirmLines[1]).toBe(englishStrings.myDataConfirmNoOtherApps);
    expect(vm.otherApps).toEqual([]);
  });

  it("names an agent another app also uses, whose chats stay", async () => {
    const { vm } = model("shared-agent");
    await vm.askRemoveThisApp();
    expect(vm.agentsKept).toEqual(["docs"]);
    expect(vm.confirmLines).toContain("The chats and approvals of docs stay, because another app uses them too.");
  });

  it("No leaves everything as it was", async () => {
    const { vm, source } = model("others");
    await vm.askRemoveThisApp();
    vm.cancel();
    expect([vm.phase, vm.statusText]).toEqual(["idle", ""]);
    expect(source.calls).toEqual([]);
  });

  it("never removes without a question: confirm() with none open does nothing", async () => {
    const { vm, source } = model("others");
    await vm.confirm();
    expect(source.calls).toEqual([]);
    expect(vm.phase).toBe("idle");
  });

  it("removes this app's data on yes and says what stayed", async () => {
    const { vm, source } = model("others");
    await vm.askRemoveThisApp();
    await vm.confirm();
    expect(source.calls).toEqual(["remove:thisApp"]);
    expect(vm.phase).toBe("done");
    expect(vm.statusText).toBe(`Your data was removed from ${APP_A}. Skills, MCP servers, keys and provenance records stayed, because they are also used by ${APP_B} and excel-assistant.`);
    expect(vm.apps.map((a) => a.name)).toEqual([APP_B, "excel-assistant"]); // read again
  });

  it("asks for all apps with the list of the apps it affects, and removes all on yes", async () => {
    const { vm, source } = model("others");
    await vm.askRemoveAll();
    expect([vm.phase, vm.confirmsAll]).toEqual(["confirmAll", true]);
    expect(vm.confirmTitle).toBe("Remove all your Fadenstack data in this browser?");
    expect(vm.confirmLines[1]).toBe(`These apps are affected: ${APP_A}, ${APP_B}, and excel-assistant.`);
    expect(vm.confirmLabel).toBe("Remove everything");
    await vm.confirm();
    expect(source.calls).toEqual(["remove:allApps"]);
    expect(vm.statusText).toBe("All your Fadenstack data in this browser was removed.");
  });

  it("is busy while it works, and takes no second action", async () => {
    const { vm, source } = model("others");
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => { release = resolve; });
    await vm.askRemoveThisApp();
    const pending = vm.confirm();
    expect([vm.phase, vm.isBusy, vm.canAct, vm.statusText]).toEqual(["busy", true, false, "Working…"]);
    await vm.exportAll(); // ignored
    await vm.askRemoveAll(); // ignored
    expect(source.calls).toEqual(["remove:thisApp"]);
    release();
    await pending;
    expect(vm.phase).toBe("done");
  });

  it("hands the export to the app with a suggested file name, for this app and for all", async () => {
    const { vm, saved } = model("others");
    await vm.exportThisApp();
    await vm.exportAll();
    const day = new Date().toISOString().slice(0, 10);
    expect(saved.map((s) => [s.fileName, s.scope])).toEqual([[`fadenstack-my-data-word-add-in-${day}.json`, "thisApp"], [`fadenstack-all-my-data-${day}.json`, "allApps"]]);
    expect(JSON.parse(saved[0]!.text)).toMatchObject({ format: "fadenstack-my-data", scope: "thisApp" });
    expect(saved[0]!.content.type).toBe("application/json");
    expect(await saved[0]!.content.text()).toBe(saved[0]!.text);
    expect(vm.statusText).toBe(`Your data was exported as fadenstack-all-my-data-${day}.json.`);
  });

  it("shows an error as a sentence, never the exception's text, and the actions come back", async () => {
    const { vm, source, saved } = model("others");
    source.failExport = true;
    await vm.exportThisApp();
    expect([vm.phase, vm.isError, vm.canAct, vm.statusText]).toEqual(["error", true, true, englishStrings.myDataExportFailed]);
    expect(saved).toEqual([]);
    source.failRemove = true;
    await vm.askRemoveThisApp();
    await vm.confirm();
    expect([vm.phase, vm.statusText]).toEqual(["error", englishStrings.myDataRemoveFailed]);
    expect(vm.statusText).not.toContain("boom");
    expect(vm.showActions).toBe(true);
  });

  it("says when a store the app keeps itself was left", async () => {
    const { vm, source } = model("alone");
    source.hostStoresLeft = true;
    await vm.askRemoveThisApp();
    await vm.confirm();
    expect(vm.statusText).toBe(`Your data was removed from ${APP_A}. ${englishStrings.myDataHostStoresLeft}`);
  });

  it("says its texts again in a new language on retext()", async () => {
    let language: UiStrings = englishStrings;
    const source = new FakeMyData("others");
    const vm = new MyDataSettingsViewModel({ source, strings: () => language });
    await vm.askRemoveThisApp();
    let told = 0;
    vm.subscribe(() => { told += 1; });
    language = germanStrings;
    vm.retext();
    expect(told).toBe(1);
    expect(vm.confirmTitle).toBe(`Ihre Daten aus ${APP_A} entfernen?`);
    expect(vm.confirmLines[1]).toContain("Skills, MCP-Server, Schlüssel und Herkunftsnachweise bleiben erhalten");
  });

  it.each(LANGUAGES)("says every state in %s with the apps named", async (language) => {
    const strings = builtInStrings[language]!;
    const { vm } = model("shared-agent", strings);
    await vm.askRemoveThisApp();
    expect(vm.confirmTitle).toContain(APP_A);
    expect(vm.confirmLines.join(" ")).toContain(APP_B);
    expect(vm.confirmLines.join(" ")).toContain("docs");
    vm.cancel();
    await vm.askRemoveAll();
    expect(vm.confirmLines.join(" ")).toContain(APP_B);
    await vm.confirm();
    expect(vm.statusText).toBe(strings.myDataRemovedAll);
    for (const line of [vm.confirmTitle, vm.statusText, ...vm.confirmLines]) expect(line).not.toMatch(/[{}]|undefined|myData/);
  });

  it("works over a real agent: the app is named by its slug, and a removal answers", async () => {
    const fake = new OpenAiFake();
    const agent = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch })
      .useLocalProfile(AgentDefinition.fromJson({ slug: "local-assistant", name: "Local", version: { instructions: "Hi.", host_tool_contract: [], ui: {} } }))
      .useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore()).build();
    const vm = new MyDataSettingsViewModel({ agent });
    await vm.load();
    expect(vm.appName).toBe("local-assistant");
    expect(vm.apps).toMatchObject([{ name: "local-assistant", isThisApp: true, recorded: false }]);
    await vm.askRemoveThisApp();
    expect(vm.confirmLines[1]).toBe(englishStrings.myDataConfirmNoOtherApps);
    await vm.confirm();
    expect(vm.phase).toBe("done");
    expect(vm.statusText).toContain("local-assistant");
    expect(vm.statusText).toContain(englishStrings.myDataHostStoresLeft); // the stores the host passed stay the host's
  });
});

describe("the texts of the control", () => {
  const plain = ["myDataTitle", "myDataIntro", "myDataExport", "myDataExportName", "myDataRemove", "myDataRemoveName", "myDataExportAll", "myDataExportAllName",
    "myDataRemoveAll", "myDataRemoveAllName", "myDataConfirmNoOtherApps", "myDataConfirmAllTitle", "myDataConfirmAll", "myDataConfirmAllNoApps",
    "myDataConfirmRemove", "myDataConfirmRemoveName", "myDataConfirmRemoveAll", "myDataConfirmRemoveAllName", "myDataCancel", "myDataCancelName",
    "myDataWorking", "myDataRemovedAll", "myDataHostStoresLeft", "myDataExportFailed", "myDataRemoveFailed"] as const;

  const filled = (s: UiStrings): string[] => [
    s.myDataConfirmThisAppTitle("App-X"), s.myDataConfirmThisApp("App-X"), s.myDataConfirmKept("App-X"), s.myDataConfirmAgentsKept("agent-x"),
    s.myDataConfirmAllApps("App-X"), s.myDataExported("file-x.json"), s.myDataRemoved("App-X"), s.myDataRemovedKept("App-X"), s.myDataRemovedAgentsKept("agent-x"),
  ];

  it.each(LANGUAGES)("are all there in %s, filled in, with no placeholder left", (language) => {
    const s = builtInStrings[language]!;
    for (const key of plain) expect(s[key].length, `${language}: ${key}`).toBeGreaterThan(0);
    for (const text of filled(s)) expect(text).not.toMatch(/[{}]|undefined/);
    expect(filled(s).every((t) => /App-X|agent-x|file-x\.json/.test(t))).toBe(true);
    // WCAG 2.5.3: the accessible name of a button contains what the button says.
    for (const [name, visible] of [["myDataExportName", "myDataExport"], ["myDataRemoveName", "myDataRemove"], ["myDataExportAllName", "myDataExportAll"],
      ["myDataRemoveAllName", "myDataRemoveAll"], ["myDataConfirmRemoveName", "myDataConfirmRemove"], ["myDataConfirmRemoveAllName", "myDataConfirmRemoveAll"],
      ["myDataCancelName", "myDataCancel"]] as const) {
      expect(s[name].toLowerCase(), `${language}: ${name}`).toContain(s[visible].toLowerCase());
    }
  });

  it.each(LANGUAGES.filter((l) => l !== "en"))("are translated in %s, not left in English", (language) => {
    const s = builtInStrings[language]!;
    for (const key of plain) expect(s[key], `${language}: ${key} is English`).not.toBe(englishStrings[key]);
    expect(filled(s)[0]).not.toBe(filled(englishStrings)[0]);
  });

  it("say \"in this browser\" for all apps, where the data lives per browser", () => {
    expect(englishStrings.myDataRemoveAll).toBe("Remove all my Fadenstack data in this browser…");
    expect(builtInStrings["de"]!.myDataRemoveAll).toContain("in diesem Browser");
    expect(builtInStrings["fr"]!.myDataRemoveAll).toContain("dans ce navigateur");
    expect(builtInStrings["es"]!.myDataRemoveAll).toContain("en este navegador");
    expect(builtInStrings["zh-Hans"]!.myDataRemoveAll).toContain("在此浏览器中");
    for (const s of Object.values(builtInStrings)) expect(s.myDataRemoveAll.toLowerCase()).not.toMatch(/device|gerät|appareil|dispositivo|设备/);
  });

  it("use only the no-break space the French texts use, and no other invisible character", () => {
    for (const [language, s] of Object.entries(builtInStrings)) {
      const all = [...plain.map((k) => s[k]), ...filled(s)].join("");
      for (const ch of all) {
        const code = ch.codePointAt(0)!;
        const invisible = code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff || code === 0x2060 || code === 0x202f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x00ad;
        expect(invisible, `${language}: U+${code.toString(16)}`).toBe(false);
        if (code === 0xa0) expect(language, "NBSP outside French").toBe("fr");
      }
    }
  });
});
