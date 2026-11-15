// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { fireEvent, screen } from "@testing-library/react"; // its queries and events are the DOM testing library's; no React is drawn here
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalServerState } from "@fadenstack/agents";
import { ServerSheetViewModel, englishStrings, germanStrings, type UiStrings } from "@fadenstack/ui";
import { ToolsPage } from "@fadenstack/ui-vue";

import { FakeCatalog, SECRET, serverInfo } from "../../ui/test/toolsFakes.js";
import { TOOLS_STATES, ToolsHarness, reachTools, type ToolsState } from "../../ui-react/test/toolsHarness.js";

// The same checks as @fadenstack/ui-react's toolsPage.test.tsx, on the Vue skin (parity), over the real view models on a catalog in memory.

const wrappers: VueWrapper[] = [];
const harnesses: ToolsHarness[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  for (const h of harnesses.splice(0)) h.dispose();
  vi.restoreAllMocks();
});

async function at(state: ToolsState, strings: UiStrings = englishStrings) {
  const made = await reachTools(state, strings);
  harnesses.push(made.h);
  return made;
}
function draw(tools: Awaited<ReturnType<typeof at>>["tools"]): HTMLElement {
  const w = mount(ToolsPage, { props: { tools }, attachTo: document.body });
  wrappers.push(w);
  return w.element as HTMLElement;
}
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await flushPromises(); };

describe("every state renders", () => {
  it.each(TOOLS_STATES)("%s", async (state) => {
    const { tools } = await at(state);
    const root = draw(tools);
    expect(root.classList.contains("fdn-toolspage")).toBe(true);
    expect(root.textContent!.length).toBeGreaterThan(20);
    if (state === "signedOut") expect(screen.getByText(englishStrings.toolsSignInNeeded)).toBeTruthy();
    if (state === "empty") expect(screen.getByText(englishStrings.toolsEmptyTitle)).toBeTruthy();
    if (state === "list") {
      expect(screen.getByRole("button", { name: "Show details of notes" })).toBeTruthy();
      expect(screen.getByText("Can’t start: X-Api-Key has no value")).toBeTruthy();
      expect(screen.getByText(englishStrings.mcpPlainHttpNoOptIn)).toBeTruthy();
      expect(screen.getByText("Plain http is not allowed here.")).toBeTruthy();
      expect(screen.getByLabelText("delete_note, may delete")).toBeTruthy();
    }
    if (state === "notAllowed") expect(screen.getByText(englishStrings.toolsBannerNotAllowed, { selector: "p" })).toBeTruthy();
    if (state === "cloud") expect(screen.getByRole("button", { name: "Collapse crm" })).toBeTruthy();
    if (state === "cloudUnavailable") expect(screen.getByRole("button", { name: englishStrings.toolsTryAgain })).toBeTruthy();
    if (state === "details") expect(screen.getByRole("switch", { name: "Trust notes" })).toBeTruthy();
    if (state === "addError") expect(screen.getByRole("alert").textContent).toBe(englishStrings.toolsProblemPlainHttpWithHeaders);
  });

  it("says its texts in German too", async () => {
    const { tools } = await at("list", germanStrings);
    const root = draw(tools);
    expect(root.getAttribute("lang")).toBe("de");
    expect(screen.getByRole("button", { name: germanStrings.toolsOpenDetails("notes") })).toBeTruthy();
  });
});

describe("the tabs and the cards", () => {
  it("switches between the tabs, with the arrow keys too, and filters", async () => {
    const { tools } = await at("cloud");
    tools.selectTab("computer");
    draw(tools);
    const local = screen.getByRole("tab", { name: /On this computer/ });
    expect(local.getAttribute("aria-selected")).toBe("true");
    await fireEvent.keyDown(local, { key: "ArrowRight" });
    expect(tools.showsServer).toBe(true);
    await fireEvent.input(screen.getByRole("textbox", { name: englishStrings.toolsFilterPlaceholder }), { target: { value: "search" } });
    expect(tools.cloudGroups.map((g) => g.server)).toEqual(["wiki"]);
  });

  it("switches a server on and off from its card", async () => {
    const { tools, catalog } = await at("list");
    draw(tools);
    const box = screen.getByRole("switch", { name: "Switch calendar on or off" }) as HTMLInputElement;
    box.checked = true;
    await fireEvent.change(box);
    await settle();
    expect(catalog.enabledCalls).toEqual([{ label: "calendar", enabled: true }]);
  });

  it("opens the details from the card's name, and Esc closes them", async () => {
    const { tools } = await at("list");
    draw(tools);
    await fireEvent.click(screen.getByRole("button", { name: "Show details of notes" }));
    await settle();
    const heading = screen.getByRole("heading", { name: "notes, MCP server" });
    await fireEvent.keyDown(heading, { key: "Escape" });
    expect(tools.isDetailsOpen).toBe(false);
  });

  it("raises a tool from its picker and never offers one for a destructive tool", async () => {
    const { tools, catalog } = await at("details");
    draw(tools);
    const select = screen.getByRole("combobox", { name: "Class of write_note" }) as HTMLSelectElement;
    select.value = "write";
    await fireEvent.change(select);
    await settle();
    expect(catalog.raiseCalls).toEqual([{ label: "notes", tool: "write_note", raise: "write" }]);
    expect(screen.queryByRole("combobox", { name: "Class of delete_note" })).toBeNull();
    expect(screen.getByText(englishStrings.toolsDestructiveHelp)).toBeTruthy();
  });

  it("shows the trust mark as the administrator's, without a way to change it", async () => {
    const { tools } = await at("detailsAdmin");
    draw(tools);
    expect((screen.getByRole("switch", { name: "Trust notes" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(englishStrings.toolsTrustedByAdmin)).toBeTruthy();
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("Advanced: the plain-http switch", () => {
  it("is not shown where plain http is not permitted", async () => {
    const { tools, catalog } = await at("details");
    expect(catalog.plainHttpPermitted).toBe(false);
    draw(tools);
    expect(screen.queryByText(englishStrings.mcpPlainHttpSwitch)).toBeNull();
    expect(screen.queryByText(englishStrings.toolsAdvanced)).toBeNull();
  });

  it("opens the warning with Confirm focused, and changes nothing until Confirm", async () => {
    const { tools, catalog } = await at("detailsAdvanced");
    draw(tools);
    const toggle = screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }) as HTMLInputElement;
    toggle.checked = true;
    await fireEvent.change(toggle);
    await settle();
    expect(screen.getByRole("alertdialog").textContent).toContain(englishStrings.mcpPlainHttpWarning);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: englishStrings.mcpPlainHttpConfirm }));
    expect(catalog.switchCalls).toEqual([]);
    expect((screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }) as HTMLInputElement).checked).toBe(false);

    await fireEvent.click(screen.getByRole("button", { name: englishStrings.mcpPlainHttpConfirm }));
    await settle();
    expect(catalog.switchCalls).toEqual([{ label: "nas", on: true, version: "2026-11-15" }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }) as HTMLInputElement).checked).toBe(true);
  });

  it("is cancelled with Esc: the switch stays off, nothing was asked, and the focus returns to the switch", async () => {
    const { tools, catalog } = await at("warning");
    draw(tools);
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: englishStrings.mcpPlainHttpConfirm }));
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(catalog.switchCalls).toEqual([]);
    expect(tools.isDetailsOpen).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }));
  });

  it("is cancelled with Keep it off, and turning it off needs no warning", async () => {
    const { tools, catalog } = await at("warning");
    draw(tools);
    await fireEvent.click(screen.getByRole("button", { name: englishStrings.mcpPlainHttpCancel }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    catalog.localServers = [serverInfo("nas", { where: "http://192.168.1.5:8931/mcp", plainHttpApplies: true, plainHttpInLan: true, state: LocalServerState.Running })];
    catalog.changed();
    await settle();
    const toggle = screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }) as HTMLInputElement;
    toggle.checked = false;
    await fireEvent.change(toggle);
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(catalog.switchCalls).toEqual([{ label: "nas", on: false, version: undefined }]);
  });
});

describe("secrets", () => {
  it("shows a saved header value as dots and Replace, never the value", async () => {
    const { tools } = await at("editSheet");
    const root = draw(tools);
    expect(screen.getByRole("img", { name: /Authorization/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace Authorization" })).toBeTruthy();
    expect(root.innerHTML).not.toContain("s3cr3t");
  });

  it("clears a typed header value from the inputs after Save", async () => {
    const { tools, catalog } = await at("addSheet");
    const root = draw(tools);
    await fireEvent.input(screen.getByRole("textbox", { name: englishStrings.toolsFieldLabel }), { target: { value: "api" } });
    await fireEvent.input(screen.getByRole("textbox", { name: englishStrings.toolsFieldUrl }), { target: { value: "https://api.example.com/mcp" } });
    await fireEvent.click(screen.getAllByRole("button", { name: englishStrings.toolsAddRow })[0]!);
    await fireEvent.input(screen.getByRole("textbox", { name: `${englishStrings.toolsRowName} (${englishStrings.toolsFieldHeaders})` }), { target: { value: "Authorization" } });
    const value = root.querySelector<HTMLInputElement>("input[type=password]")!;
    await fireEvent.input(value, { target: { value: SECRET } });
    expect(value.value).toBe(SECRET);
    const row = (tools.sheet as ServerSheetViewModel).headerRows[0]!;

    await fireEvent.click(root.querySelector<HTMLButtonElement>("button[type=submit]")!);
    await settle();
    expect(catalog.saved[0]!.draft.headers[0]).toMatchObject({ name: "Authorization", value: SECRET });
    expect(row.value).toBe("");
    expect(tools.hasSheet).toBe(false);
    expect(root.querySelector("input[type=password]")).toBeNull();
    expect(root.innerHTML).not.toContain("s3cr3t");
  });

  it("clears it on Cancel", async () => {
    const { tools } = await at("addError");
    const root = draw(tools);
    expect(root.querySelector<HTMLInputElement>("input[type=password]")!.value).toBe(SECRET);
    await fireEvent.click(screen.getByRole("button", { name: englishStrings.toolsCancel }));
    await settle();
    expect(root.querySelector("input[type=password]")).toBeNull();
    expect(root.innerHTML).not.toContain("s3cr3t");
  });
});

describe("the paste import", () => {
  it("reads, lists, ticks and imports; the pasted text is gone once read", async () => {
    const { tools, catalog } = await at("pasteEmpty");
    catalog.preview = { problem: "none", servers: [{ label: "remote", where: "https://r.example.com/mcp", notes: [] }], skipped: [] };
    draw(tools);
    const text = screen.getByRole("textbox", { name: englishStrings.toolsPasteField }) as HTMLTextAreaElement;
    await fireEvent.input(text, { target: { value: "{ \"mcpServers\": {} }" } });
    await fireEvent.click(screen.getByRole("button", { name: englishStrings.toolsPasteRead }));
    await settle();
    expect(text.value).toBe("");
    const tick = screen.getByRole("checkbox", { name: "Import remote" }) as HTMLInputElement;
    tick.checked = true;
    await fireEvent.change(tick);
    await fireEvent.click(screen.getByRole("button", { name: englishStrings.toolsImportButton }));
    await settle();
    expect(catalog.imported).toEqual([{ labels: ["remote"] }]);
    expect(screen.getByText("Added: 1")).toBeTruthy();
  });
});

describe("the tab In this app and the server tab", () => {
  function drawn(configure: (catalog: FakeCatalog) => void) {
    const catalog = new FakeCatalog([serverInfo("notes")]);
    configure(catalog);
    const h = new ToolsHarness(englishStrings, catalog);
    harnesses.push(h);
    const w = mount(ToolsPage, { props: { tools: h.page }, attachTo: document.body });
    wrappers.push(w);
    return { h, w, root: w.element as HTMLElement };
  }
  const tabs = (root: HTMLElement) => Array.from(root.querySelectorAll("[role=tab]")).map((t) => t.textContent);

  it("draws the app's tools with their class and the empty line", async () => {
    const { h, root } = drawn((c) => { c.appTools = [{ name: "read_page", description: "Reads the page", toolClass: "read" }]; });
    h.page.selectTab("app");
    await flushPromises();
    expect(root.querySelector("[role=tab][aria-selected=true]")!.textContent).toBe("In this app · 1");
    expect(root.textContent).toContain("read_page");
    expect(root.textContent).toContain("Reads the page");
    expect(root.textContent).toContain(englishStrings.approvalClass.read);
    const empty = drawn(() => undefined);
    empty.h.page.selectTab("app");
    await flushPromises();
    expect(empty.root.textContent).toContain("This app gives the assistant no tools of its own.");
  });

  it("shows no server tab in standalone and has it when governed, in order", () => {
    const standalone = drawn((c) => { c.governed = false; });
    expect(tabs(standalone.root)).toEqual(["In this app · 0", "On this computer · 1"]);
    expect(standalone.h.catalog.cloudCalls).toBe(0);
    expect(tabs(drawn(() => undefined).root)).toEqual(["In this app · 0", "On this computer · 1", expect.stringContaining("On your server")]);
  });
});
