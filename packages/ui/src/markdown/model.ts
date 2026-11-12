/**
 * An answer's Markdown as plain data a skin renders itself -- never as HTML. Blocks are immutable: while an
 * answer streams only its last block is replaced, so a skin re-renders one block per update however long the
 * answer is.
 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "code"; text: string }
  /** Only `http:`, `https:` and `mailto:` links; others are kept as their text. */
  | { kind: "link"; href: string; children: Inline[] }
  /** An image is never loaded (a remote image can carry data out): it is its alt text, and its address. */
  | { kind: "image"; alt: string; href: string }
  | { kind: "break" };

export type MarkdownBlock =
  | { kind: "paragraph"; key: string; inlines: Inline[] }
  | { kind: "heading"; key: string; level: number; inlines: Inline[] }
  /**
   * `complete` is false while the closing fence has not arrived. `diagram` marks a diagram in text form (a `mermaid` fence):
   * a skin labels it as one ("Diagram - Mermaid"); drawing it is up to the host. .NET: `CodeBlock.IsDiagram`.
   */
  | { kind: "code"; key: string; language: string | null; code: string; complete: boolean; diagram: boolean }
  /**
   * A `markdown` (or `md`) fence: its content is Markdown to show rendered (`blocks`), with the fence itself (`source`, a
   * code block) one switch away. It counts as one level of nesting. .NET: `PreviewBlock`.
   */
  | { kind: "preview"; key: string; source: CodeBlock; blocks: MarkdownBlock[] }
  | { kind: "list"; key: string; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; key: string; blocks: MarkdownBlock[] }
  | { kind: "table"; key: string; header: Inline[][]; rows: Inline[][][]; align: ("left" | "center" | "right" | null)[] }
  | { kind: "rule"; key: string };

export type CodeBlock = Extract<MarkdownBlock, { kind: "code" }>;

/**
 * How many containers (a quote, a list item, a Markdown preview) may sit inside each other: quote > list > quote is the
 * deepest that still parses. The content of a container at this depth is one plain-text block, the raw lines, not parsed
 * again. Model output nests a level or two; a hostile or runaway answer (a thousand ">") must not make the parser or a skin
 * pay for it. .NET: `MarkdownParser.MaxNestingDepth`.
 */
export const MAX_NESTING_DEPTH = 3;

export interface ListItem {
  /** For a task list item: whether it is ticked; undefined for a plain item. */
  checked: boolean | undefined;
  blocks: MarkdownBlock[];
}

/** The plain text of inlines (for copying, searching, accessibility). */
export function inlineText(inlines: readonly Inline[]): string {
  let out = "";
  for (const inline of inlines) {
    switch (inline.kind) {
      case "text":
      case "code":
        out += inline.text;
        break;
      case "image":
        out += inline.alt;
        break;
      case "break":
        out += "\n";
        break;
      default:
        out += inlineText(inline.children);
    }
  }
  return out;
}
