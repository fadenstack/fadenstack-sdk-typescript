import type { LengthClass, ProvenancePolicy } from "@fadenstack/client";

/** A record id as marks carry it: the server's (a UUID), or this device's when the server could not sign. */
export const RECORD_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|unsigned-[0-9a-f]{32})$/i;
/** The same, inside other text. */
export const RECORD_ID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|unsigned-[0-9a-f]{32}/gi;

export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID.test(value);
}

/** 32 hex characters. */
export function localId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

export function isImage(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith("image/");
}

/**
 * Code and data formats (source code, SQL, YAML, JSON, scripts): outside what must be marked, as the guidelines on
 * Art. 50 say (para 68). Recorded as exempt.
 */
export function isCode(mediaType: string): boolean {
  const type = mediaType.toLowerCase().split(";")[0]!.trim();
  return (/^(text|application)\/x-/.test(type) && type !== "application/x-www-form-urlencoded")
    || /\+json$/.test(type)
    || ["application/json", "application/javascript", "text/javascript", "application/sql", "application/yaml", "text/yaml",
      "application/toml", "text/css"].includes(type);
}

/** About how many tokens a text is: the integrator's tokenizer, or four characters a token (HTML without its tags). */
export function tokensOf(text: string, mediaType: string, tokenizer?: (text: string) => number): number {
  const plain = mediaType.toLowerCase().startsWith("text/html") ? text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ") : text;
  return tokenizer ? tokenizer(plain) : Math.ceil(plain.trim().length / 4);
}

/** Short: under the policy's threshold; medium: under five times it; long: more. Bytes: under 1 KiB, 100 KiB, more. */
export function lengthClass(content: string | Uint8Array, tokens: number, policy: Required<ProvenancePolicy>): LengthClass {
  if (typeof content !== "string") return content.length < 1024 ? "short" : content.length < 100 * 1024 ? "medium" : "long";
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
