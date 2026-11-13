// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import {
  AgentChatViewModel, ApprovalBroker, immediateScheduler, type AgentChatOptions, type TurnLease,
} from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-react";
import { FakeGateway } from "@fadenstack/testing";
import { testServices } from "./services.js";

// The thinking pill and its menu in the React skin (.NET ReasoningPillTests drives the same view model).

afterEach(cleanup);

async function panel(ui: Record<string, unknown> = {}, options: Partial<AgentChatOptions> = {}) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant", ui }], model: () => ({ text: "ok" }) });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  const chat = new AgentChatViewModel(agent, approvals, {
    ...testServices(), scheduler: immediateScheduler, automaticLanguage: "en", ...options,
  });
  await act(() => chat.initialize());
  render(<ChatPanel chat={chat} />);
  return { chat, agent };
}

const pill = (name = /^Thinking: /) => screen.getByRole("button", { name });
const items = (menu = "How long it thinks") => within(screen.getByRole("menu", { name: menu })).getAllByRole("menuitemradio");

describe("the thinking pill (React)", () => {
  it("shows the level beside the tool mode, in full to screen readers and in the tooltip", async () => {
    await panel();
    const button = pill();
    expect(button.textContent).toBe("Auto");
    expect(button.getAttribute("aria-label")).toBe("Thinking: Auto");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("title")).toBe("How long it thinks\nThinking: Auto. The agent's own setting.");
    expect(button.parentElement!.previousElementSibling!.querySelector(".fdn-mode-button")!.getAttribute("aria-label")).toMatch(/^Tool mode: /);
    expect(screen.queryByRole("menu", { name: "How long it thinks" })).toBeNull();
  });

  it("opens a menu of radios, marks the current level, and puts the focus on it", async () => {
    await panel();
    fireEvent.click(pill());
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    expect(items().map((i) => [i.querySelector(".fdn-menu-label")!.textContent, i.getAttribute("aria-checked")])).toEqual([
      ["Auto", "true"], ["Off", "false"], ["Low", "false"], ["Medium", "false"], ["High", "false"],
    ]);
    expect(items()[0]!.querySelector(".fdn-menu-description")!.textContent).toBe("The agent's own setting.");
    expect(items()[0]!.querySelector("svg")).toBeTruthy(); // the check
    expect(document.activeElement).toBe(items()[0]);
  });

  it("offers only the levels up to the server's maximum", async () => {
    await panel({ reasoning: { max: "low" } });
    fireEvent.click(pill());
    expect(items().map((i) => i.querySelector(".fdn-menu-label")!.textContent)).toEqual(["Auto", "Off", "Low"]);
  });

  it("moves with the arrows, wrapping, and with Home and End", async () => {
    await panel();
    fireEvent.click(pill());
    const [auto, off, , , high] = items();
    fireEvent.keyDown(auto!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(off);
    fireEvent.keyDown(off!, { key: "ArrowUp" });
    fireEvent.keyDown(auto!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(high);
    fireEvent.keyDown(high!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(auto);
    fireEvent.keyDown(auto!, { key: "End" });
    expect(document.activeElement).toBe(high);
    fireEvent.keyDown(high!, { key: "Home" });
    expect(document.activeElement).toBe(auto);
  });

  it("closes on Escape and gives the focus back to the pill", async () => {
    await panel();
    fireEvent.click(pill());
    fireEvent.keyDown(items()[2]!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "How long it thinks" })).toBeNull();
    expect(pill().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(pill());
  });

  it("closes on Escape pressed with the focus still on the pill", async () => {
    await panel();
    const button = pill();
    button.focus();
    fireEvent.click(button);
    button.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "How long it thinks" })).toBeNull();
  });

  it("closes on a press outside", async () => {
    await panel();
    fireEvent.click(pill());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "How long it thinks" })).toBeNull();
  });

  it("a pick closes the menu, shows in the pill, is kept for the agent, is marked on reopening, and the focus returns to the pill", async () => {
    const { agent } = await panel();
    fireEvent.click(pill());
    await act(async () => {
      fireEvent.click(items()[2]!);
    });
    expect(screen.queryByRole("menu", { name: "How long it thinks" })).toBeNull();
    expect(pill().textContent).toBe("Low");
    expect(pill().getAttribute("aria-label")).toBe("Thinking: Low");
    expect(document.activeElement).toBe(pill());
    await waitFor(() => expect(agent.reasoningChoice).toBe("low"));
    fireEvent.click(pill());
    expect(items().map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false", "false"]);
    expect(document.activeElement).toBe(items()[2]);
  });

  it("is in the panel's language", async () => {
    await panel({}, { automaticLanguage: "de" });
    expect(pill(/^Nachdenken: /).textContent).toBe("Auto");
    fireEvent.click(pill(/^Nachdenken: /));
    expect(items("Wie lange nachgedacht wird").map((i) => i.querySelector(".fdn-menu-label")!.textContent)).toEqual(["Auto", "Aus", "Niedrig", "Mittel", "Hoch"]);
    expect(screen.getByRole("menu", { name: "Wie lange nachgedacht wird" })).toBeTruthy();
  });
});

describe("waiting for a free slot (React)", () => {
  it("the turn says so while the gate holds it, and the line goes when the turn runs", async () => {
    let release!: (lease: TurnLease) => void;
    let entered = false;
    const { chat } = await panel({}, { turnGate: () => { entered = true; return new Promise<TurnLease>((r) => { release = r; }); } });
    let sending!: Promise<void>;
    act(() => {
      sending = chat.send("Go.");
    });
    await waitFor(() => expect(entered).toBe(true));
    await waitFor(() => expect(document.querySelector(".fdn-status")!.textContent).toContain("Waiting for a free slot"));
    await act(async () => {
      release(() => undefined);
      await sending;
    });
    expect(document.body.textContent).not.toContain("Waiting for a free slot");
  });

  it("is said in German", async () => {
    let entered = false;
    const { chat } = await panel({}, { automaticLanguage: "de", turnGate: (signal) => { entered = true; return new Promise<TurnLease>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); } });
    act(() => {
      void chat.send("Los.");
    });
    await waitFor(() => expect(entered).toBe(true));
    await waitFor(() => expect(document.querySelector(".fdn-status")!.textContent).toContain("Wartet auf einen freien Platz"));
    act(() => chat.stop());
  });
});
