// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { ChatPanel } from "@fadenstack/ui-vue";
import type { AgentChatOptions } from "@fadenstack/ui";
import type { FakeAgent } from "@fadenstack/testing";

import { chatWith, waitUntil } from "./helpers.js";

let wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

const SERVER_TOOLS = [
  { name: "mcp.github.search", server: "github", description: "Searches <b>issues</b> and pull requests", allowed: true, enabled: true },
  { name: "mcp.github.merge", server: "github", description: "Merges", allowed: false, enabled: true },
  { name: "mcp.wiki.read", server: "wiki", description: "Reads a page", allowed: true, enabled: false },
];

async function panel(agent: Partial<FakeAgent> = {}, options: AgentChatOptions = {}) {
  const made = await chatWith(() => ({ text: "ok" }), options, "write", true, agent);
  const wrapper = mount(ChatPanel, { props: { chat: made.chat }, attachTo: document.body });
  wrappers.push(wrapper);
  return { ...made, wrapper };
}

const button = (w: VueWrapper, name: string) => w.findAll("button").find((b) => b.attributes("aria-label") === name || b.text() === name)!;

async function openTools(wrapper: VueWrapper, settings = "Settings") {
  await button(wrapper, settings).trigger("click");
  await wrapper.findAll(".fdn-settings [role=menuitem]").find((b) => b.text() === "Tools")!.trigger("click");
  await flushPromises();
}

describe("the Tools view (Vue)", () => {
  it("opens from the settings like About: a dialog, the focus on Close, the settings closed, the gear still pressed", async () => {
    const { wrapper } = await panel({ serverTools: SERVER_TOOLS });
    await openTools(wrapper);
    const dialog = wrapper.find("[role=dialog]");
    expect(dialog.attributes("aria-label")).toBe("Tools");
    expect(wrapper.find(".fdn-settings").exists()).toBe(false);
    expect(document.activeElement).toBe(button(wrapper, "Close").element);
    expect(button(wrapper, "Settings").classes()).toEqual(["fdn-icon-button", "fdn-open"]);
    expect(dialog.findAll("input")).toHaveLength(0); // read only
  });

  it("shows the app's tools with their class and the server's tools by server with a status", async () => {
    const { wrapper, chat } = await panel({ serverTools: SERVER_TOOLS });
    await openTools(wrapper);
    await waitUntil(() => chat.tools.state === "ready");
    await flushPromises();
    expect(wrapper.findAll(".fdn-tools-section")[0]!.findAll("li").map((li) => [li.find(".fdn-tools-name").text(), li.find(".fdn-badge").text()])).toEqual([["read_page", "Read"], ["fill_field", "Changes data"]]);
    expect(wrapper.findAll(".fdn-tools-group").map((g) => [g.attributes("aria-label"), ...g.findAll("li").map((li) => li.find(".fdn-badge").text())])).toEqual([
      ["github", "Available to this agent", "Not allowed for this agent"],
      ["wiki", "Switched off by your administrator"],
    ]);
  });

  it("draws a server's description as plain text with dir=auto, never as HTML", async () => {
    const { wrapper, chat } = await panel({ serverTools: SERVER_TOOLS });
    await openTools(wrapper);
    await waitUntil(() => chat.tools.state === "ready");
    await flushPromises();
    const description = wrapper.findAll(".fdn-tools-desc").find((d) => d.text().startsWith("Searches"))!;
    expect(description.text()).toBe("Searches <b>issues</b> and pull requests");
    expect(description.attributes("dir")).toBe("auto");
    expect(description.find("b").exists()).toBe(false);
  });

  it("shows the empty state for a server without the list (not an error), and the failure state with Retry", async () => {
    const { wrapper, chat } = await panel({});
    await openTools(wrapper);
    await waitUntil(() => chat.tools.state === "ready");
    await flushPromises();
    expect(wrapper.text()).toContain("No tools from your server");
    expect(wrapper.find("[role=alert]").exists()).toBe(false);
  });

  it("closes with Escape and gives the focus back to the gear; also with Close", async () => {
    const { wrapper, chat } = await panel({ serverTools: SERVER_TOOLS });
    await openTools(wrapper);
    await wrapper.find("[role=dialog]").trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role=dialog]").exists()).toBe(false);
    expect(document.activeElement).toBe(button(wrapper, "Settings").element);
    await openTools(wrapper);
    await button(wrapper, "Close").trigger("click");
    expect(chat.isToolsOpen).toBe(false);
  });

  it("speaks German", async () => {
    const { wrapper, chat } = await panel({ serverTools: SERVER_TOOLS }, { automaticLanguage: "de" });
    await openTools(wrapper, "Einstellungen");
    await waitUntil(() => chat.tools.state === "ready");
    await flushPromises();
    expect(wrapper.text()).toContain("In dieser App");
    expect(wrapper.text()).toContain("Vom Server Ihrer Organisation");
    expect(wrapper.text()).toContain("Für diesen Agenten nicht erlaubt");
    expect(wrapper.text()).toContain("Ändert Daten");
  });
});
