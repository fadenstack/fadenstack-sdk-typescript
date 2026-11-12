import { describe, expect, it } from "vitest";

import {
  MarkdownDocument,
  markdownToHtml,
  markdownToPlainText,
  parseMarkdown,
  tablesOf,
  type MarkdownBlock,
} from "@fadenstack/ui";

/** Nested Markdown with a depth cap of three, a preview/source switch and marked diagrams. Port of the .NET MarkdownNestingTests (c99117f). */

/** The deepest run of containers (a quote, a list item, a Markdown preview) inside each other. */
function depth(blocks: readonly MarkdownBlock[]): number {
  let deepest = 0;
  for (const b of blocks) {
    if (b.kind === "quote" || b.kind === "preview") deepest = Math.max(deepest, 1 + depth(b.blocks));
    else if (b.kind === "list") for (const item of b.items) deepest = Math.max(deepest, 1 + depth(item.blocks));
  }
  return deepest;
}

function plain(block: MarkdownBlock | undefined): string {
  return block?.kind === "paragraph" ? block.inlines.map((i) => (i.kind === "text" ? i.text : `<${i.kind}>`)).join("") : `<${block?.kind}>`;
}

describe("containers hold blocks", () => {
  it("lets a quote hold a table, a list and a code block", () => {
    const [quote] = parseMarkdown("> text\n>\n> | A | B |\n> |---|---|\n> | 1 | 2 |\n>\n> - x\n> - y\n>\n> ```js\n> let a;\n> ```");
    expect(quote!.kind).toBe("quote");
    expect((quote as Extract<MarkdownBlock, { kind: "quote" }>).blocks.map((b) => b.kind)).toEqual(["paragraph", "table", "list", "code"]);
  });

  it("lets a list item hold a table or a code block under its text", () => {
    const [list] = parseMarkdown("- first\n\n  | A |\n  |---|\n  | 1 |\n\n- second\n\n  ```\n  code\n  ```");
    const items = (list as Extract<MarkdownBlock, { kind: "list" }>).items;
    expect(items[0]!.blocks.map((b) => b.kind)).toEqual(["paragraph", "table"]);
    expect(items[1]!.blocks.map((b) => b.kind)).toEqual(["paragraph", "code"]);
    expect(tablesOf("- first\n\n  | A |\n  |---|\n  | 1 |")).toHaveLength(1);
  });
});

describe("the depth cap of three", () => {
  it("parses quote > list > quote, and the content of the third container is one plain-text block", () => {
    const [quote] = parseMarkdown("> - > deep **not bold**\n> - after **bold**");
    const list = (quote as Extract<MarkdownBlock, { kind: "quote" }>).blocks[0] as Extract<MarkdownBlock, { kind: "list" }>;
    expect(list.kind).toBe("list");
    // the list item (the second container) is still parsed ...
    const inner = list.items[0]!.blocks[0] as Extract<MarkdownBlock, { kind: "quote" }>;
    expect(inner.kind).toBe("quote");
    // ... but the content of the third (the inner quote) is plain: its markup stays as typed
    expect(inner.blocks).toHaveLength(1);
    expect(plain(inner.blocks[0])).toBe("deep **not bold**");
    expect(list.items[1]!.blocks[0]).toMatchObject({ kind: "paragraph", inlines: [{ kind: "text" }, { kind: "strong" }] });
    expect(depth([quote!])).toBe(3);
  });

  it("flattens what is deeper as text and does not drop it", () => {
    const [quote] = parseMarkdown("> > > four **x**\n> > > > five\n> > > - a list\n> > > ```\n> > > code\n> > > ```");
    expect(depth([quote!])).toBe(3);
    const third = ((quote as Extract<MarkdownBlock, { kind: "quote" }>).blocks[0] as Extract<MarkdownBlock, { kind: "quote" }>).blocks[0] as Extract<MarkdownBlock, { kind: "quote" }>;
    expect(third.blocks).toHaveLength(1);
    expect(plain(third.blocks[0])).toBe("four **x**\n> five\n- a list\n```\ncode\n```");
  });

  it("caps nested lists by indentation the same way, keeping the text of the deepest", () => {
    const blocks = parseMarkdown("- a\n  - b\n    - c\n      - d **e**\n        - f");
    expect(depth(blocks)).toBe(3);
    const text = JSON.stringify(blocks);
    for (const word of ["a", "b", "c", "d **e**", "f"]) expect(text).toContain(word);
  });

  it("costs a thousand quote marks no more than three levels", () => {
    const hostile = `${">".repeat(3000)} deep text`;
    const started = Date.now();
    const blocks = parseMarkdown(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(depth(blocks)).toBe(3);
    expect(JSON.stringify(blocks)).toContain("deep text"); // flattened as text, not dropped
    // the same, for a chain of list markers and of fences, and streamed
    expect(depth(parseMarkdown("- ".repeat(3000) + "deep"))).toBeLessThanOrEqual(3);
    expect(depth(new MarkdownDocument(`${">".repeat(3000)} a\n\n${">".repeat(3000)} b`).blocks)).toBe(3);
  });

  it("leaves the shallow cases untouched", () => {
    expect(depth(parseMarkdown("> a\n> > b"))).toBe(2);
    expect(depth(parseMarkdown("- a\n  - b"))).toBe(2);
    const [list] = parseMarkdown("- one **bold**");
    expect((list as Extract<MarkdownBlock, { kind: "list" }>).items[0]!.blocks[0]).toMatchObject({ kind: "paragraph", inlines: [{ kind: "text" }, { kind: "strong" }] });
  });
});

describe("a markdown fence is a preview", () => {
  it("shows the fence's content rendered, with the fence one switch away", () => {
    for (const lang of ["markdown", "md", "MD", "Markdown"]) {
      const [block] = parseMarkdown(`\`\`\`${lang}\n# Title\n\n- item\n\`\`\``);
      expect(block, lang).toMatchObject({ kind: "preview", source: { kind: "code", language: lang, code: "# Title\n\n- item", complete: true } });
      expect((block as Extract<MarkdownBlock, { kind: "preview" }>).blocks.map((b) => b.kind)).toEqual(["heading", "list"]);
    }
  });

  it("is a code block for any other language", () => {
    expect(parseMarkdown("```js\nlet a;\n```")[0]).toMatchObject({ kind: "code", language: "js", diagram: false });
    expect(parseMarkdown("```markdownish\nx\n```")[0]!.kind).toBe("code");
  });

  it("counts as one level of nesting", () => {
    const [outer] = parseMarkdown("`````md\n````md\n```md\n# three **deep**\n```\n````\n`````");
    expect(depth([outer!])).toBe(3);
    const second = (outer as Extract<MarkdownBlock, { kind: "preview" }>).blocks[0] as Extract<MarkdownBlock, { kind: "preview" }>;
    const third = second.blocks[0] as Extract<MarkdownBlock, { kind: "preview" }>;
    expect(third.kind).toBe("preview");
    expect(third.blocks).toHaveLength(1); // the content of the third container: plain text
    expect(plain(third.blocks[0])).toBe("# three **deep**");
    // a preview inside a quote inside a list item: also the third
    const [list] = parseMarkdown("- > ```md\n  > # x\n  > ```");
    const preview = ((list as Extract<MarkdownBlock, { kind: "list" }>).items[0]!.blocks[0] as Extract<MarkdownBlock, { kind: "quote" }>).blocks[0] as Extract<MarkdownBlock, { kind: "preview" }>;
    expect(preview.kind).toBe("preview");
    expect(plain(preview.blocks[0])).toBe("# x");
  });

  it("grows while it streams, with an incomplete source until the closing fence arrives", () => {
    const doc = new MarkdownDocument();
    doc.append("```md\n# Ti");
    expect(doc.blocks[0]).toMatchObject({ kind: "preview", source: { complete: false, code: "# Ti" } });
    doc.append("tle\n```");
    expect(doc.blocks[0]).toMatchObject({ kind: "preview", source: { complete: true, code: "# Title" } });
    expect((doc.blocks[0] as Extract<MarkdownBlock, { kind: "preview" }>).blocks[0]).toMatchObject({ kind: "heading" });
  });

  it("copies as its source in plain text and HTML", () => {
    expect(markdownToPlainText("```md\n# T\n```")).toBe("# T");
    expect(markdownToHtml("```md\n# <T>\n```")).toBe("<pre><code># &lt;T&gt;</code></pre>");
  });
});

describe("a diagram in text form is marked", () => {
  it("marks a mermaid fence, in any case, and no other", () => {
    expect(parseMarkdown("```mermaid\ngraph TD; A-->B\n```")[0]).toMatchObject({ kind: "code", language: "mermaid", diagram: true });
    expect(parseMarkdown("```Mermaid\ngraph TD\n```")[0]).toMatchObject({ diagram: true });
    expect(parseMarkdown("```plantuml\nA -> B\n```")[0]).toMatchObject({ diagram: false });
    expect(parseMarkdown("```\nplain\n```")[0]).toMatchObject({ language: null, diagram: false });
  });
});
