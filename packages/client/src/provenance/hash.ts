/**
 * How content is hashed for provenance, the same way by every party (the server, the gateway, both SDKs): the
 * server keys these hashes; it never receives the content.
 *
 * Text is normalised first, so a host that reflows or re-spaces it still matches: Unicode NFC; U+0007 and U+0001
 * removed (Word's cell and field marks); every run of white space replaced by one space; leading and trailing space
 * removed. Then UTF-8, then SHA-256, as hex. The contract's `text-hash-vectors.json` is the test.
 */

/** Word's cell and field marks. */
const MARKS = /[\u0007\u0001]/g;

/**
 * White space as the reference implementation (Python's `\s`) counts it: ASCII white space, U+001C to U+001F,
 * U+0085, U+00A0 and the Unicode spaces. Not U+FEFF, which JavaScript's `\s` would take.
 */
const SPACES = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];
const SPACE = new RegExp(`[${SPACES.map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join("")}]+`, "g");

/** The text as it is hashed. */
export function normalizeText(text: string): string {
  // After the runs became single spaces only a space can lead or trail; trim() would also take U+FEFF.
  return text.normalize("NFC").replace(MARKS, "").replace(SPACE, " ").replace(/^ | $/g, "");
}

/** SHA-256 of the normalised text, hex. */
export function textSha256(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(normalizeText(text)));
}

/** SHA-256 of bytes (a picture, a file), hex. */
export function bytesSha256(data: Uint8Array): Promise<string> {
  return sha256Hex(data);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
