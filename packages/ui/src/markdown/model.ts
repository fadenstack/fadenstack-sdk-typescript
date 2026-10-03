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
  /** `complete` is false while the closing fence has not arrived. */
  | { kind: "code"; key: string; language: string | null; code: string; complete: boolean }
  | { kind: "list"; key: string; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; key: string; blocks: MarkdownBlock[] }
  | { kind: "table"; key: string; header: Inline[][]; rows: Inline[][][]; align: ("left" | "center" | "right" | null)[] }
  | { kind: "rule"; key: string };

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
