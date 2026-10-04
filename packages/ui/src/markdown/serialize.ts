import type { Inline, ListItem, MarkdownBlock } from "./model.js";
import { inlineText } from "./model.js";
import { parseMarkdown } from "./parse.js";

/**
 * Markdown blocks as HTML for another program -- the clipboard, a page's rich-text editor, a document -- never for
 * this UI, which renders the blocks itself. Built from the parsed blocks, so it holds only what they hold: text is
 * escaped, links are http(s) or mailto, images are their alt text (never loaded), and there are no attributes but
 * `href` and a cell's alignment.
 */
export function toHtml(blocks: readonly MarkdownBlock[]): string {
  return blocks.map(block).join("");
}

/** Markdown as HTML (see `toHtml`). */
export function markdownToHtml(source: string): string {
  return toHtml(parseMarkdown(source));
}

/** Markdown blocks as the text a reader sees, for programs that take no formatting: no marks, lists with "- ". */
export function toPlainText(blocks: readonly MarkdownBlock[]): string {
  return blocks.map(plainBlock).filter((t) => t !== "").join("\n\n");
}

/** Markdown as plain text (see `toPlainText`). */
export function markdownToPlainText(source: string): string {
  return toPlainText(parseMarkdown(source));
}

function plainBlock(b: MarkdownBlock): string {
  switch (b.kind) {
    case "paragraph":
    case "heading":
      return inlineText(b.inlines);
    case "code":
      return b.code;
    case "list":
      return b.items.map((item, i) => {
        const box = item.checked === undefined ? "" : item.checked ? "☑ " : "☐ ";
        return `${b.ordered ? `${b.start + i}.` : "-"} ${box}${toPlainText(item.blocks).replace(/\n/g, "\n  ")}`;
      }).join("\n");
    case "quote":
      return toPlainText(b.blocks);
    case "table":
      return tableToTsv(b);
    case "rule":
      return "";
  }
}

/**
 * A table as tab-separated values, the header first: pasted into a spreadsheet, each cell lands in its own cell.
 * Tabs and line breaks inside a cell become spaces.
 */
export function tableToTsv(table: Extract<MarkdownBlock, { kind: "table" }>): string {
  const cell = (inlines: Inline[]) => inlineText(inlines).replace(/[\t\r\n]+/g, " ").trim();
  return [table.header, ...table.rows].map((row) => row.map(cell).join("\t")).join("\n");
}

/** The tables of Markdown, in order. */
export function tablesOf(source: string): Extract<MarkdownBlock, { kind: "table" }>[] {
  const found: Extract<MarkdownBlock, { kind: "table" }>[] = [];
  const visit = (blocks: readonly MarkdownBlock[]) => {
    for (const b of blocks) {
      if (b.kind === "table") found.push(b);
      else if (b.kind === "quote") visit(b.blocks);
      else if (b.kind === "list") b.items.forEach((item) => visit(item.blocks));
    }
  };
  visit(parseMarkdown(source));
  return found;
}

function block(b: MarkdownBlock): string {
  switch (b.kind) {
    case "paragraph":
      return `<p>${inlines(b.inlines)}</p>`;
    case "heading":
      return `<h${b.level}>${inlines(b.inlines)}</h${b.level}>`;
    case "code":
      return `<pre><code>${escape(b.code)}</code></pre>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
      return `<${tag}${start}>${b.items.map(item).join("")}</${tag}>`;
    }
    case "quote":
      return `<blockquote>${toHtml(b.blocks)}</blockquote>`;
    case "table": {
      const align = (i: number) => (b.align[i] ? ` style="text-align:${b.align[i]}"` : "");
      const head = b.header.map((c, i) => `<th${align(i)}>${inlines(c)}</th>`).join("");
      const rows = b.rows.map((row) => `<tr>${row.map((c, i) => `<td${align(i)}>${inlines(c)}</td>`).join("")}</tr>`).join("");
      return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    case "rule":
      return "<hr>";
  }
}

function item(i: ListItem): string {
  const box = i.checked === undefined ? "" : i.checked ? "☑ " : "☐ ";
  // A paragraph alone in an item is its text (as editors write a tight list).
  const body = i.blocks.length === 1 && i.blocks[0]!.kind === "paragraph" ? inlines(i.blocks[0]!.inlines) : toHtml(i.blocks);
  return `<li>${box}${body}</li>`;
}

function inlines(list: readonly Inline[]): string {
  return list.map((inline) => {
    switch (inline.kind) {
      case "text":
        return escape(inline.text);
      case "strong":
        return `<strong>${inlines(inline.children)}</strong>`;
      case "em":
        return `<em>${inlines(inline.children)}</em>`;
      case "del":
        return `<del>${inlines(inline.children)}</del>`;
      case "code":
        return `<code>${escape(inline.text)}</code>`;
      case "link":
        return `<a href="${escape(inline.href)}">${inlines(inline.children)}</a>`;
      case "image":
        return escape(inline.alt ? `[${inline.alt}]` : "");
      case "break":
        return "<br>";
    }
  }).join("");
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
