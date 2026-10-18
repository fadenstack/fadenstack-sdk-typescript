import { normalizeText } from "@fadenstack/client";

import { isCjk } from "./content.js";
import type { EditClassifier } from "./types.js";

export interface EditSimilarityOptions {
  /** Similarity from which an edit counts as small (default 0.85: about one word in seven changed). */
  minSimilarity?: number;
}

/** Above this many word pairs the texts are not compared: `rewritten`. */
const MAX_CELLS = 4_000_000;
const DEFAULT_MIN = 0.85;
const LETTER = /[\p{L}\p{N}]/u;
const JOINER = /['’-]/;
const SENTENCE_MARK = /[.!?。！？]/;

/**
 * The words of a text, as both SDKs split them: after the normalisation of hashing and in lower case, runs of letters
 * and digits (an apostrophe or hyphen between two of them stays in the word), each CJK character a word of its own;
 * punctuation and white space separate.
 */
function words(text: string): string[] {
  const normal = normalizeText(text).toLowerCase();
  const out: string[] = [];
  let word = "";
  const chars = [...normal];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (isCjk(c.codePointAt(0)!)) {
      if (word) out.push(word);
      word = "";
      out.push(c);
    } else if (LETTER.test(c) || (JOINER.test(c) && word && LETTER.test(chars[i + 1] ?? ""))) {
      word += c;
    } else {
      if (word) out.push(word);
      word = "";
    }
  }
  if (word) out.push(word);
  return out;
}

/**
 * How many sentences: runs of sentence marks (`. ! ? 。 ！ ？`) followed by white space, the end or a CJK character,
 * and one more when the text does not end with a mark; none for empty text.
 */
function sentences(text: string): number {
  const normal = normalizeText(text);
  if (!normal) return 0;
  let count = 0;
  for (let i = 0; i < normal.length; i++) {
    if (!SENTENCE_MARK.test(normal[i]!)) continue;
    const next = normal[i + 1];
    if (next !== undefined && SENTENCE_MARK.test(next)) continue; // the run ends later
    if (next === undefined || next === " " || isCjk(next.charCodeAt(0))) count++;
  }
  return SENTENCE_MARK.test(normal[normal.length - 1]!) ? count : count + 1;
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

/** What replacing one word by another costs: how far apart they are in characters, so a typo fixed costs a fraction. */
function wordCost(x: string, y: string): number {
  if (x === y) return 0;
  if (Math.abs(x.length - y.length) > 3) return 1;
  return Math.min(1, distance([...x], [...y], (p, q) => (p === q ? 0 : 1)) / Math.max(x.length, y.length));
}

function similarity(a: readonly string[], b: readonly string[]): number | undefined {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  if (a.length * b.length > MAX_CELLS) return undefined;
  return 1 - distance(a, b, wordCost) / longest;
}

/**
 * How alike two texts are, from 0 to 1: one less the word-level edit distance over the longer text's word count. A
 * substituted word costs its character distance over its length (a typo fixed costs less than a word changed; words
 * more than three characters apart in length cost 1). 1 for the same words; 0 for texts too long to compare. The
 * .NET SDK's `SimilarityEditClassifier.WordSimilarity` is the same.
 */
export function editSimilarity(original: string, revised: string): number {
  return similarity(words(original), words(revised)) ?? 0;
}

/** The kind and why, as both SDKs judge it and record the reason. */
function judge(before: string, after: string, minimum: number): { kind: "corrected" | "rewritten"; reason: string } {
  const a = words(before);
  const b = words(after);
  const s = similarity(a, b);
  if (s === undefined) return { kind: "rewritten", reason: "too long to compare" };
  const counts = [sentences(before), sentences(after)] as const;
  const ratio = a.length === 0 ? (b.length === 0 ? 1 : Infinity) : b.length / a.length;
  const kept = `${Math.round(s * 100)} %`;
  if (s >= minimum && counts[0] === counts[1] && ratio >= 0.8 && ratio <= 1.25) {
    return { kind: "corrected", reason: `small change: ${kept} of words kept, the same ${counts[0]} sentence(s)` };
  }
  return { kind: "rewritten", reason: `${kept} of words kept, ${counts[0]} to ${counts[1]} sentence(s)` };
}

/**
 * The edit kind for a revision of `original`: `corrected` (exempt: spelling, grammar, a light polish) only for a
 * small change -- word similarity at least `minSimilarity`, the same number of sentences, and a word count within
 * 0.8 to 1.25 times -- and `rewritten` (marked) otherwise. When in doubt, it marks.
 */
export function suggestEditKind(original: string, revised: string, options: EditSimilarityOptions = {}): "corrected" | "rewritten" {
  return judge(original, revised, options.minSimilarity ?? DEFAULT_MIN).kind;
}

/**
 * An edit classifier from `suggestEditKind`: for a placement declared `rewritten` or `corrected` that names the text
 * it replaces (`PlaceRequest.original`), `corrected` for a small change and `rewritten` otherwise, with the reason
 * recorded on the device. Anything else keeps its kind.
 */
export function similarityClassifier(options: EditSimilarityOptions = {}): EditClassifier {
  return {
    classify(input) {
      if ((input.declared !== "rewritten" && input.declared !== "corrected") || input.original === undefined || typeof input.content !== "string") {
        return undefined;
      }
      return judge(input.original, input.content, options.minSimilarity ?? DEFAULT_MIN);
    },
  };
}
