// @vitest-environment jsdom
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { StopEverythingViewModel, builtInStrings } from "@fadenstack/ui";
import { StopEverythingButton } from "@fadenstack/ui-vue";

import { computedRules } from "../../ui-web/test/panelLayout.js";

// Parity with @fadenstack/ui-react's stopEverythingLayout.test.tsx: "Stop everything" in a host's narrow header. jsdom has no layout, so
// the rules of styles.css are cascaded onto the real elements (ui-web/test/panelLayout.ts).

let wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

describe("Stop everything in a narrow host header", () => {
  it("is a row with no height or background of its own, and its line breaks only between words", () => {
    const model = new StopEverythingViewModel({ agents: () => [], strings: () => builtInStrings.en! });
    const host = document.createElement("div");
    host.style.width = "160px";
    document.body.appendChild(host);
    const wrapper = mount(StopEverythingButton, { props: { stop: model }, attachTo: host });
    wrappers.push(wrapper);
    const root = wrapper.element as HTMLElement;
    const rules = computedRules(root);
    expect(rules.get("flex-direction")).toBe("row");
    expect(rules.get("height")).toBe("auto");
    expect(rules.get("min-height")).toBe("0");
    expect(rules.get("background")).toBe("transparent");
    expect(rules.get("display")).toBe("inline-flex");
    const line = computedRules(wrapper.get(".fdn-stop-everything-result").element as HTMLElement);
    expect(line.get("overflow-wrap")).toBe("normal");
    expect(line.get("word-break")).toBe("normal");
    expect(line.get("min-width")).toBe("0");
    expect(computedRules(wrapper.get(".fdn-stop-everything-button").element as HTMLElement).get("flex")).toBe("none");
  });

  it("still lays out as a row where the host sets the same rules itself", () => {
    const model = new StopEverythingViewModel({ agents: () => [], strings: () => builtInStrings.en! });
    const wrapper = mount(StopEverythingButton, { props: { stop: model }, attachTo: document.body });
    wrappers.push(wrapper);
    const root = wrapper.element as HTMLElement;
    root.style.flexDirection = "row"; // a host's rule (Nextcloud's own CSS) says what ours says
    root.style.height = "auto";
    expect(computedRules(root).get("flex-direction")).toBe("row");
    expect(computedRules(root).get("height")).toBe("auto");
  });
});

