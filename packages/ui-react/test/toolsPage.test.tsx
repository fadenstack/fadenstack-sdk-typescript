// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalServerState } from "@fadenstack/agents";
import { ServerSheetViewModel, englishStrings, germanStrings, type UiStrings } from "@fadenstack/ui";
import { ToolsPage } from "@fadenstack/ui-react";

import { SECRET, serverInfo } from "../../ui/test/toolsFakes.js";
import { TOOLS_STATES, ToolsHarness, reachTools, type ToolsState } from "./toolsHarness.js";

// The Tools view of the React skin, over the real view models on a catalog in memory.

const harnesses: ToolsHarness[] = [];
afterEach(() => {
  cleanup();
  for (const h of harnesses.splice(0)) h.dispose();
  vi.restoreAllMocks();
});

async function at(state: ToolsState, strings: UiStrings = englishStrings) {
  const made = await reachTools(state, strings);
  harnesses.push(made.h);
  return made;
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("every state renders", () => {
  it.each(TOOLS_STATES)("%s", async (state) => {
    const { tools } = await at(state);
    const { container } = render(<ToolsPage tools={tools} />);
    expect(container.querySelector(".fdn-toolspage")).not.toBeNull();
    expect(container.textContent!.length).toBeGreaterThan(20);
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
    const { container } = render(<ToolsPage tools={tools} />);
    expect(container.querySelector(".fdn-toolspage")!.getAttribute("lang")).toBe("de");
    expect(screen.getByRole("button", { name: germanStrings.toolsOpenDetails("notes") })).toBeTruthy();
  });
});

describe("the tabs and the cards", () => {
  it("switches between the tabs, with the arrow keys too, and filters", async () => {
    const { tools } = await at("cloud");
    tools.selectTab(true);
    render(<ToolsPage tools={tools} />);
    const local = screen.getByRole("tab", { name: /On this computer/ });
    expect(local.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(local, { key: "ArrowRight" });
    expect(tools.showsServer).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: englishStrings.toolsFilterPlaceholder }), { target: { value: "search" } });
    expect(tools.cloudGroups.map((g) => g.server)).toEqual(["wiki"]);
  });

  it("switches a server on and off from its card", async () => {
    const { tools, catalog } = await at("list");
    render(<ToolsPage tools={tools} />);
    fireEvent.click(screen.getByRole("switch", { name: "Switch calendar on or off" }));
    await settle();
    expect(catalog.enabledCalls).toEqual([{ label: "calendar", enabled: true }]);
  });

  it("opens the details from the card's name, and Esc closes them", async () => {
    const { tools } = await at("list");
    render(<ToolsPage tools={tools} />);
    fireEvent.click(screen.getByRole("button", { name: "Show details of notes" }));
    expect(screen.getByRole("heading", { name: "notes, MCP server" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("heading", { name: "notes, MCP server" }), { key: "Escape" });
    expect(tools.isDetailsOpen).toBe(false);
  });

  it("raises a tool from its picker and never offers one for a destructive tool", async () => {
    const { tools, catalog } = await at("details");
    render(<ToolsPage tools={tools} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Class of write_note" }), { target: { value: "write" } });
    await settle();
    expect(catalog.raiseCalls).toEqual([{ label: "notes", tool: "write_note", raise: "write" }]);
    expect(screen.queryByRole("combobox", { name: "Class of delete_note" })).toBeNull();
    expect(screen.getByText(englishStrings.toolsDestructiveHelp)).toBeTruthy();
  });

  it("shows the trust mark as the administrator's, without a way to change it", async () => {
    const { tools } = await at("detailsAdmin");
    render(<ToolsPage tools={tools} />);
    expect((screen.getByRole("switch", { name: "Trust notes" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(englishStrings.toolsTrustedByAdmin)).toBeTruthy();
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("Advanced: the plain-http switch", () => {
  it("is not shown where plain http is not permitted", async () => {
    const { tools, catalog } = await at("details");
    expect(catalog.plainHttpPermitted).toBe(false);
    render(<ToolsPage tools={tools} />);
    expect(screen.queryByText(englishStrings.mcpPlainHttpSwitch)).toBeNull();
    expect(screen.queryByText(englishStrings.toolsAdvanced)).toBeNull();
  });

  it("opens the warning with Confirm focused, and changes nothing until Confirm", async () => {
    const { tools, catalog } = await at("detailsAdvanced");
    render(<ToolsPage tools={tools} />);
    const toggle = screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }) as HTMLInputElement;
    fireEvent.click(toggle);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(englishStrings.mcpPlainHttpWarning);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: englishStrings.mcpPlainHttpConfirm }));
    expect(catalog.switchCalls).toEqual([]);
    expect((screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: englishStrings.mcpPlainHttpConfirm }));
    await settle();
    expect(catalog.switchCalls).toEqual([{ label: "nas", on: true, version: "2026-11-15" }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }) as HTMLInputElement).checked).toBe(true);
  });

  it("is cancelled with Esc: the switch stays off, nothing was asked, and the focus returns to the switch", async () => {
    const { tools, catalog } = await at("warning");
    render(<ToolsPage tools={tools} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: englishStrings.mcpPlainHttpConfirm }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(catalog.switchCalls).toEqual([]);
    expect(tools.isDetailsOpen).toBe(true); // Esc closed the warning only
    expect(document.activeElement).toBe(screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }));
  });

  it("is cancelled with Keep it off, and turning it off needs no warning", async () => {
    const { tools, catalog } = await at("warning");
    render(<ToolsPage tools={tools} />);
    fireEvent.click(screen.getByRole("button", { name: englishStrings.mcpPlainHttpCancel }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    catalog.localServers = [serverInfo("nas", { where: "http://192.168.1.5:8931/mcp", plainHttpApplies: true, plainHttpInLan: true, state: LocalServerState.Running })];
    catalog.changed();
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: englishStrings.mcpPlainHttpSwitch }));
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(catalog.switchCalls).toEqual([{ label: "nas", on: false, version: undefined }]);
  });
});

describe("secrets", () => {
  it("shows a saved header value as dots and Replace, never the value", async () => {
    const { tools } = await at("editSheet");
    const { container } = render(<ToolsPage tools={tools} />);
    expect(screen.getByRole("img", { name: /Authorization/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace Authorization" })).toBeTruthy();
    expect(container.innerHTML).not.toContain("s3cr3t");
  });

  it("clears a typed header value from the inputs after Save", async () => {
    const { tools, catalog } = await at("addSheet");
    const { container } = render(<ToolsPage tools={tools} />);
    fireEvent.change(screen.getByRole("textbox", { name: englishStrings.toolsFieldLabel }), { target: { value: "api" } });
    fireEvent.change(screen.getByRole("textbox", { name: englishStrings.toolsFieldUrl }), { target: { value: "https://api.example.com/mcp" } });
    fireEvent.click(screen.getAllByRole("button", { name: englishStrings.toolsAddRow })[0]!); // the header row's Add comes before the sheet's own
    fireEvent.change(screen.getByRole("textbox", { name: `${englishStrings.toolsRowName} (${englishStrings.toolsFieldHeaders})` }), { target: { value: "Authorization" } });
    const value = container.querySelector<HTMLInputElement>("input[type=password]")!;
    fireEvent.change(value, { target: { value: SECRET } });
    expect(value.value).toBe(SECRET);
    const row = (tools.sheet as ServerSheetViewModel).headerRows[0]!;

    fireEvent.click(container.querySelector<HTMLButtonElement>("button[type=submit]")!);
    await settle();
    expect(catalog.saved[0]!.draft.headers[0]).toMatchObject({ name: "Authorization", value: SECRET });
    expect(row.value).toBe("");
    expect(tools.hasSheet).toBe(false);
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(container.innerHTML).not.toContain("s3cr3t");
  });

  it("clears it on Cancel, and keeps it on a refused Save so the person can correct the sheet", async () => {
    const { tools } = await at("addError");
    const { container } = render(<ToolsPage tools={tools} />);
    const field = container.querySelector<HTMLInputElement>("input[type=password]")!;
    expect(field.value).toBe(SECRET);
    fireEvent.click(screen.getByRole("button", { name: englishStrings.toolsCancel }));
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(container.innerHTML).not.toContain("s3cr3t");
  });
});

describe("the paste import", () => {
  it("reads, lists, ticks and imports; the pasted text is gone once read", async () => {
    const { tools, catalog } = await at("pasteEmpty");
    catalog.preview = { problem: "none", servers: [{ label: "remote", where: "https://r.example.com/mcp", notes: [] }], skipped: [] };
    render(<ToolsPage tools={tools} />);
    const text = screen.getByRole("textbox", { name: englishStrings.toolsPasteField }) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "{ \"mcpServers\": {} }" } });
    fireEvent.click(screen.getByRole("button", { name: englishStrings.toolsPasteRead }));
    await settle();
    expect(text.value).toBe("");
    fireEvent.click(screen.getByRole("checkbox", { name: "Import remote" }));
    fireEvent.click(screen.getByRole("button", { name: englishStrings.toolsImportButton }));
    await settle();
    expect(catalog.imported).toEqual([{ labels: ["remote"] }]);
    expect(screen.getByText("Added: 1")).toBeTruthy();
  });
});
