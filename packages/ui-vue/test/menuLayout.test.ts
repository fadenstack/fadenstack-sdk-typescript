// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatPanel } from "@fadenstack/ui-vue";

import { computedRules, fakeLayout, menuBox } from "../../ui-web/test/panelLayout.js";
import { chatWith } from "./helpers.js";

// Parity with @fadenstack/ui-react's menuLayout.test.tsx: the menus inside a 420 px panel. jsdom has no layout, so the rules of
// styles.css are cascaded onto the real elements and the measurements come from a model of the panel (ui-web/test/panelLayout.ts).

let wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

describe("the menus in a 420 px panel", () => {
  let undo: () => void;
  beforeEach(() => {
    undo = fakeLayout(420, (anchor) => {
      if (anchor.querySelector(".fdn-reasoning-button")) return [108, 230];
      if (anchor.querySelector(".fdn-mode-button")) return [12, 100];
      if (anchor.querySelector('[aria-haspopup="menu"][title="Chat history"]')) return [330, 362];
      return [372, 404];
    });
  });
  afterEach(() => { undo(); });

  async function panel() {
    const setup = await chatWith(() => ({ text: "ok" }));
    const host = document.createElement("div");
    host.style.width = "420px";
    document.body.appendChild(host);
    const wrapper = mount(ChatPanel, { props: { chat: setup.chat }, attachTo: host });
    wrappers.push(wrapper);
    return wrapper;
  }
  const insidePanel = (menu: Element) => {
    const box = menuBox(menu as HTMLElement);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(420);
  };
  const button = (w: VueWrapper, label: RegExp) => {
    const found = w.findAll("button").find((b) => label.test(b.attributes("aria-label") ?? ""));
    if (!found) throw new Error(`No button ${String(label)}`);
    return found;
  };
  const open = async (w: VueWrapper, label: RegExp) => { await button(w, label).trigger("click"); await flushPromises(); };

  it("keeps the tool-mode menu inside by opening it towards the end edge, and its entries start at one x", async () => {
    const w = await panel();
    await open(w, /^Tool mode: /);
    const menu = w.get('[role="menu"][aria-label="Tool mode"]').element as HTMLElement;
    expect(menu.style.insetInlineStart).toBe("0");
    insidePanel(menu);
    const checks = [...menu.querySelectorAll<HTMLElement>(".fdn-menu-check")];
    expect(checks.length).toBeGreaterThanOrEqual(4);
    for (const check of checks) {
      const rules = computedRules(check);
      expect(rules.get("flex")).toBe("none");
      expect(rules.get("width")).toBe("16px");
    }
  });

  it("keeps the settings, history and thinking menus inside", async () => {
    const w = await panel();
    await open(w, /^Settings$/);
    insidePanel(w.get('[role="menu"][aria-label="Settings"]').element);
    await open(w, /^Chat history$/);
    insidePanel(w.get('[role="menu"][aria-label="Chat history"]').element);
    await open(w, /^Thinking: /);
    insidePanel(w.get('[role="menu"][aria-label="How long it thinks"]').element);
  });
});
