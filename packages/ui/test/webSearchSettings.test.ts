import { afterEach, describe, expect, it } from "vitest";

import { MemoryWebSearchStore } from "@fadenstack/agents";
import { ToolsPageViewModel, WebSearchSettingsViewModel, englishStrings, germanStrings, type UiStrings } from "@fadenstack/ui";

import { FakeCatalog } from "./toolsFakes.js";

// The web search settings sheet's view model, on a store in memory, and its row on the Tools page.

const KEY = "BSA-secret-key-123";
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

async function sheet(store = new MemoryWebSearchStore(), onClose?: () => void) {
  const vm = new WebSearchSettingsViewModel({ store, ...(onClose ? { onClose } : {}) });
  await vm.ready;
  return { vm, store };
}

describe("choices", () => {
  it("starts off, with nothing kept", async () => {
    const { vm } = await sheet();
    expect(vm.choice).toBe("off");
    expect(vm.isOff).toBe(true);
    expect(vm.keyIsKept).toBe(false);
    expect(vm.showsKeyInput).toBe(true);
    expect(vm.key).toBe("");
  });

  it("starts from what the store keeps", async () => {
    const store = new MemoryWebSearchStore();
    await store.save({ provider: "searxng", searxngUrl: "https://search.example.org/" });
    const { vm } = await sheet(store);
    expect(vm.isSearxng).toBe(true);
    expect(vm.address).toBe("https://search.example.org/");
  });

  it("picks a choice", async () => {
    const { vm } = await sheet();
    vm.choice = "brave";
    expect(vm.isBrave).toBe(true);
    vm.choice = "searxng";
    expect(vm.isSearxng).toBe(true);
  });

  it("says where the key is kept and that the query leaves the organisation", async () => {
    const { vm } = await sheet();
    expect(vm.keptWhereText).toBe(englishStrings.webSearchKeptStore);
    expect(vm.privacyText).toBe(englishStrings.webSearchPrivacy);
  });
});

describe("validation", () => {
  it.each([
    ["", "webSearchUrlMissing"],
    ["http://search.example.org", "webSearchUrlRefused"],
    ["https://user:pw@search.example.org", "webSearchUrlRefused"],
    ["not an address", "webSearchUrlRefused"],
  ] as const)("refuses the SearXNG address %j", async (address, message) => {
    const { vm, store } = await sheet();
    vm.choice = "searxng";
    vm.address = address;
    await vm.save();
    expect(vm.errorText).toBe(englishStrings[message]);
    expect((await store.settings()).provider).toBe("none");
  });

  it("accepts https and http on this computer", async () => {
    for (const address of ["https://search.example.org", "http://localhost:8080", "http://127.0.0.1:8888"]) {
      const { vm, store } = await sheet();
      vm.choice = "searxng";
      vm.address = ` ${address} `;
      await vm.save();
      expect(vm.hasError).toBe(false);
      expect((await store.settings()).provider).toBe("searxng");
    }
  });

  it("wants a key for Brave", async () => {
    const { vm, store } = await sheet();
    vm.choice = "brave";
    await vm.save();
    expect(vm.errorText).toBe(englishStrings.webSearchKeyMissing);
    expect((await store.settings()).provider).toBe("none");
  });
});

describe("save and cancel", () => {
  it("saves Brave and the key, then forgets the typed key", async () => {
    let closed = 0;
    const { vm, store } = await sheet(undefined, () => { closed += 1; });
    vm.choice = "brave";
    vm.key = KEY;
    await vm.save();
    expect((await store.settings()).provider).toBe("brave");
    expect(await store.braveKey()).toBe(KEY);
    expect(vm.key).toBe("");
    expect(closed).toBe(1);
  });

  it("says Saved when it has no page to close", async () => {
    const { vm } = await sheet();
    vm.choice = "searxng";
    vm.address = "https://search.example.org";
    await vm.save();
    expect(vm.savedText).toBe(englishStrings.webSearchSaved);
  });

  it("Off turns the tool off and keeps a saved key", async () => {
    const store = new MemoryWebSearchStore();
    await store.setBraveKey(KEY);
    await store.save({ provider: "brave" });
    const { vm } = await sheet(store);
    vm.choice = "off";
    await vm.save();
    expect((await store.settings()).provider).toBe("none");
    expect(await store.hasBraveKey()).toBe(true);
  });

  it("writes nothing on Cancel and forgets the typed key", async () => {
    let closed = 0;
    const { vm, store } = await sheet(undefined, () => { closed += 1; });
    vm.choice = "brave";
    vm.key = KEY;
    vm.cancel();
    expect(vm.key).toBe("");
    expect(closed).toBe(1);
    expect((await store.settings()).provider).toBe("none");
    expect(await store.hasBraveKey()).toBe(false);
  });

  it("forgets the typed key when disposed", async () => {
    const { vm } = await sheet();
    vm.choice = "brave";
    vm.key = KEY;
    vm.dispose();
    expect(vm.key).toBe("");
  });
});

describe("a kept key", () => {
  async function kept() {
    const store = new MemoryWebSearchStore();
    await store.setBraveKey(KEY);
    await store.save({ provider: "brave" });
    return sheet(store);
  }

  it("is never read back into the box", async () => {
    const { vm } = await kept();
    expect(vm.keyIsKept).toBe(true);
    expect(vm.showsKeyInput).toBe(false);
    expect(vm.key).toBe("");
    expect(JSON.stringify([vm.key, vm.keptWhereText, vm.errorText])).not.toContain(KEY);
  });

  it("is kept when only the choice is saved", async () => {
    const { vm, store } = await kept();
    await vm.save();
    expect(await store.braveKey()).toBe(KEY);
  });

  it("Replace shows the box; a typed key replaces the kept one", async () => {
    const { vm, store } = await kept();
    vm.replaceKey();
    expect(vm.showsKeyInput).toBe(true);
    expect(vm.key).toBe("");
    vm.key = "NEW-KEY";
    await vm.save();
    expect(await store.braveKey()).toBe("NEW-KEY");
  });

  it("Remove key removes it on Save, not before", async () => {
    const { vm, store } = await kept();
    vm.removeKey();
    expect(vm.keyIsRemoved).toBe(true);
    expect(await store.hasBraveKey()).toBe(true);
    vm.choice = "off";
    await vm.save();
    expect(await store.hasBraveKey()).toBe(false);
  });

  it("with the key removed, Brave wants a new one", async () => {
    const { vm } = await kept();
    vm.removeKey();
    await vm.save();
    expect(vm.errorText).toBe(englishStrings.webSearchKeyMissing);
  });

  it("Cancel after Remove key keeps the key", async () => {
    const { vm, store } = await kept();
    vm.removeKey();
    vm.cancel();
    expect(await store.hasBraveKey()).toBe(true);
  });
});

describe("retext", () => {
  it("says the texts again in the new language", async () => {
    let current: UiStrings = englishStrings;
    const vm = new WebSearchSettingsViewModel({ store: new MemoryWebSearchStore(), strings: () => current });
    await vm.ready;
    expect(vm.title).toBe("Web search");
    let changes = 0;
    vm.subscribe(() => { changes += 1; });
    current = germanStrings;
    vm.retext();
    expect(changes).toBe(1);
    expect(vm.title).toBe("Websuche");
    expect(vm.keptWhereText).toBe(germanStrings.webSearchKeptStore);
  });
});

describe("the row on the Tools page", () => {
  const pages: ToolsPageViewModel[] = [];
  afterEach(() => { for (const p of pages.splice(0)) p.dispose(); });
  const page = (store?: MemoryWebSearchStore, strings: () => UiStrings = () => englishStrings) => {
    const p = new ToolsPageViewModel({ catalog: new FakeCatalog(), strings, ...(store ? { webSearch: store } : {}) });
    pages.push(p);
    return p;
  };

  it("is absent when the app gave no store", () => {
    const p = page();
    expect(p.hasWebSearch).toBe(false);
    p.openWebSearch();
    expect(p.hasSheet).toBe(false);
  });

  it("says Off with Set up, then the provider with Change", async () => {
    const store = new MemoryWebSearchStore();
    const p = page(store);
    await settle();
    expect(p.hasWebSearch).toBe(true);
    expect(p.webSearchState).toBe("Off");
    expect(p.webSearchButtonText).toBe("Set up");
    await store.save({ provider: "brave" });
    await settle();
    expect(p.webSearchState).toBe("Brave");
    expect(p.webSearchButtonText).toBe("Change");
    await store.save({ provider: "searxng", searxngUrl: "https://search.example.org:8443/x" });
    await settle();
    expect(p.webSearchState).toBe("SearXNG · search.example.org:8443");
  });

  it("opens the sheet, which closes on Cancel and on Save", async () => {
    const store = new MemoryWebSearchStore();
    const p = page(store);
    p.openWebSearch();
    expect(p.sheet).toBeInstanceOf(WebSearchSettingsViewModel);
    (p.sheet as WebSearchSettingsViewModel).cancel();
    expect(p.hasSheet).toBe(false);
    p.openWebSearch();
    const s = p.sheet as WebSearchSettingsViewModel;
    await s.ready;
    s.choice = "searxng";
    s.address = "https://search.example.org";
    await s.save();
    expect(p.hasSheet).toBe(false);
    await settle();
    expect(p.webSearchState).toContain("SearXNG");
  });

  it("retext says the row again", async () => {
    let current: UiStrings = englishStrings;
    const p = page(new MemoryWebSearchStore(), () => current);
    await settle();
    current = germanStrings;
    p.retext();
    expect(p.webSearchState).toBe("Aus");
    expect(p.webSearchButtonText).toBe("Einrichten");
  });
});
