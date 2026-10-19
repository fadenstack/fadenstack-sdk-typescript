import { normalizeText } from "@fadenstack/client";

import { isCjk } from "./content.js";
import { readerText } from "./readerText.js";
import type { EditClassifier } from "./types.js";

export interface EditSimilarityOptions {
  /** Similarity from which an edit counts as small (default 0.85: about one word in seven changed). */
  minSimilarity?: number;
  /**
   * For `suggestEditKind`: the texts' media type. HTML and Markdown are compared by the text a reader sees
   * (`readerText`), so markup an editor adds or drops is no change of words. `text/plain` by default.
   */
  mediaType?: string;
}

/** Above this many word pairs (or sentence pairs) the texts are not compared: `rewritten`. */
const MAX_CELLS = 4_000_000;
const DEFAULT_MIN = 0.85;
const LETTER = /[\p{L}\p{N}]/u;
const JOINER = /['’-]/;
const SENTENCE_MARK = /[.!?。！？]/;

/** A word of a text: in lower case, where it starts in the text, and which of its sentences it is in (from 0). */
interface Word {
  readonly text: string;
  readonly start: number;
  readonly sentence: number;
}

/** A text as the classifier reads it: normalised as it is hashed and in lower case, and its words. */
interface Prose {
  readonly normal: string;
  readonly words: readonly Word[];
}

/**
 * A text's words, as both SDKs split them: after the normalisation of hashing and in lower case, runs of letters and
 * digits (an apostrophe or hyphen between two of them stays in the word), each CJK character a word of its own;
 * punctuation and white space separate. Each word knows its sentence (see `sentenceEnds`).
 */
function prose(text: string): Prose {
  const normal = normalizeText(text).toLowerCase();
  const ends = sentenceEnds(normal);
  const words: Word[] = [];
  const chars = [...normal];
  let word = "";
  let start = 0;
  let sentence = 0;
  const flush = () => {
    if (!word) return;
    while (sentence < ends.length && ends[sentence]! < start) sentence++;
    words.push({ text: word, start, sentence });
    word = "";
  };
  for (let i = 0, at = 0; i < chars.length; at += chars[i]!.length, i++) {
    const c = chars[i]!;
    if (isCjk(c.codePointAt(0)!)) {
      flush();
      word = c;
      start = at;
      flush();
    } else if (LETTER.test(c) || (JOINER.test(c) && word && LETTER.test(chars[i + 1] ?? ""))) {
      if (!word) start = at;
      word += c;
    } else {
      flush();
    }
  }
  flush();
  return { normal, words };
}

/** Where sentences end in a normalised text: the last mark of each run of `. ! ? 。 ！ ？` followed by a space, the end or a CJK character. */
function sentenceEnds(normal: string): number[] {
  const ends: number[] = [];
  for (let i = 0; i < normal.length; i++) {
    if (!SENTENCE_MARK.test(normal[i]!)) continue;
    const next = normal[i + 1];
    if (next !== undefined && SENTENCE_MARK.test(next)) continue; // the run ends later
    if (next === undefined || next === " " || isCjk(next.charCodeAt(0))) ends.push(i);
  }
  return ends;
}

/** How many sentences a normalised text has: its sentence ends, and one more when it does not end with a mark; none when empty. */
function sentenceCount(normal: string): number {
  const text = normal.replace(/^ | $/g, "");
  if (!text) return 0;
  return sentenceEnds(text).length + (SENTENCE_MARK.test(text[text.length - 1]!) ? 0 : 1);
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

/** The word-level edit distance and the longer side's word count; undefined for texts too long to compare. */
function measure(a: readonly string[], b: readonly string[]): { distance: number; longest: number } | undefined {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return { distance: 0, longest };
  if (a.length * b.length > MAX_CELLS) return undefined;
  return { distance: distance(a, b, wordCost), longest };
}

function similarity(a: readonly string[], b: readonly string[]): number | undefined {
  const m = measure(a, b);
  return m === undefined ? undefined : m.longest === 0 ? 1 : 1 - m.distance / m.longest;
}

/**
 * How alike two texts are, from 0 to 1: one less the word-level edit distance over the longer text's word count. A
 * substituted word costs its character distance over its length (a typo fixed costs less than a word changed; words
 * more than three characters apart in length cost 1). 1 for the same words; 0 for texts too long to compare. The
 * .NET SDK's `SimilarityEditClassifier.WordSimilarity` is the same.
 */
export function editSimilarity(original: string, revised: string): number {
  return similarity(prose(original).words.map((w) => w.text), prose(revised).words.map((w) => w.text)) ?? 0;
}

type Judgement = { kind: "corrected" | "rewritten"; reason: string };

/** Words [a0, a1) of the original and [b0, b1) of the revision. */
interface Span {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** A comparison of two runs of words: how many were kept, the sentences on each side, and whether that is a small change. */
interface Comparison {
  distance: number;
  longest: number;
  kept: number;
  sentences: readonly [number, number];
  small: boolean;
}

function compare(a: readonly string[], b: readonly string[], textA: string, textB: string, minimum: number): Comparison | undefined {
  const m = measure(a, b);
  if (m === undefined) return undefined;
  const kept = m.longest === 0 ? 1 : 1 - m.distance / m.longest;
  const sentences = [sentenceCount(textA), sentenceCount(textB)] as const;
  const ratio = a.length === 0 ? (b.length === 0 ? 1 : Infinity) : b.length / a.length;
  return { ...m, kept, sentences, small: kept >= minimum && sentences[0] === sentences[1] && ratio >= 0.8 && ratio <= 1.25 };
}

/** The reason as both SDKs record it; `scope` says what was compared when it was not the whole text. */
function verdict(c: Comparison, scope = "", places = 1): Judgement {
  const kept = `${Math.round(c.kept * 100)} %`;
  return c.small
    ? { kind: "corrected", reason: `small change${places > 1 ? ` in ${places} places` : ""}: ${kept} of words kept${scope}, the same ${c.sentences[0]} sentence(s)` }
    : { kind: "rewritten", reason: `${kept} of words kept${scope}, ${c.sentences[0]} to ${c.sentences[1]} sentence(s)` };
}

/** The whole of both texts, as the classifier has always compared them. */
function judgeWhole(a: Prose, b: Prose, minimum: number): Judgement {
  const c = compare(a.words.map((w) => w.text), b.words.map((w) => w.text), a.normal, b.normal, minimum);
  return c === undefined ? { kind: "rewritten", reason: "too long to compare" } : verdict(c);
}

/** Whether a sentence starts (or ends) before word `i`: at either end, or between two words of different sentences. */
function boundary(x: Prose, i: number): boolean {
  return i === 0 || i === x.words.length || x.words[i - 1]!.sentence !== x.words[i]!.sentence;
}

/**
 * What changed, in whole sentences: the words between the common leading and trailing words of both texts, widened
 * on both sides to where a sentence starts and ends in both (so a word added or fixed is judged with its sentence,
 * not alone). Undefined when the words are the same.
 */
function changedRegion(a: Prose, b: Prose): Span | undefined {
  const na = a.words.length;
  const nb = b.words.length;
  let lead = 0;
  while (lead < na && lead < nb && a.words[lead]!.text === b.words[lead]!.text) lead++;
  if (lead === na && lead === nb) return undefined;
  let trail = 0;
  while (trail < na - lead && trail < nb - lead && a.words[na - 1 - trail]!.text === b.words[nb - 1 - trail]!.text) trail++;
  // The words before the change are the same in both texts, and so are those after: one index for the start, one
  // count of shared words after the change for the end. Each text's sentences may end elsewhere (a full stop added),
  // so the region grows until it starts and ends at a sentence's edge in both.
  let start = lead;
  let after = trail;
  for (let grown = true; grown;) {
    grown = false;
    for (const x of [a, b]) {
      if (!boundary(x, start)) {
        while (!boundary(x, start)) start--;
        grown = true;
      }
      let end = x.words.length - after;
      if (!boundary(x, end)) {
        while (!boundary(x, end)) end++;
        after = x.words.length - end;
        grown = true;
      }
    }
  }
  return { a0: start, a1: na - after, b0: start, b1: nb - after };
}

/** The sentences among words [from, to) of a text, which start and end at sentence edges: their words, and their words as one key. */
function sentencesIn(x: Prose, from: number, to: number): { from: number; to: number; key: string }[] {
  const out: { from: number; to: number; key: string }[] = [];
  for (let i = from; i < to;) {
    let j = i + 1;
    while (j < to && !boundary(x, j)) j++;
    out.push({ from: i, to: j, key: x.words.slice(i, j).map((w) => w.text).join(" ") });
    i = j;
  }
  return out;
}

/**
 * The places that changed within the region: runs of sentences between sentences both texts have word for word
 * (their longest common run of sentences). Undefined when there are too many sentences to line up.
 */
function placesIn(a: Prose, b: Prose, region: Span): Span[] | undefined {
  const sa = sentencesIn(a, region.a0, region.a1);
  const sb = sentencesIn(b, region.b0, region.b1);
  if (sa.length * sb.length > MAX_CELLS) return undefined;
  const width = sb.length + 1;
  // common[i * width + j]: the most sentences sa[i..] and sb[j..] have in common, in order.
  const common = new Uint32Array((sa.length + 1) * width);
  for (let i = sa.length - 1; i >= 0; i--) {
    for (let j = sb.length - 1; j >= 0; j--) {
      common[i * width + j] = sa[i]!.key === sb[j]!.key
        ? common[(i + 1) * width + j + 1]! + 1
        : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const places: Span[] = [];
  const at = (s: { from: number }[], k: number, end: number) => (k < s.length ? s[k]!.from : end);
  let gi = 0;
  let gj = 0;
  const close = (i: number, j: number) => {
    if (i > gi || j > gj) places.push({ a0: at(sa, gi, region.a1), a1: at(sa, i, region.a1), b0: at(sb, gj, region.b1), b1: at(sb, j, region.b1) });
  };
  for (let i = 0, j = 0; i < sa.length && j < sb.length;) {
    if (sa[i]!.key === sb[j]!.key) {
      close(i, j);
      gi = ++i;
      gj = ++j;
    } else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  close(sa.length, sb.length);
  return places;
}

/** The text of words [from, to): from the first word's start to the next word's (or the end); "" for none. */
function textOf(x: Prose, from: number, to: number): string {
  if (from >= to) return "";
  return x.normal.slice(x.words[from]!.start, to < x.words.length ? x.words[to]!.start : x.normal.length);
}

/**
 * The kind and why, as both SDKs judge it and record the reason. Only what changed is judged, in whole sentences:
 * a rewritten paragraph inside an unchanged document is a rewrite, however much of the document stayed. Edits in
 * several places, apart from each other by sentences that stayed word for word, are each judged on their own, and
 * the revision is `corrected` only when every one is a small change: judged together, the unchanged sentences between
 * them would count as kept words and let a rewrite at one end pass as a correction. The same words throughout (or
 * one change that spans both texts) are judged as a whole, as before.
 */
function judge(before: string, after: string, minimum: number): Judgement {
  const a = prose(before);
  const b = prose(after);
  const region = changedRegion(a, b);
  if (region === undefined) return judgeWhole(a, b, minimum);
  const places = placesIn(a, b, region);
  const total = a.words.length;
  if (places === undefined) return { kind: "rewritten", reason: `too long to compare in the changed sentences (${region.a1 - region.a0} of ${total} words)` };
  const [only] = places;
  if (places.length === 1 && only!.a0 === 0 && only!.b0 === 0 && only!.a1 === total && only!.b1 === b.words.length) return judgeWhole(a, b, minimum);
  const scope = (words: number, place?: number) =>
    ` in the changed sentences (${place === undefined ? "" : `place ${place} of ${places.length}: `}${words} of ${total} words)`;
  const all: Comparison = { distance: 0, longest: 0, kept: 1, sentences: [0, 0], small: true };
  let words = 0;
  for (const [k, p] of places.entries()) {
    const c = compare(a.words.slice(p.a0, p.a1).map((w) => w.text), b.words.slice(p.b0, p.b1).map((w) => w.text),
      textOf(a, p.a0, p.a1), textOf(b, p.b0, p.b1), minimum);
    const place = places.length > 1 ? k + 1 : undefined;
    if (c === undefined) return { kind: "rewritten", reason: `too long to compare${scope(p.a1 - p.a0, place)}` };
    if (!c.small) return verdict(c, scope(p.a1 - p.a0, place));
    all.distance += c.distance;
    all.longest += c.longest;
    all.sentences = [all.sentences[0] + c.sentences[0], all.sentences[1] + c.sentences[1]];
    words += p.a1 - p.a0;
  }
  all.kept = all.longest === 0 ? 1 : 1 - all.distance / all.longest;
  return verdict(all, scope(words), places.length);
}

/**
 * The edit kind for a revision of `original`: `corrected` (exempt: spelling, grammar, a light polish) only for a
 * small change -- in the sentences that changed, word similarity at least `minSimilarity`, the same number of
 * sentences, and a word count within 0.8 to 1.25 times; edits in several places each on their own -- and `rewritten`
 * (marked) otherwise. When in doubt, it marks. HTML and Markdown (`options.mediaType`) are compared by the text a
 * reader sees.
 */
export function suggestEditKind(original: string, revised: string, options: EditSimilarityOptions = {}): "corrected" | "rewritten" {
  const type = options.mediaType ?? "text/plain";
  return judge(readerText(original, type), readerText(revised, type), options.minSimilarity ?? DEFAULT_MIN).kind;
}

/**
 * An edit classifier from `suggestEditKind`: for a placement declared `rewritten` or `corrected` that names the text
 * it replaces (`PlaceRequest.original`), `corrected` for a small change and `rewritten` otherwise, with the reason
 * recorded on the device -- what was kept, and where, when only part of the text changed. HTML and Markdown are
 * compared by the text a reader sees of both, in the placement's media type. Anything else keeps its kind.
 */
export function similarityClassifier(options: EditSimilarityOptions = {}): EditClassifier {
  return {
    classify(input) {
      if ((input.declared !== "rewritten" && input.declared !== "corrected") || input.original === undefined || typeof input.content !== "string") {
        return undefined;
      }
      return judge(readerText(input.original, input.mediaType), readerText(input.content, input.mediaType), options.minSimilarity ?? DEFAULT_MIN);
    },
  };
}
