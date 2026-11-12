// @vitest-environment jsdom
// The grant cards, the Bypass confirmation, the markers and Settings -> Approvals in both skins: the same markup from the
// same view model (compared element by element), and the rules a card keeps in a browser: Not now first and focused,
// Allow never the default, Enter and Escape never pressing it, a new card taking the focus.
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { GrantLifecycle } from "@fadenstack/agents";
import { GrantMarkerViewModel, englishStrings, type AgentChatViewModel } from "@fadenstack/ui";
import { ChatPanel as ReactPanel, GrantMarkerView as ReactMarker } from "@fadenstack/ui-react";
import { ChatPanel as VuePanel, GrantMarker as VueMarker } from "@fadenstack/ui-vue";

import { MIN, REPORT, BUDGET, conversation, grantChat, waitFor, type GrantChat } from "../../ui/test/grantsHelpers.js";
import { normalize } from "./helpers.js";

let wrappers: VueWrapper[] = [];
const disposables: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const w of wrappers) w.unmount();
  for (const d of disposables.splice(0)) d.dispose();
  wrappers = [];
  document.body.innerHTML = "";
});

/** Both panels on the same chat; `same()` compares them now. */
function both(chat: AgentChatViewModel) {
  const react = render(createElement(ReactPanel, { chat }));
  const vue = mount(VuePanel, { props: { chat }, attachTo: document.body });
  wrappers.push(vue);
  return {
    react, vue, q: within(react.container),
    async settle(): Promise<void> {
      await act(async () => {});
      await flushPromises();
    },
    async same(): Promise<void> {
      await this.settle();
      expect(normalize(vue.element)).toBe(normalize(react.container.firstElementChild!));
    },
  };
}

async function askBypass(s: GrantChat) {
  const done = s.chat.startBypass();
  const card = await waitFor(() => s.chat.grants.bypassCard);
  return { card, done };
}

describe("the Bypass confirmation in both skins", () => {
  it("draws the same card in both, Not now before the switch, the times shortest first, and no Allow focused", async () => {
    const s = await grantChat();
    const panels = both(s.chat);
    const { card, done } = await askBypass(s);
    await panels.same();

    const dom = panels.react.container;
    const names = [...dom.querySelectorAll(".fdn-bypass .fdn-grant-buttons button")].map((b) => b.textContent);
    expect(names).toEqual(["Not now", "Switch Bypass on"]);
    expect([...dom.querySelectorAll(".fdn-bypass [role=radio]")].map((b) => b.textContent)).toEqual(["15 min", "30 min", "1 h"]);
    expect(dom.querySelector(".fdn-bypass")!.textContent).toContain(englishStrings.bypassNoLongerAsks);
    const vueNames = panels.vue.findAll(".fdn-bypass .fdn-grant-buttons button").map((b) => b.text());
    expect(vueNames).toEqual(["Not now", "Switch Bypass on"]);
    card.notNow();
    await done;
  });

  it("gives the focus to Not now (React), and to nothing that switches Bypass on", async () => {
    const s = await grantChat();
    render(createElement(ReactPanel, { chat: s.chat }));
    const { card, done } = await askBypass(s);
    await act(async () => {});

    expect(document.activeElement?.textContent).toBe("Not now");
    expect(document.activeElement?.closest(".fdn-bypass")).not.toBeNull();
    card.notNow();
    await done;
  });

  it("gives the focus to Not now (Vue)", async () => {
    const s = await grantChat();
    const vue = mount(VuePanel, { props: { chat: s.chat }, attachTo: document.body });
    wrappers.push(vue);
    const { card, done } = await askBypass(s);
    await flushPromises();

    expect(document.activeElement?.textContent).toBe("Not now");
    card.notNow();
    await done;
  });

  it("is not answered by Enter or Escape, on the card or on its focused switch; only the click answers", async () => {
    const s = await grantChat();
    const panels = both(s.chat);
    const { card, done } = await askBypass(s);
    await panels.settle();

    const allow = panels.q.getByRole("button", { name: "Switch Bypass on" });
    // A key that would press the focused button has its default prevented; any other key is left alone.
    expect(fireEvent.keyDown(allow, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(allow, { key: "Escape" })).toBe(false);
    expect(fireEvent.keyDown(allow, { key: "a" })).toBe(true);
    fireEvent.keyDown(panels.react.container.querySelector(".fdn-bypass")!, { key: "Enter" });
    fireEvent.keyDown(panels.react.container.querySelector(".fdn-bypass")!, { key: "Escape" });
    const vueAllow = panels.vue.findAll("button").find((b) => b.text() === "Switch Bypass on")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true });
    vueAllow.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await panels.settle();

    expect(card.state).toBe("pending");
    expect(s.grants.made).toHaveLength(0);
    fireEvent.click(allow); // the click is the only answer
    await done;
    expect(card.state).toBe("on");
  });

  it("shows the second sign-in with its code and a secondary 'Open the page again', then Bypass on with its marker, Stop and the ended line", async () => {
    const s = await grantChat();
    const panels = both(s.chat);
    s.chat.selectToolMode("bypass");
    const card = await waitFor(() => s.chat.grants.bypassCard);
    // The sign-in waits for the person in the browser: hold the poll open while the card is looked at.
    const gate = { open: false };
    s.agent.stepUps.delay = async () => { while (!gate.open) await new Promise((r) => setTimeout(r, 2)); };
    s.grants.pendingPolls = 1;
    await panels.settle();
    fireEvent.click(panels.q.getByRole("button", { name: "Switch Bypass on" }));
    await waitFor(() => card.isSigningIn);
    await panels.same();

    expect(panels.react.container.textContent).toContain("The page shows the code BCDF-GHJK.");
    const again = panels.q.getByRole("button", { name: "Open the Bypass sign-in page again" });
    expect(again.textContent).toBe("Open the page again");
    expect(fireEvent.keyDown(again, { key: "Enter" })).toBe(false); // Enter does not press it
    fireEvent.click(again);
    expect(s.opened).toHaveLength(2);

    gate.open = true;
    await waitFor(() => card.state === "on");
    await panels.same();
    expect(panels.react.container.querySelector(".fdn-bypass-marker")!.textContent).toContain("Bypass on · 30 min left");
    expect(panels.vue.find(".fdn-bypass-marker").text()).toContain("Each tool that runs is recorded with what it was given.");

    fireEvent.click(panels.q.getByRole("button", { name: "Stop Bypass" }));
    await waitFor(() => s.chat.grants.hasBypassEnded && s.chat.grants.bypassEndedText.includes("you ended it"));
    await panels.same();
    expect(panels.react.container.querySelector(".fdn-bypass-ended")!.textContent).toContain("Bypass ended: you ended it. Approvals ask again.");
    expect(panels.q.getByRole("button", { name: "Switch Bypass on again" }).textContent).toBe("Switch on again");
  });

  it("says why when the server gives no acknowledgement, and the card can be closed", async () => {
    const s = await grantChat();
    s.grants.refuse = "bypass_not_allowed";
    const panels = both(s.chat);
    const { card, done } = await askBypass(s);
    await panels.settle();
    fireEvent.click(panels.q.getByRole("button", { name: "Switch Bypass on" }));
    expect(await done).toBe(false);
    await panels.same();

    expect(panels.react.container.querySelector(".fdn-bypass .fdn-approval-state")!.textContent).toBe(englishStrings.bypassNotConfirmed.refused);
    fireEvent.click(panels.q.getByRole("button", { name: "Close" }));
    await panels.same();
    expect(card.isShown).toBe(false);
    expect(panels.react.container.querySelector(".fdn-bypass")).toBeNull();
  });
});

describe("the work card in both skins", () => {
  it("draws the same card, takes the focus, keeps Not now first, and Allow sends what was kept", async () => {
    const s = await grantChat();
    const panels = both(s.chat);
    const session = await conversation(s);
    const offered = session.offerWork([REPORT, BUDGET]);
    await waitFor(() => s.chat.grants.cards[0]);
    await panels.same();

    const dom = panels.react.container;
    expect([...dom.querySelectorAll(".fdn-grant .fdn-grant-buttons button")].map((b) => b.textContent)).toEqual(["Not now", "Allow"]);
    expect([...dom.querySelectorAll(".fdn-grant [role=radio]")].map((b) => b.textContent)).toEqual(["15 min", "30 min", "1 h", "2 h"]);
    expect(dom.querySelector(".fdn-grant")!.getAttribute("aria-label")).toBe("Work alongside you?");

    fireEvent.click(panels.q.getAllByRole("button", { name: /^Remove/ })[1]!); // takes budget.xlsx out
    fireEvent.click(panels.q.getByRole("radio", { name: "2 h" }));
    await panels.same();
    expect(dom.querySelector(".fdn-removed")!.textContent).toContain("budget.xlsx");
    fireEvent.click(panels.q.getByRole("button", { name: "Allow" }));
    await offered;
    await panels.same();

    expect(s.grants.made[0]!.json["targets"]).toEqual([{ type: "document", identifiers: ["C:\\Docs\\report.docx"] }]);
    expect(s.grants.made[0]!.json["minutes"]).toBe(120);
    expect(dom.querySelector(".fdn-grant-marker")!.textContent).toContain("Working alongside you · 2 h left");
    expect(vueText(panels)).toContain("Working alongside you · 2 h left");
  });

  it("moves the focus into a new card (React and Vue)", async () => {
    const s = await grantChat();
    const session = await conversation(s);
    render(createElement(ReactPanel, { chat: s.chat }));
    const offered = session.offerWork([REPORT]);
    await waitFor(() => s.chat.grants.cards[0]);
    await act(async () => {});
    expect(document.activeElement?.textContent).toBe("Not now");
    s.chat.grants.cards[0]!.notNow();
    await offered;
    cleanup();

    const vue = mount(VuePanel, { props: { chat: s.chat }, attachTo: document.body });
    wrappers.push(vue);
    const again = session.offerWork([REPORT]);
    await waitFor(() => s.chat.grants.cards[1]);
    await flushPromises();
    expect(document.activeElement?.textContent).toBe("Not now");
    s.chat.grants.cards[1]!.notNow();
    await again;
  });

  it("offers more time near the end in both, and Stop ends the grant", async () => {
    const s = await grantChat();
    const panels = both(s.chat);
    const session = await conversation(s);
    const offered = session.offerWork([REPORT]);
    (await waitFor(() => s.chat.grants.cards[0])).allow();
    await offered;
    s.advance(28 * MIN);
    s.chat.grants.tick();
    await panels.same();

    fireEvent.click(panels.q.getByRole("button", { name: "Another 30 min" }));
    await waitFor(() => !s.chat.grants.isEnding);
    await panels.same();
    fireEvent.click(panels.q.getByRole("button", { name: "Stop" }));
    await waitFor(() => !s.chat.grants.hasMarker);
    await panels.same();
    expect(s.agent.grants.live).toEqual([]);
  });
});

describe("Settings -> Approvals, the mode picker and the chat list in both skins", () => {
  it("lists the grants and the always-allowed tools with Revoke, in both", async () => {
    const s = await grantChat();
    const panels = both(s.chat);
    const session = await conversation(s);
    const offered = session.offerWork([REPORT]);
    (await waitFor(() => s.chat.grants.cards[0])).allow();
    await offered;

    s.chat.setSettingsOpen(true);
    await waitFor(() => s.chat.grants.hasStanding);
    await panels.same();
    const section = panels.react.container.querySelector("[role=group][aria-label=Approvals]")!;
    expect(section.textContent).toContain("Working alongside you in report.docx, 30 min left");
    fireEvent.click(panels.q.getByRole("button", { name: /^Revoke/ }));
    await waitFor(() => !s.chat.grants.hasStanding);
    await panels.same();
    expect(panels.react.container.querySelector("[role=group][aria-label=Approvals]")!.textContent).toContain("Nothing is allowed for longer than one call.");
  });

  it("lists Bypass in the mode picker with its description, and shows a chat's Bypass in the history", async () => {
    const s = await grantChat();
    const panels = both(s.chat);
    s.chat.setModeMenuOpen(true);
    await panels.same();
    expect([...panels.react.container.querySelectorAll("[role=menuitemradio]")].at(-1)!.textContent)
      .toBe(`Bypass${englishStrings.modes.bypass.description}`);
    s.chat.setModeMenuOpen(false);

    const { card, done } = await askBypass(s);
    await panels.settle();
    card.allow();
    await done;
    await s.chat.send("Hi.");
    await s.chat.toggleHistory();
    await panels.same();
    expect(panels.react.container.querySelector(".fdn-history-bypass")!.textContent).toBe("Bypass · 30 min left");
  });
});

describe("the device-wide marker in both skins", () => {
  it("draws the same marker, Stop and summary in both", async () => {
    const s = await grantChat();
    const life = new GrantLifecycle(s.agent.grants, { tickEvery: 0 });
    const marker = new GrantMarkerViewModel(life, () => englishStrings, {});
    disposables.push(life, marker);
    const react = render(createElement(ReactMarker, { marker }));
    const vue = mount(VueMarker, { props: { marker }, attachTo: document.body });
    wrappers.push(vue);
    const q = within(react.container);
    expect(react.container.textContent).toBe("");

    await s.agent.grants.grantWork([REPORT], 30 * MIN, "c-1");
    await act(async () => {});
    await flushPromises();
    expect(react.container.textContent).toContain("Working alongside you · 30 min left");
    expect(normalize(vue.element)).toBe(normalize(react.container.firstElementChild!));

    fireEvent.click(q.getByRole("button", { name: "Stop" }));
    await waitFor(() => marker.summaries.length === 1);
    await act(async () => {});
    await flushPromises();
    expect(react.container.textContent).toContain("Worked alongside you for 0 min");
    expect(react.container.textContent).toContain("You stopped it.");
    expect(normalize(vue.element)).toBe(normalize(react.container.firstElementChild!));
    fireEvent.click(q.getByRole("button", { name: "Close" }));
    expect(marker.summaries).toEqual([]);
  });
});

function vueText(panels: ReturnType<typeof both>): string {
  return panels.vue.text();
}
