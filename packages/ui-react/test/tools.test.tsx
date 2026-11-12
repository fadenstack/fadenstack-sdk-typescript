// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, MemoryClipboard, MemoryPreferenceStore, immediateScheduler, type AgentChatOptions } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-react";
import { FakeGateway, type FakeAgent } from "@fadenstack/testing";

afterEach(cleanup);

const SERVER_TOOLS = [
  { name: "mcp.github.search", server: "github", description: "Searches <b>issues</b> and pull requests", allowed: true, enabled: true },
  { name: "mcp.github.merge", server: "github", description: "Merges", allowed: false, enabled: true },
  { name: "mcp.wiki.read", server: "wiki", description: "Reads a page", allowed: true, enabled: false },
];

async function panel(agent: Partial<FakeAgent> = {}, options: AgentChatOptions = {}, failTools = false) {
  const gateway = new FakeGateway({
    agents: [{ slug: "page", name: "Page assistant", contract: [{ name: "read_page", risk: "read" }, { name: "fill_field", risk: "write" }], ...agent }],
  });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (failTools && url.endsWith("/tools")) return Promise.resolve(new Response(JSON.stringify({ detail: "no" }), { status: 403, headers: { "content-type": "application/json" } }));
    return gateway.fetch(input, init);
  }) as typeof fetch;
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: fetchImpl });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const built = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals)
    .addTools(
      defineTool({ name: "read_page", description: "Reads the page", toolClass: "read", run: () => "x" }),
      defineTool({ name: "fill_field", description: "Fills a field", toolClass: "write", run: () => "x" }),
    ).build();
  const chat = new AgentChatViewModel(built, approvals, {
    scheduler: immediateScheduler, clipboard: new MemoryClipboard(), preferences: new MemoryPreferenceStore(), locale: "en-GB", ...options,
  });
  await act(() => chat.initialize());
  render(<ChatPanel chat={chat} />);
  return { chat };
}

async function openTools() {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Tools" }));
  });
}

describe("the Tools view (React)", () => {
  it("opens from the settings like About: a dialog, the focus on Close, the settings closed, the gear still pressed", async () => {
    await panel({ serverTools: SERVER_TOOLS });
    await openTools();
    const dialog = await screen.findByRole("dialog", { name: "Tools" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Settings" }).className).toBe("fdn-icon-button fdn-open");
    expect(within(dialog).queryAllByRole("switch")).toEqual([]); // read only
    expect(dialog.querySelectorAll("input")).toHaveLength(0);
  });

  it("shows the app's tools with their class and the server's tools by server with a status", async () => {
    await panel({ serverTools: SERVER_TOOLS });
    await openTools();
    const dialog = await screen.findByRole("dialog", { name: "Tools" });
    await waitFor(() => expect(within(dialog).getAllByRole("group", { name: /github|wiki/ }).length).toBe(2));
    const app = within(dialog).getByRole("group", { name: "In this app" });
    expect([...app.querySelectorAll("li")].map((li) => [li.querySelector(".fdn-tools-name")!.textContent, li.querySelector(".fdn-badge")!.textContent, li.querySelector(".fdn-badge")!.className])).toEqual([
      ["read_page", "Read", "fdn-badge fdn-class-read"],
      ["fill_field", "Changes data", "fdn-badge fdn-class-write"],
    ]);
    const server = within(dialog).getByRole("group", { name: "From your organisation's server" });
    const github = within(server).getByRole("group", { name: "github" });
    expect([...github.querySelectorAll("li")].map((li) => [li.querySelector(".fdn-tools-name")!.textContent, li.querySelector(".fdn-badge")!.textContent])).toEqual([
      ["mcp.github.search", "Available to this agent"],
      ["mcp.github.merge", "Not allowed for this agent"],
    ]);
    expect(within(server).getByRole("group", { name: "wiki" }).querySelector(".fdn-badge")!.textContent).toBe("Switched off by your administrator");
  });

  it("draws a server's description as plain text with dir=auto, never as HTML", async () => {
    await panel({ serverTools: SERVER_TOOLS });
    await openTools();
    const description = await screen.findByText("Searches <b>issues</b> and pull requests");
    expect(description.getAttribute("dir")).toBe("auto");
    expect(description.querySelector("b")).toBeNull();
  });

  it("shows a loading note, then the empty state for a server without the list (not an error)", async () => {
    await panel({});
    await openTools();
    await waitFor(() => expect(screen.getByText("No tools from your server")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the tools could not be listed when the server fails, and tries again", async () => {
    const { chat } = await panel({ serverTools: SERVER_TOOLS }, {}, true);
    await openTools();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The tools could not be listed right now"));
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(chat.tools.failed).toBe(true);
  });

  it("closes with Escape and gives the focus back to the gear; also with Close and a press outside", async () => {
    const { chat } = await panel({ serverTools: SERVER_TOOLS });
    const gear = screen.getByRole("button", { name: "Settings" });
    await openTools();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(gear);
    await openTools();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(chat.isToolsOpen).toBe(false);
    await openTools();
    fireEvent.pointerDown(screen.getByRole("textbox"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("speaks German", async () => {
    await panel({ serverTools: SERVER_TOOLS }, { automaticLanguage: "de" });
    fireEvent.click(screen.getByRole("button", { name: "Einstellungen" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Tools" }));
    });
    const dialog = await screen.findByRole("dialog", { name: "Tools" });
    await waitFor(() => expect(within(dialog).getByText("Für diesen Agenten nicht erlaubt")).toBeTruthy());
    expect(within(dialog).getByText("In dieser App")).toBeTruthy();
    expect(within(dialog).getByText("Vom Server Ihrer Organisation")).toBeTruthy();
    expect(within(dialog).getByText("Ändert Daten")).toBeTruthy();
  });
});
