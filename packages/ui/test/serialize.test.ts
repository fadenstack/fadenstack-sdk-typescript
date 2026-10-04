import { describe, expect, it } from "vitest";

import { MemoryClipboard, markdownToHtml, tableToTsv, tablesOf, writeClipboard } from "@fadenstack/ui";

describe("markdownToHtml", () => {
  it("writes the blocks a mail or document keeps", () => {
    const html = markdownToHtml([
      "## Seal check",
      "",
      "Hello **Jane**, see *the manual* and `ISO VG 68`.",
      "",
      "1. Lock out",
      "2. Open the casing",
      "",
      "- [x] done",
      "",
      "> Install by a qualified electrician.",
      "",
      "```",
      "a < b",
      "```",
      "",
      "---",
    ].join("\n"));
    expect(html).toBe(
      "<h2>Seal check</h2>" +
      "<p>Hello <strong>Jane</strong>, see <em>the manual</em> and <code>ISO VG 68</code>.</p>" +
      "<ol><li>Lock out</li><li>Open the casing</li></ol>" +
      "<ul><li>☑ done</li></ul>" +
      "<blockquote><p>Install by a qualified electrician.</p></blockquote>" +
      "<pre><code>a &lt; b</code></pre>" +
      "<hr>",
    );
  });

  it("escapes text and keeps only safe links; never loads an image", () => {
    const html = markdownToHtml("<script>alert(1)</script>\n\nSee [ok](https://example.com/?q=a&b=c) [bad](javascript:alert(1)) ![cat](https://x/cat.png) <b onclick=x>b</b>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b ");
    expect(html).toContain('<a href="https://example.com/?q=a&amp;b=c">ok</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("[cat]");
  });

  it("writes tables with their alignment", () => {
    expect(markdownToHtml("| Task | h |\n|:--|--:|\n| Seal | 2 000 |")).toBe(
      '<table><thead><tr><th style="text-align:left">Task</th><th style="text-align:right">h</th></tr></thead>' +
      '<tbody><tr><td style="text-align:left">Seal</td><td style="text-align:right">2 000</td></tr></tbody></table>',
    );
  });
});

describe("tables", () => {
  it("finds tables, also in lists and quotes, and writes them tab-separated", () => {
    const tables = tablesOf("Intro\n\n| A | B |\n|---|---|\n| 1 | **2** |\n\n> | C |\n> |---|\n> | 3 |\n");
    expect(tables).toHaveLength(2);
    expect(tableToTsv(tables[0]!)).toBe("A\tB\n1\t2");
    expect(tableToTsv(tables[1]!)).toBe("C\n3");
  });

  it("keeps a cell in its cell", () => {
    const [table] = tablesOf("| A | B |\n|---|---|\n| x \\| y | z |");
    expect(tableToTsv(table!)).toBe("A\tB\nx | y\tz");
  });
});

describe("writeClipboard", () => {
  it("writes HTML where the clipboard takes it, else the text", async () => {
    const rich = new MemoryClipboard();
    await writeClipboard(rich, { text: "a", html: "<p>a</p>" });
    expect([rich.lastText, rich.lastHtml]).toEqual(["a", "<p>a</p>"]);
    const plain = { text: "", setText(t: string) { this.text = t; } };
    await writeClipboard(plain, { text: "b", html: "<p>b</p>" });
    expect(plain.text).toBe("b");
  });
});
