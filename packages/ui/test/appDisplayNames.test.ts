import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { ApprovalDecision, FadenstackAgent, IndexedDbAppRecords, appDisplayName, cleanDisplayNames, userStoreName, type AppDisplayNames } from "@fadenstack/agents";
import { FakeGateway } from "@fadenstack/testing";
import { MyDataSettingsViewModel, aboutView, builtInStrings } from "@fadenstack/ui";

// An app's name in the panel's texts (0.3.1): the name stays English (manifest, records, record of tool calls), the texts quote it after
// a noun, and an optional display name per language replaces it in the texts only, through the shared app list.

const PERSON = { tenantId: "tenant-1", userId: "user-1" };
const CHROME = "Chrome extension";
const WORD = "Word add-in";
const CHROME_NAMES: AppDisplayNames = { de: "Chrome-Erweiterung", "zh-Hans": "Chrome 扩展" };
const WORD_NAMES: AppDisplayNames = { de: "Word-Add-in", "zh-Hans": "Word 加载项" };
const de = builtInStrings.de!;
const zh = builtInStrings["zh-Hans"]!;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const gateway = () => new FakeGateway({
  users: [{ email: "anna@example.com", password: "secret" }], principal: true, model: () => ({ text: "ok" }),
  agents: [{ slug: "chrome" }, { slug: "word" }],
});

async function app(gw: FakeGateway, slug: string, name: string, displayNames?: AppDisplayNames): Promise<FadenstackAgent> {
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gw.serverUrl, agent: slug, fetch: gw.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gw.serverUrl, email: "anna@example.com", password: "secret", fetch: gw.fetch }));
  const agent = FadenstackAgent.createBuilder().useClient(client).useApprovals(() => Promise.resolve(ApprovalDecision.approveAlways()))
    .describeApp({ name, ...(displayNames ? { displayNames } : {}) }).build();
  await agent.start();
  return agent;
}

const control = async (agent: FadenstackAgent, language: "de" | "zh-Hans") => {
  const vm = new MyDataSettingsViewModel({ agent, strings: () => builtInStrings[language]! });
  await vm.load();
  return vm;
};

describe("an app's display names in the panel's texts", () => {
  it("German: the name is quoted after 'der App', and a display name replaces it, in this app and in the list of the others", async () => {
    const gw = gateway();
    const chrome = await app(gw, "chrome", CHROME, CHROME_NAMES);
    await app(gw, "word", WORD, WORD_NAMES);
    const vm = await control(chrome, "de");
    await vm.askRemoveThisApp();
    expect(vm.confirmTitle).toBe("Ihre Daten aus der App „Chrome-Erweiterung“ entfernen?");
    expect(vm.confirmLines[0]).toContain("Einstellungen der App „Chrome-Erweiterung“ in diesem Browser");
    expect(vm.confirmLines[1]).toContain("auch von „Word-Add-in“ verwendet werden"); // the other app's name, from the shared record
    await vm.confirm();
    expect(vm.statusText).toContain("Ihre Daten wurden aus der App „Chrome-Erweiterung“ entfernt.");
    expect(vm.statusText).toContain("von „Word-Add-in“ verwendet");
  });

  it("German: without a display name the English name is quoted as it is", async () => {
    const gw = gateway();
    const chrome = await app(gw, "chrome", CHROME);
    await app(gw, "word", WORD);
    const vm = await control(chrome, "de");
    await vm.askRemoveThisApp();
    expect(vm.confirmTitle).toBe("Ihre Daten aus der App „Chrome extension“ entfernen?");
    expect(vm.confirmLines[1]).toContain("von „Word add-in“ verwendet");
  });

  it("Chinese: the name is quoted after 应用, with and without a display name", async () => {
    const gw = gateway();
    const chrome = await app(gw, "chrome", CHROME, CHROME_NAMES);
    const word = await app(gw, "word", WORD); // a Word that gave none: its English name in the list
    const vm = await control(chrome, "zh-Hans");
    await vm.askRemoveThisApp();
    expect(vm.confirmTitle).toBe("要从应用“Chrome 扩展”中删除您的数据吗？");
    expect(vm.confirmLines[1]).toContain("“Word add-in”");
    const other = await control(word, "zh-Hans");
    await other.askRemoveThisApp();
    expect(other.confirmTitle).toBe("要从应用“Word add-in”中删除您的数据吗？");
    expect(other.confirmLines[1]).toContain("“Chrome 扩展”");
  });

  it("a language the app gave no display name for falls back to name; English can have one too", () => {
    expect(appDisplayName(CHROME, { de: "Chrome-Erweiterung" }, "fr")).toBe(CHROME);
    expect(appDisplayName(CHROME, { de: "Chrome-Erweiterung" }, "de-AT")).toBe("Chrome-Erweiterung");
    expect(appDisplayName(CHROME, { en: "Chrome add-on" }, "en")).toBe("Chrome add-on");
    expect(appDisplayName(CHROME, undefined, "de")).toBe(CHROME);
    expect(cleanDisplayNames({ de: "  ", fr: 5, xx: "x", es: " Extensión " })).toEqual({ es: "Extensión" });
  });

  it("About says 'Runs in the app' with the display name in the panel's language", () => {
    const facts = { app: { name: CHROME, version: "1.3.0", displayNames: CHROME_NAMES } };
    expect(aboutView(facts, de).environment[0]).toBe("Läuft in der App „Chrome-Erweiterung“ 1.3.0");
    expect(aboutView(facts, zh).environment[0]).toBe("运行于应用“Chrome 扩展” 1.3.0");
    expect(aboutView({ app: { name: WORD } }, de).environment[0]).toBe("Läuft in der App „Word add-in“");
    expect(aboutView({ app: { name: WORD, version: "2" } }, de).environment[0]).toBe("Läuft in der App „Word add-in“ 2");
  });

  it("the manifest, the records and the app's name keep the English name; the display names go with the record", async () => {
    const gw = gateway();
    const chrome = await app(gw, "chrome", CHROME, CHROME_NAMES);
    await app(gw, "word", WORD);
    expect(chrome.appName).toBe(CHROME);
    expect(chrome.appDisplayNames).toEqual(CHROME_NAMES);
    const sent = gw.manifests.filter((m) => m.agent === "chrome").map((m) => m.manifest["app"]);
    expect(sent.length).toBeGreaterThan(0);
    for (const manifestApp of sent) expect(manifestApp).toMatchObject({ name: CHROME });
    expect(JSON.stringify(gw.manifests)).not.toContain("Chrome-Erweiterung");

    const records = new IndexedDbAppRecords({ name: userStoreName("fadenstack-apps", PERSON) });
    const list = await records.list();
    records.close();
    expect(list.map((r) => r.app).sort()).toEqual([CHROME, WORD]);
    expect(list.find((r) => r.app === CHROME)!.displayNames).toEqual(CHROME_NAMES);
    expect(list.find((r) => r.app === WORD)!.displayNames).toBeUndefined();
    expect((await chrome.myDataApps()).map((a) => a.name)).toEqual([CHROME, WORD]);
  });
});

