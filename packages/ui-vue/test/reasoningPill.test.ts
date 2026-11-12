// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import type { TurnLease } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-vue";

import { chatWith, waitUntil } from "./helpers.js";

// The thinking pill and its menu in the Vue skin (the React skin's test is the same list).

let wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

async function panel(ui: Record<string, unknown> = {}, options: Parameters<typeof chatWith>[1] = {}) {
  const setup = await chatWith(() => ({ text: "ok" }), options, "write", true, { ui: { greeting: "Hi.", ...ui } });
  const wrapper = mount(ChatPanel, { props: { chat: setup.chat }, attachTo: document.body });
  wrappers.push(wrapper);
  return { ...setup, wrapper };
}

const pill = (w: VueWrapper, name = /^Thinking: /) => {
  const found = w.findAll("button").find((b) => name.test(b.attributes("aria-label") ?? ""));
  if (!found) throw new Error(`No pill ${String(name)}`);
  return found;
};
const items = (w: VueWrapper, menu = "How long it thinks") =>
  w.find(`[role="menu"][aria-label="${menu}"]`).findAll('[role="menuitemradio"]');
const labels = (w: VueWrapper, menu?: string) => items(w, menu).map((i) => i.find(".fdn-menu-label").text());
const menuExists = (w: VueWrapper) => w.find('[role="menu"][aria-label="How long it thinks"]').exists();
const key = async (w: { trigger(e: string, o: object): Promise<void> }, name: string) => {
  await w.trigger("keydown", { key: name });
  await flushPromises();
};

describe("the thinking pill (Vue)", () => {
  it("shows the level beside the tool mode, in full to screen readers and in the tooltip", async () => {
    const { wrapper } = await panel();
    const button = pill(wrapper);
    expect(button.text()).toBe("Auto");
    expect(button.attributes("aria-label")).toBe("Thinking: Auto");
    expect(button.attributes("aria-haspopup")).toBe("menu");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(button.attributes("title")).toBe("How long it thinks\nThinking: Auto. The agent's own setting.");
    expect(button.element.parentElement!.previousElementSibling!.querySelector(".fdn-mode-button")!.getAttribute("aria-label")).toMatch(/^Tool mode: /);
    expect(menuExists(wrapper)).toBe(false);
  });

  it("opens a menu of radios, marks the current level, and puts the focus on it", async () => {
    const { wrapper } = await panel();
    await pill(wrapper).trigger("click");
    await flushPromises();
    expect(pill(wrapper).attributes("aria-expanded")).toBe("true");
    expect(items(wrapper).map((i) => [i.find(".fdn-menu-label").text(), i.attributes("aria-checked")])).toEqual([
      ["Auto", "true"], ["Off", "false"], ["Low", "false"], ["Medium", "false"], ["High", "false"],
    ]);
    expect(items(wrapper)[0]!.find(".fdn-menu-description").text()).toBe("The agent's own setting.");
    expect(items(wrapper)[0]!.find("svg").exists()).toBe(true);
    expect(document.activeElement).toBe(items(wrapper)[0]!.element);
  });

  it("offers only the levels up to the server's maximum", async () => {
    const { wrapper } = await panel({ reasoning: { max: "low" } });
    await pill(wrapper).trigger("click");
    expect(labels(wrapper)).toEqual(["Auto", "Off", "Low"]);
  });

  it("moves with the arrows, wrapping, and with Home and End", async () => {
    const { wrapper } = await panel();
    await pill(wrapper).trigger("click");
    await flushPromises();
    const [auto, off, , , high] = items(wrapper);
    await key(auto!, "ArrowDown");
    expect(document.activeElement).toBe(off!.element);
    await key(off!, "ArrowUp");
    await key(auto!, "ArrowUp");
    expect(document.activeElement).toBe(high!.element);
    await key(high!, "ArrowDown");
    expect(document.activeElement).toBe(auto!.element);
    await key(auto!, "End");
    expect(document.activeElement).toBe(high!.element);
    await key(high!, "Home");
    expect(document.activeElement).toBe(auto!.element);
  });

  it("closes on Escape and gives the focus back to the pill", async () => {
    const { wrapper } = await panel();
    await pill(wrapper).trigger("click");
    await flushPromises();
    await key(items(wrapper)[2]!, "Escape");
    await nextTick();
    expect(menuExists(wrapper)).toBe(false);
    expect(pill(wrapper).attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(pill(wrapper).element);
  });

  it("closes on Escape pressed with the focus still on the pill", async () => {
    const { wrapper } = await panel();
    await pill(wrapper).trigger("click");
    await flushPromises();
    (pill(wrapper).element as HTMLElement).focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(menuExists(wrapper)).toBe(false);
  });

  it("closes on a press outside", async () => {
    const { wrapper } = await panel();
    await pill(wrapper).trigger("click");
    await flushPromises();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(menuExists(wrapper)).toBe(false);
  });

  it("a pick closes the menu, shows in the pill, is kept for the agent, is marked on reopening, and the focus returns to the pill", async () => {
    const { wrapper, chat } = await panel();
    await pill(wrapper).trigger("click");
    await flushPromises();
    await items(wrapper)[2]!.trigger("click");
    await flushPromises();
    expect(menuExists(wrapper)).toBe(false);
    expect(pill(wrapper).text()).toBe("Low");
    expect(pill(wrapper).attributes("aria-label")).toBe("Thinking: Low");
    expect(document.activeElement).toBe(pill(wrapper).element);
    await waitUntil(() => chat.agent.reasoningChoice === "low");
    await pill(wrapper).trigger("click");
    await flushPromises();
    expect(items(wrapper).map((i) => i.attributes("aria-checked"))).toEqual(["false", "false", "true", "false", "false"]);
    expect(document.activeElement).toBe(items(wrapper)[2]!.element);
  });

  it("is in the panel's language", async () => {
    const { wrapper } = await panel({}, { automaticLanguage: "de" });
    expect(pill(wrapper, /^Nachdenken: /).text()).toBe("Auto");
    await pill(wrapper, /^Nachdenken: /).trigger("click");
    expect(labels(wrapper, "Wie lange nachgedacht wird")).toEqual(["Auto", "Aus", "Niedrig", "Mittel", "Hoch"]);
  });
});

describe("waiting for a free slot (Vue)", () => {
  it("the turn says so while the gate holds it, and the line goes when the turn runs", async () => {
    let release!: (lease: TurnLease) => void;
    let entered = false;
    const { chat, wrapper } = await panel({}, { turnGate: () => { entered = true; return new Promise<TurnLease>((r) => { release = r; }); } });
    const sending = chat.send("Go.");
    await waitUntil(() => entered);
    await flushPromises();
    expect(wrapper.find(".fdn-status").text()).toContain("Waiting for a free slot");
    release(() => undefined);
    await sending;
    await flushPromises();
    expect(wrapper.text()).not.toContain("Waiting for a free slot");
  });

  it("is said in German", async () => {
    let entered = false;
    const { chat, wrapper } = await panel({}, {
      automaticLanguage: "de",
      turnGate: (signal) => { entered = true; return new Promise<TurnLease>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); },
    });
    const sending = chat.send("Los.");
    await waitUntil(() => entered);
    await flushPromises();
    expect(wrapper.find(".fdn-status").text()).toContain("Wartet auf einen freien Platz");
    chat.stop();
    await sending;
  });
});
