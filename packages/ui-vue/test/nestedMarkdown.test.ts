// @vitest-environment jsdom
// Nested Markdown, the preview/source switch and marked diagrams: both skins draw the same, element by element (sdk/45 3.3, G3).
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { germanStrings, type AgentChatViewModel } from "@fadenstack/ui";
import { ChatPanel as ReactPanel } from "@fadenstack/ui-react";
import { ChatPanel as VuePanel } from "@fadenstack/ui-vue";

import { chatWith, normalize } from "./helpers.js";

let wrappers: VueWrapper[] = [];
afterEach(() => {
  cleanup();
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

function both(chat: AgentChatViewModel) {
  const react = render(createElement(ReactPanel, { chat }));
  const vue = mount(VuePanel, { props: { chat }, attachTo: document.body });
  wrappers.push(vue);
  const settle = async () => {
    await act(async () => {});
    await flushPromises();
  };
  return {
    react: react.container,
    vue: vue.element as Element,
    settle,
    async same(): Promise<void> {
      await settle();
      expect(normalize(vue.element)).toBe(normalize(react.container.firstElementChild!));
    },
  };
}

const ANSWER = [
  "> - quote > list > quote:",
  ">   > deep **flat**",
  "",
  "- a",
  "  - b",
  "    - c",
  "      - d **flat**",
  "",
  "```md",
  "# Preview heading",
  "",
  "Some **bold** text.",
  "```",
  "",
  "```mermaid",
  "graph TD; A-->B",
  "```",
  "",
  "```js",
  "let x = 1;",
  "```",
].join("\n");

async function answered(options: Parameters<typeof chatWith>[1] = {}) {
  const { chat } = await chatWith(() => ({ text: ANSWER }), options);
  await chat.send("Show me");
  return chat;
}

describe("nested Markdown in both skins", () => {
  it("draws the same elements for quotes, lists, previews and diagrams", async () => {
    const panels = both(await answered());
    await panels.same();
    for (const root of [panels.react, panels.vue]) {
      const md = root.querySelector(".fdn-md")!;
      // the cap: no more than three containers inside each other, and the deepest content is text
      expect(md.querySelectorAll("blockquote blockquote blockquote").length).toBe(0);
      expect(md.querySelector("blockquote ul blockquote")?.textContent).toContain("deep **flat**");
      expect(md.querySelector("blockquote ul blockquote strong")).toBeNull();
      expect(md.querySelector("ul ul ul ul")).toBeNull();
      expect(md.querySelector("ul ul ul")?.textContent).toContain("d **flat**");
      expect(md.querySelector("ul ul ul strong")).toBeNull();
      // the label of a diagram, and the language of any other code
      const bars = [...md.querySelectorAll(".fdn-md-code-bar span")].map((s) => s.textContent);
      expect(bars).toEqual(["Diagram · Mermaid", "js"]);
    }
  });

  it("switches a preview to its source and back, the same in both skins", async () => {
    const panels = both(await answered());
    await panels.settle();
    for (const root of [panels.react, panels.vue]) {
      const preview = root.querySelector(".fdn-md-preview")!;
      expect(preview.querySelector("h1, h2, h3, h4, h5, h6, .fdn-md-h1")?.textContent).toBe("Preview heading");
      expect(preview.querySelector(".fdn-md-code")).toBeNull();
      const [previewButton, sourceButton] = [...preview.querySelectorAll<HTMLButtonElement>(".fdn-md-switch")];
      expect([previewButton!.textContent, sourceButton!.textContent]).toEqual(["Preview", "Source"]);
      expect(previewButton!.getAttribute("aria-pressed")).toBe("true");
      expect(sourceButton!.getAttribute("aria-pressed")).toBe("false");
    }
    // one click in each skin
    await act(async () => {
      fireEvent.click(panels.react.querySelectorAll<HTMLButtonElement>(".fdn-md-switch")[1]!);
    });
    panels.vue.querySelectorAll<HTMLButtonElement>(".fdn-md-switch")[1]!.click();
    await panels.same();
    for (const root of [panels.react, panels.vue]) {
      const preview = root.querySelector(".fdn-md-preview")!;
      expect(preview.querySelector(".fdn-md-code code")?.textContent).toBe("# Preview heading\n\nSome **bold** text.");
      expect(preview.querySelector(".fdn-md-preview-body")).toBeNull();
      expect(preview.querySelectorAll(".fdn-md-switch")[1]!.getAttribute("aria-pressed")).toBe("true");
    }
    await act(async () => {
      fireEvent.click(panels.react.querySelectorAll<HTMLButtonElement>(".fdn-md-switch")[0]!);
    });
    panels.vue.querySelectorAll<HTMLButtonElement>(".fdn-md-switch")[0]!.click();
    await panels.same();
    expect(panels.vue.querySelector(".fdn-md-preview-body strong")?.textContent).toBe("bold");
  });

  it("labels the switch and the diagram in the language of the panel", async () => {
    const panels = both(await answered({ strings: germanStrings }));
    await panels.same();
    for (const root of [panels.react, panels.vue]) {
      expect([...root.querySelectorAll(".fdn-md-switch")].map((b) => b.textContent)).toEqual(["Vorschau", "Quelltext"]);
      expect(root.textContent).toContain("Diagramm · Mermaid");
    }
  });
});
