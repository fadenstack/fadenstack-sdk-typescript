// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, MemoryClipboard, immediateScheduler } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-react";
import { FakeGateway, lastToolResults, type FakeModel } from "@fadenstack/testing";

afterEach(cleanup);

async function panel(model: FakeModel, risk: "write" | "destructive" = "write") {
  const gateway = new FakeGateway({
    agents: [{
      slug: "page", name: "Page assistant", ui: { greeting: "I read the page you are on.", suggestions: ["Summarise this page"] },
      contract: [{ name: "fill_field", risk }],
    }],
    model,
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const filled: string[] = [];
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder()
    .useClient(client)
    .useSessionStore(new MemorySessionStore())
    .useApprovals(approvals)
    .addTools(defineTool<{ value: string }>({
      name: "fill_field", toolClass: "write",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      run: ({ value }) => {
        filled.push(value);
        return "filled";
      },
    }))
    .build();
  const clipboard = new MemoryClipboard();
  const chat = new AgentChatViewModel(agent, approvals, { scheduler: immediateScheduler, clipboard });
  await act(() => chat.initialize());
  render(<ChatPanel chat={chat} />);
  return { chat, filled, clipboard };
}

describe("ChatPanel", () => {
  it("shows the agent's greeting and suggestions, and follows the browser's theme", async () => {
    await panel(() => ({ text: "ok" }));
    expect(screen.getByText("Page assistant")).toBeTruthy();
    expect(screen.getByText("I read the page you are on.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Summarise this page" })).toBeTruthy();
    expect(document.querySelector(".fdn-chat")!.getAttribute("data-theme")).toBe("system");
    expect(document.querySelector(".fdn-empty-mark .fdn-agent-avatar")).toBeTruthy();
  });

  it("sends with Enter and renders the answer as Markdown, never as HTML", async () => {
    await panel(() => ({ text: "**Bold** and <b>not bold</b>\n\n```js\nlet x = 1;\n```" }));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Hello" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await waitFor(() => expect(screen.getByText("Bold").tagName).toBe("STRONG"));
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(document.querySelector(".fdn-md b")).toBeNull();
    expect(screen.getByText("let x = 1;").tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  });

  it("copies a table of an answer for a spreadsheet", async () => {
    const { clipboard } = await panel(() => ({ text: "| Task | Interval |\n|---|---|\n| Seal check | 2 000 h |" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Intervals?" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Copy table" }));
    expect(clipboard.lastText).toBe("Task\tInterval\nSeal check\t2 000 h");
    expect(clipboard.lastHtml).toContain("<td>Seal check</td>");
  });

  it("asks with a card and runs the tool when Allow is clicked", async () => {
    const { filled } = await panel((r) => (lastToolResults(r).size ? { text: "Filled in." }
      : { toolCalls: [{ name: "fill_field", arguments: { value: "Jane" } }] }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fill my name" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    const allow = await screen.findByRole("button", { name: "Allow" });
    expect(screen.getByText("Run fill_field?")).toBeTruthy();
    expect(screen.getByText("value: Jane")).toBeTruthy();
    await act(async () => {
      fireEvent.click(allow);
    });
    await waitFor(() => expect(screen.getByText("Filled in.")).toBeTruthy());
    expect(filled).toEqual(["Jane"]);
    expect(screen.getByText("Allowed")).toBeTruthy();
    expect(screen.getByText("Ran fill_field")).toBeTruthy();
  });

  it("lets the user pick a tool mode", async () => {
    const { chat } = await panel(() => ({ text: "ok" }));
    fireEvent.click(screen.getByRole("button", { name: /Tool mode/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: /Read only/ }));
    });
    expect(chat.toolMode).toBe("read_only");
  });

  it("offers Allow for this chat and Allow always for a tool that changes something", async () => {
    await panel((r) => (lastToolResults(r).size ? { text: "Filled in." } : { toolCalls: [{ name: "fill_field", arguments: { value: "Jane" } }] }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fill my name" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(await screen.findByRole("button", { name: "Allow for this chat" })).toBeTruthy();
    const always = screen.getByRole("button", { name: "Allow always" });
    await act(async () => {
      fireEvent.click(always);
    });
    await waitFor(() => expect(screen.getByText("Allowed always")).toBeTruthy());
  });

  it("offers only Allow and Deny for a tool that cannot be undone", async () => {
    await panel((r) => (lastToolResults(r).size ? { text: "Sent." } : { toolCalls: [{ name: "fill_field", arguments: { value: "Jane" } }] }), "destructive");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Send it" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(await screen.findByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow for this chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow always" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    });
  });

  it("resets approvals from the tool-mode menu", async () => {
    const { chat } = await panel(() => ({ text: "ok" }));
    fireEvent.click(screen.getByRole("button", { name: /Tool mode/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Reset approvals" }));
    });
    expect(chat.isModeMenuOpen).toBe(false);
  });
});
