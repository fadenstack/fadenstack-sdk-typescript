import { normalizeText } from "@fadenstack/client";

import type { EditClassifier } from "./types.js";

export interface EditSimilarityOptions {
  /** Similarity from which an edit counts as small (default 0.85: about one word in seven changed). */
  minSimilarity?: number;
  /** Longer texts are not compared, and count as rewritten (default 2000 words). */
  maxWords?: number;
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const SENTENCE_END = /[.!?。！？]+(?=\s|$)/g;

function words(text: string): string[] {
  return normalizeText(text).toLowerCase().match(WORD) ?? [];
}

function sentences(text: string): number {
  const normal = normalizeText(text);
  if (!normal) return 0;
  const ends = normal.match(SENTENCE_END)?.length ?? 0;
  return /[.!?。！？]$/.test(normal) ? ends : ends + 1;
}

/** Edit distance between two sequences; `cost` prices a substitution (0 to 1). */
function distance<T>(a: readonly T[], b: readonly T[], cost: (x: T, y: T) => number): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost(a[i - 1]!, b[j - 1]!));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** What replacing one word by another costs: how far apart they are in characters, so a typo fix costs a fraction. */
function wordCost(x: string, y: string): number {
  if (x === y) return 0;
  if (Math.abs(x.length - y.length) > 3) return 1;
  return Math.min(1, distance([...x], [...y], (p, q) => (p === q ? 0 : 1)) / Math.max(x.length, y.length));
}

/**
 * How alike two texts are, from 0 to 1: one less the word-level edit distance over the longer text's word count,
 * after the same normalisation as hashing, ignoring case and punctuation. A substituted word costs its character
 * distance (a typo fixed costs less than a word changed). 1 for the same words.
 */
export function editSimilarity(original: string, revised: string, maxWords = 2000): number {
  const a = words(original);
  const b = words(revised);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length > maxWords || b.length > maxWords) return 0;
  return 1 - distance(a, b, wordCost) / Math.max(a.length, b.length);
}

/**
 * The edit kind for a revision of `original`: `corrected` (exempt: spelling, grammar, a light polish) only for a
 * small change -- word similarity at least `minSimilarity`, the same number of sentences, and a length within a
 * quarter -- and `rewritten` (marked) otherwise. When in doubt, it marks.
 */
export function suggestEditKind(original: string, revised: string, options: EditSimilarityOptions = {}): "corrected" | "rewritten" {
  const min = options.minSimilarity ?? 0.85;
  const a = words(original).length;
  const b = words(revised).length;
  if (a === 0 || b === 0 || b / a < 0.8 || b / a > 1.25) return "rewritten";
  if (sentences(original) !== sentences(revised)) return "rewritten";
  return editSimilarity(original, revised, options.maxWords) >= min ? "corrected" : "rewritten";
}

/**
 * An edit classifier from `suggestEditKind`: for a placement that names the text it replaces (`PlaceRequest.original`)
 * and is declared `rewritten`, it lowers the kind to `corrected` when the change is small, with the similarity as the
 * recorded reason. Anything else keeps its kind.
 */
export function similarityClassifier(options: EditSimilarityOptions = {}): EditClassifier {
  return {
    classify(input) {
      if (input.declared !== "rewritten" || input.original === undefined || typeof input.content !== "string") return undefined;
      if (suggestEditKind(input.original, input.content, options) !== "corrected") return undefined;
      const similarity = editSimilarity(input.original, input.content, options.maxWords);
      return { kind: "corrected", reason: `a small change: word similarity ${similarity.toFixed(2)}` };
    },
  };
}
