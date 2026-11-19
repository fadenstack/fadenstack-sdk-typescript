// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, immediateScheduler } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-react";
import { FakeGateway } from "@fadenstack/testing";
import { computedRules, fakeLayout, menuBox } from "../../ui-web/test/panelLayout.js";
import { testServices } from "./services.js";

// The menus inside a 420 px panel, React skin (the Vue skin's menuLayout.test.ts says the same). jsdom has no layout, so the rules of
// styles.css are cascaded onto the real elements and the measurements come from a model of the panel (ui-web/test/panelLayout.ts).

afterEach(() => { cleanup(); });

async function panel() {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant" }], model: () => ({ text: "ok" }) });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  const chat = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, automaticLanguage: "en" });
  await act(() => chat.initialize());
  return render(<div style={{ width: "420px" }}><ChatPanel chat={chat} /></div>);
}

describe("the menus in a 420 px panel", () => {
  let undo: () => void;
  beforeEach(() => {
    // The tool mode sits at the start edge (12 to 100), the thinking pill beside it, History and Settings at the end edge.
    undo = fakeLayout(420, (anchor) => {
      if (anchor.querySelector(".fdn-reasoning-button")) return [108, 230];
      if (anchor.querySelector(".fdn-mode-button")) return [12, 100];
      if (anchor.querySelector('[aria-haspopup="menu"][title="Chat history"]')) return [330, 362];
      return [372, 404];
    });
  });
  afterEach(() => { undo(); });

  const insidePanel = (menu: HTMLElement) => {
    const box = menuBox(menu);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(420);
  };

  it("keeps the tool-mode menu inside by opening it towards the end edge, and its entries start at one x", async () => {
    await panel();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Tool mode: / })); });
    const menu = screen.getByRole("menu", { name: "Tool mode" });
    expect(menu.style.insetInlineStart).toBe("0");
    insidePanel(menu);
    const checks = [...menu.querySelectorAll<HTMLElement>(".fdn-menu-check")];
    expect(checks.length).toBeGreaterThanOrEqual(4);
    for (const check of checks) {
      const rules = computedRules(check);
      expect(rules.get("flex")).toBe("none"); // never shrinks, however long the description
      expect(rules.get("width")).toBe("16px");
    }
  });

  it("keeps the settings, history and thinking menus inside", async () => {
    await panel();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Settings" })); });
    insidePanel(screen.getByRole("menu", { name: "Settings" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Chat history" })); });
    insidePanel(screen.getByRole("menu", { name: "Chat history" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Thinking: / })); });
    insidePanel(screen.getByRole("menu", { name: "How long it thinks" }));
  });
});
