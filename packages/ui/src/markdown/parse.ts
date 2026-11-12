import { Lexer, type Token, type Tokens, type TokensList } from "marked";

import { MAX_NESTING_DEPTH, type CodeBlock, type Inline, type ListItem, type MarkdownBlock } from "./model.js";

/** A parsed block and where it starts in the source. */
export interface PlacedBlock {
  block: MarkdownBlock;
  offset: number;
}

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Markdown (GitHub's flavour) as blocks, with each block's offset in `source`. */
export function parseBlocks(source: string, keyPrefix = "b"): PlacedBlock[] {
  const tokens = new CappedLexer(0).lex(source);
  const placed: PlacedBlock[] = [];
  let offset = 0;
  for (const token of tokens) {
    const block = toBlock(token, `${keyPrefix}${offset}`, 0);
    if (block) placed.push({ block, offset });
    offset += token.raw.length;
  }
  return placed;
}

/** Markdown as blocks. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseBlocks(source).map((p) => p.block);
}

/**
 * marked's lexer, with a cap on how deep containers nest: the content of a container at `MAX_NESTING_DEPTH` is one plain-text
 * block, never lexed. The cap is in the lexer, not in what is done with its tokens, so a thousand ">" costs three levels of
 * lexing, not a thousand. .NET: `MarkdownParser.ParseLines` / `PlainText`.
 */
class CappedLexer extends Lexer {
  #depth: number;

  constructor(depth: number) {
    super({ gfm: true, breaks: false });
    this.#depth = depth;
  }

  override blockTokens(src: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[];
  override blockTokens(src: string, tokens?: TokensList, lastParagraphClipped?: boolean): TokensList;
  override blockTokens(src: string, tokens: Token[] | TokensList = [], lastParagraphClipped = false): Token[] | TokensList {
    if (this.#depth >= MAX_NESTING_DEPTH) {
      const text = src.split("\n").map((line) => line.trimEnd()).join("\n").replace(/^\n+|\n+$/g, "");
      if (text) tokens.push({ type: "paragraph", raw: src, text, tokens: [{ type: "text", raw: text, text }] } as Tokens.Paragraph);
      this.state.top = true;
      return tokens;
    }
    this.#depth++;
    try {
      return super.blockTokens(src, tokens as Token[], lastParagraphClipped);
    } finally {
      this.#depth--;
    }
  }
}

function isMarkdown(language: string | null): boolean {
  return language !== null && /^(markdown|md)$/i.test(language);
}

function toBlock(token: Token, key: string, depth: number): MarkdownBlock | undefined {
  switch (token.type) {
    case "paragraph":
      return { kind: "paragraph", key, inlines: inlines((token as Tokens.Paragraph).tokens) };
    case "text": {
      const t = token as Tokens.Text;
      return { kind: "paragraph", key, inlines: t.tokens ? inlines(t.tokens) : [{ kind: "text", text: t.text }] };
    }
    case "heading": {
      const h = token as Tokens.Heading;
      return { kind: "heading", key, level: Math.min(6, Math.max(1, h.depth)), inlines: inlines(h.tokens) };
    }
    case "code": {
      const c = token as Tokens.Code;
      const indented = c.codeBlockStyle === "indented";
      const complete = indented || /\n\s{0,3}(`{3,}|~{3,})\s*$/.test(c.raw.trimEnd());
      const language = c.lang?.trim() ? c.lang.trim().split(/\s+/)[0]! : null;
      const code: CodeBlock = { kind: "code", key, language, code: c.text, complete, diagram: language?.toLowerCase() === "mermaid" };
      if (!isMarkdown(language)) return code;
      // The fence's content is Markdown, one level deeper (and plain text when that is the cap).
      const inner = new CappedLexer(depth + 1).lex(c.text);
      return { kind: "preview", key, source: code, blocks: children(inner, key, depth + 1) };
    }
    case "list": {
      const l = token as Tokens.List;
      return {
        kind: "list",
        key,
        ordered: l.ordered,
        start: typeof l.start === "number" ? l.start : 1,
        items: l.items.map((item, i) => listItem(item, `${key}.${i}`, depth + 1)),
      };
    }
    case "blockquote": {
      const q = token as Tokens.Blockquote;
      return { kind: "quote", key, blocks: children(q.tokens, key, depth + 1) };
    }
    case "table": {
      const t = token as Tokens.Table;
      return {
        kind: "table",
        key,
        header: t.header.map((cell) => inlines(cell.tokens)),
        rows: t.rows.map((row) => row.map((cell) => inlines(cell.tokens))),
        align: t.align,
      };
    }
    case "hr":
      return { kind: "rule", key };
    case "html":
      // Never rendered as HTML: shown as the text it is.
      return token.raw.trim() ? { kind: "paragraph", key, inlines: [{ kind: "text", text: token.raw.trimEnd() }] } : undefined;
    default:
      return undefined; // space, def
  }
}

function listItem(item: Tokens.ListItem, key: string, depth: number): ListItem {
  const tokens = item.tokens.filter((t) => t.type !== "checkbox");
  return { checked: item.task ? item.checked === true : undefined, blocks: children(tokens, key, depth) };
}

/** The blocks of a container's tokens; `depth` is how many containers they are inside. */
function children(tokens: Token[], key: string, depth: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  tokens.forEach((token, i) => {
    const block = toBlock(token, `${key}.${i}`, depth);
    if (block) blocks.push(block);
  });
  return blocks;
}

function inlines(tokens: Token[] | undefined): Inline[] {
  const out: Inline[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens?.length) out.push(...inlines(t.tokens));
        else push(out, decode(t.text));
        break;
      }
      case "escape":
        push(out, (token as Tokens.Escape).text);
        break;
      case "strong":
        out.push({ kind: "strong", children: inlines((token as Tokens.Strong).tokens) });
        break;
      case "em":
        out.push({ kind: "em", children: inlines((token as Tokens.Em).tokens) });
        break;
      case "del":
        out.push({ kind: "del", children: inlines((token as Tokens.Del).tokens) });
        break;
      case "codespan":
        out.push({ kind: "code", text: decode((token as Tokens.Codespan).text) });
        break;
      case "br":
        out.push({ kind: "break" });
        break;
      case "link": {
        const l = token as Tokens.Link;
        const children = inlines(l.tokens);
        if (SAFE_LINK.test(l.href.trim())) out.push({ kind: "link", href: l.href.trim(), children });
        else out.push(...children);
        break;
      }
      case "image": {
        const img = token as Tokens.Image;
        out.push({ kind: "image", alt: img.text, href: img.href });
        break;
      }
      case "html":
        push(out, token.raw);
        break;
      default:
        if ("text" in token && typeof token.text === "string") push(out, token.text);
    }
  }
  return out;
}

/** Adds text, joined with the text before it. */
function push(out: Inline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + text };
  else out.push({ kind: "text", text });
}

/** marked escapes `&<>"'` in text tokens; the skin escapes for itself. */
function decode(text: string): string {
  return text.includes("&")
    ? text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? _)
    : text;
}
