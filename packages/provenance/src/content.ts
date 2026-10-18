import { normalizeText, type LengthClass, type ProvenancePolicy } from "@fadenstack/client";

/** A record id as the server issues them and marks carry them: a UUID. */
export const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The same, inside other text. */
export const RECORD_ID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID.test(value);
}

/** The media type without parameters, in lower case: `text/html; charset=utf-8` is `text/html`. */
export function bareType(mediaType: string): string {
  return mediaType.split(";")[0]!.trim().toLowerCase();
}

export function isImage(mediaType: string): boolean {
  return bareType(mediaType).startsWith("image/");
}

const CODE_TYPES = new Set([
  "application/json", "application/xml", "text/xml", "application/javascript", "text/javascript", "application/x-yaml",
  "application/yaml", "text/yaml", "application/toml", "application/sql", "text/css", "application/x-sh", "application/x-powershell",
]);

/**
 * Code and data formats (source code, scripts, JSON, XML, YAML, SQL, CSS): outside what must be marked, as the
 * guidelines on Art. 50 say (para 68). Recorded as exempt. `text/x-*` (but `text/x-markdown`), `+json`, `+xml` (but
 * XHTML), and the formats in `CODE_TYPES`; a picture never is (`image/svg+xml`).
 */
export function isCode(mediaType: string): boolean {
  const type = bareType(mediaType);
  if (type.startsWith("image/")) return false;
  return (type.startsWith("text/x-") && type !== "text/x-markdown")
    || type.endsWith("+json")
    || (type.endsWith("+xml") && type !== "application/xhtml+xml")
    || CODE_TYPES.has(type);
}

/** Hiragana and katakana, CJK ideographs (and extension A), Hangul syllables, compatibility ideographs. */
export function isCjk(code: number): boolean {
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff);
}

/**
 * About how many tokens a text is, as the gateway estimates: one per CJK character and one per four other
 * characters (UTF-16 code units, rounded up); the integrator's tokenizer instead, when given.
 */
export function tokensOf(text: string, tokenizer?: (text: string) => number): number {
  if (tokenizer) return tokenizer(text);
  let cjk = 0;
  for (let i = 0; i < text.length; i++) if (isCjk(text.charCodeAt(i))) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

const SENTENCE_MARKS = /[.!?;。！？]/;

/**
 * A label (guidelines para 68: single words, captions, UI and data labels), which needs no mark: after the
 * normalisation of hashing (HTML without its tags), empty, or without any sentence mark (`. ! ? ; 。 ！ ？`) and at
 * most three words and 40 characters -- at most 8 characters for text with CJK characters. "Approved", "Q3 revenue",
 * `<b>Approved</b>`. Anything that reads as a sentence is marked.
 */
export function isLabel(text: string, mediaType = "text/plain"): boolean {
  const type = bareType(mediaType);
  const normal = normalizeText(type === "text/html" || type === "application/xhtml+xml" ? text.replace(/<[^>]*>/g, " ") : text);
  if (normal.length === 0) return true;
  if (SENTENCE_MARKS.test(normal)) return false;
  for (let i = 0; i < normal.length; i++) if (isCjk(normal.charCodeAt(i))) return normal.length <= 8;
  return normal.length <= 40 && normal.split(" ").length <= 3;
}

/** Text: short under the policy's threshold, medium under five times it, long above. Bytes (pictures, files): long. */
export function lengthClass(content: string | Uint8Array, tokens: number, policy: Required<ProvenancePolicy>): LengthClass {
  if (typeof content !== "string") return "long";
  const threshold = policy.short_text_tokens;
  return tokens < threshold ? "short" : tokens < 5 * threshold ? "medium" : "long";
}

/** A `data:` URL's bytes, or undefined for anything else. */
export function dataUrlBytes(value: string): Uint8Array | undefined {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(value.trim());
  if (!match) return undefined;
  const binary = atob(match[1]!.replace(/\s/g, ""));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text for an attribute's value in double quotes: `&`, `<`, `>` and `"` escaped, nothing else. */
export function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/** The common entities back, in an attribute's value. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, name: string) => {
    const n = name.toLowerCase();
    if (n.startsWith("#x")) return safeCodePoint(parseInt(n.slice(2), 16), whole);
    if (n.startsWith("#")) return safeCodePoint(parseInt(n.slice(1), 10), whole);
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: String.fromCharCode(0xa0) } as Record<string, string>)[n] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Where `needle` (ASCII) first occurs in `bytes`, or -1. */
export function indexOfAscii(bytes: Uint8Array, needle: string, from = 0): number {
  const first = needle.charCodeAt(0);
  outer: for (let i = bytes.indexOf(first, from); i >= 0 && i <= bytes.length - needle.length; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** The newline a text uses: CRLF when it has any, else LF. */
export function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
