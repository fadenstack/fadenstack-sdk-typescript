// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryWebSearchStore } from "@fadenstack/agents";
import { ToolsPageViewModel, WebSearchSettingsViewModel, englishStrings, germanStrings } from "@fadenstack/ui";
import { ToolsPage, WebSearchSettings } from "@fadenstack/ui-react";

import { FakeCatalog } from "../../ui/test/toolsFakes.js";

// The web search settings sheet in the React skin: on its own, and inside the Tools page on "In this app".

afterEach(cleanup);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function own(store = new MemoryWebSearchStore(), strings = englishStrings) {
  const vm = new WebSearchSettingsViewModel({ store, strings: () => strings });
  await vm.ready;
  const view = render(<WebSearchSettings settings={vm} />);
  return { vm, store, ...view };
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
    const store = new MemoryWebSearchStore();
    const { container } = await own(store);
    fireEvent.click(screen.getByRole("radio", { name: englishStrings.webSearchChoiceBrave }));
    const box = container.querySelector<HTMLInputElement>("input[type=password]")!;
    expect(box.autocomplete).toBe("off");
    expect(box.value).toBe("");
    expect(box.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("shows a kept key as saved, with Replace and Remove key, and never its value", async () => {
    const store = new MemoryWebSearchStore();
    await store.setBraveKey("BSA-hidden");
    await store.save({ provider: "brave" });
    const { container } = await own(store);
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(screen.getByText(englishStrings.webSearchKeyKept)).toBeTruthy();
    expect(screen.getByRole("button", { name: englishStrings.webSearchKeyReplace })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: englishStrings.webSearchKeyRemove }));
    expect(screen.getByText(englishStrings.webSearchKeyRemoved)).toBeTruthy();
    expect(container.innerHTML).not.toContain("BSA-hidden");
  });

  it("types an address, refuses http and saves https", async () => {
    const { store } = await own();
    fireEvent.click(screen.getByRole("radio", { name: englishStrings.webSearchChoiceSearxng }));
    const box = screen.getByLabelText(englishStrings.webSearchUrlLabel);
    fireEvent.change(box, { target: { value: "http://search.example.org" } });
    fireEvent.click(screen.getByRole("button", { name: englishStrings.webSearchSave }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(englishStrings.webSearchUrlRefused);
    fireEvent.change(box, { target: { value: "https://search.example.org" } });
    fireEvent.click(screen.getByRole("button", { name: englishStrings.webSearchSave }));
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
  function page(store?: MemoryWebSearchStore) {
    const tools = new ToolsPageViewModel({ catalog: new FakeCatalog(), ...(store ? { webSearch: store } : {}) });
    return tools;
  }

  it("shows no row without a store", async () => {
    const tools = page();
    tools.selectTab("app");
    render(<ToolsPage tools={tools} />);
    expect(screen.queryByText(englishStrings.webSearchRowName)).toBeNull();
    tools.dispose();
  });

  it("shows the row, opens the sheet and closes it on Cancel", async () => {
    const tools = page(new MemoryWebSearchStore());
    tools.selectTab("app");
    render(<ToolsPage tools={tools} />);
    await settle();
    expect(screen.getByText(englishStrings.webSearchRowName)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Set up/ }));
    await settle();
    expect(screen.getByRole("radio", { name: englishStrings.webSearchChoiceBrave })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: englishStrings.webSearchCancel }));
    expect(screen.queryByRole("radio", { name: englishStrings.webSearchChoiceBrave })).toBeNull();
    tools.dispose();
  });
});
