// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { fireEvent, screen } from "@testing-library/react"; // its queries and events are the DOM testing library's; no React is drawn here
import { afterEach, describe, expect, it } from "vitest";

import { MemoryWebSearchStore } from "@fadenstack/agents";
import { ToolsPageViewModel, WebSearchSettingsViewModel, englishStrings, germanStrings } from "@fadenstack/ui";
import { ToolsPage, WebSearchSettings } from "@fadenstack/ui-vue";

import { FakeCatalog } from "../../ui/test/toolsFakes.js";

// The same checks as @fadenstack/ui-react's webSearchSettings.test.tsx, on the Vue skin (parity).

const wrappers: VueWrapper[] = [];
afterEach(() => { for (const w of wrappers.splice(0)) w.unmount(); });
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await flushPromises(); };

async function own(store = new MemoryWebSearchStore(), strings = englishStrings) {
  const vm = new WebSearchSettingsViewModel({ store, strings: () => strings });
  await vm.ready;
  const w = mount(WebSearchSettings, { props: { settings: vm }, attachTo: document.body });
  wrappers.push(w);
  return { vm, store, root: w.element as HTMLElement };
}

describe("on its own", () => {
  it("renders the choices with names", async () => {
    await own();
    expect(screen.getByRole("radio", { name: englishStrings.webSearchChoiceOff })).toBeTruthy();
    expect(screen.getByRole("radio", { name: englishStrings.webSearchChoiceBrave })).toBeTruthy();
    expect(screen.getByRole("radio", { name: englishStrings.webSearchChoiceSearxng })).toBeTruthy();
    expect(screen.getByRole("group", { name: englishStrings.webSearchChoiceName })).toBeTruthy();
  });

  it("has a masked key box that is never filled", async () => {
    const { root } = await own();
    await fireEvent.click(screen.getByRole("radio", { name: englishStrings.webSearchChoiceBrave }));
    await settle();
    const box = root.querySelector<HTMLInputElement>("input[type=password]")!;
    expect(box.autocomplete).toBe("off");
    expect(box.value).toBe("");
  });

  it("shows a kept key as saved, with Replace and Remove key, and never its value", async () => {
    const store = new MemoryWebSearchStore();
    await store.setBraveKey("BSA-hidden");
    await store.save({ provider: "brave" });
    const { root } = await own(store);
    expect(root.querySelector("input[type=password]")).toBeNull();
    expect(screen.getByText(englishStrings.webSearchKeyKept)).toBeTruthy();
    expect(screen.getByRole("button", { name: englishStrings.webSearchKeyReplace })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: englishStrings.webSearchKeyRemove }));
    await settle();
    expect(screen.getByText(englishStrings.webSearchKeyRemoved)).toBeTruthy();
    expect(root.innerHTML).not.toContain("BSA-hidden");
  });

  it("types an address, refuses http and saves https", async () => {
    const { store } = await own();
    await fireEvent.click(screen.getByRole("radio", { name: englishStrings.webSearchChoiceSearxng }));
    await settle();
    const box = screen.getByLabelText(englishStrings.webSearchUrlLabel);
    await fireEvent.input(box, { target: { value: "http://search.example.org" } });
    await fireEvent.click(screen.getByRole("button", { name: englishStrings.webSearchSave }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(englishStrings.webSearchUrlRefused);
    await fireEvent.input(box, { target: { value: "https://search.example.org" } });
    await fireEvent.click(screen.getByRole("button", { name: englishStrings.webSearchSave }));
    await settle();
    expect((await store.settings()).provider).toBe("searxng");
    expect(screen.getByText(englishStrings.webSearchSaved)).toBeTruthy();
  });

  it("says its texts in German", async () => {
    await own(undefined, germanStrings);
    expect(screen.getByRole("radio", { name: germanStrings.webSearchChoiceOff })).toBeTruthy();
    expect(screen.getByRole("button", { name: germanStrings.webSearchSave })).toBeTruthy();
  });
});

describe("in the Tools page", () => {
  function draw(tools: ToolsPageViewModel) {
    const w = mount(ToolsPage, { props: { tools }, attachTo: document.body });
    wrappers.push(w);
    return w;
  }

  it("shows no row without a store", async () => {
    const tools = new ToolsPageViewModel({ catalog: new FakeCatalog() });
    tools.selectTab("app");
    draw(tools);
    await settle();
    expect(screen.queryByText(englishStrings.webSearchRowName)).toBeNull();
    tools.dispose();
  });

  it("shows the row, opens the sheet and closes it on Cancel", async () => {
    const tools = new ToolsPageViewModel({ catalog: new FakeCatalog(), webSearch: new MemoryWebSearchStore() });
    tools.selectTab("app");
    draw(tools);
    await settle();
    expect(screen.getByText(englishStrings.webSearchRowName)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /Set up/ }));
    await settle();
    expect(screen.getByRole("radio", { name: englishStrings.webSearchChoiceBrave })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: englishStrings.webSearchCancel }));
    await settle();
    expect(screen.queryByRole("radio", { name: englishStrings.webSearchChoiceBrave })).toBeNull();
    tools.dispose();
  });
});
