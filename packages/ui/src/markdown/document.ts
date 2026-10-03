import type { MarkdownBlock } from "./model.js";
import { parseBlocks } from "./parse.js";

/**
 * A streamed answer as blocks. `append` re-parses only the last block -- the one still growing -- and replaces
 * it; every block before it is final and keeps its identity. So an update costs the size of the last block,
 * not of the answer, and a skin re-renders one block. Keys are the blocks' offsets in the text: stable while
 * a block grows.
 */
export class MarkdownDocument {
  #text = "";
  /** Where the live block starts in the text. */
  #liveStart = 0;
  #final: MarkdownBlock[] = [];
  #live: MarkdownBlock | undefined;
  #blocks: readonly MarkdownBlock[] = [];

  constructor(text?: string) {
    if (text) this.append(text);
  }

  /** The Markdown source so far. */
  get text(): string {
    return this.#text;
  }

  get blocks(): readonly MarkdownBlock[] {
    return this.#blocks;
  }

  /** Adds text; returns whether the blocks changed. */
  append(text: string): boolean {
    if (!text) return false;
    this.#text += text;
    const parsed = parseBlocks(this.#text.slice(this.#liveStart));
    if (parsed.length === 0) return false; // only blank lines so far
    let changed = false;
    // Every block but the last is done: a later block began after it.
    for (const { block, offset } of parsed.slice(0, -1)) {
      this.#final.push({ ...block, key: `b${this.#liveStart + offset}` });
      changed = true;
    }
    const last = parsed[parsed.length - 1]!;
    this.#liveStart += last.offset;
    const live = { ...last.block, key: `b${this.#liveStart}` } as MarkdownBlock;
    if (changed || !same(live, this.#live)) {
      this.#live = live;
      this.#blocks = [...this.#final, live];
      return true;
    }
    return false;
  }
}

function same(a: MarkdownBlock, b: MarkdownBlock | undefined): boolean {
  return b !== undefined && a.key === b.key && JSON.stringify(a) === JSON.stringify(b);
}
