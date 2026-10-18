import { RECORD_ID, bareType } from "../content.js";
import { Carriers, type ContentMarker, type MarkableContent, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/** Starts the invisible mark, as C2PA's text wrapper does (A.8): U+FEFF, zero width no-break space. */
const START = 0xfeff;
/** What the mark's bytes begin with: ours, not a C2PA manifest store, which C2PA readers would look for. */
const MAGIC = [0x46, 0x44, 0x4e, 0x50, 0x01]; // "FDNP", version 1

/** A byte as a variation selector (C2PA A.8): 0-15 as U+FE00-U+FE0F, 16-255 as U+E0100-U+E01EF. */
function selector(byte: number): string {
  return String.fromCodePoint(byte < 16 ? 0xfe00 + byte : 0xe0100 + byte - 16);
}

function byteOf(codePoint: number): number | undefined {
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return codePoint - 0xfe00;
  if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return codePoint - 0xe0100 + 16;
  return undefined;
}

/**
 * The record's id as invisible characters, the format both SDKs write: U+FEFF, then the bytes `46 44 4E 50 01`
 * ("FDNP" and version 1) and the id's UTF-8 bytes, each byte as one variation selector -- 0 to 15 as U+FE00 to
 * U+FE0F, 16 to 255 as U+E0100 to U+E01EF. For a UUID: 1 + 5 + 36 = 42 code points.
 */
export function invisibleMark(recordId: string): string {
  const bytes = [...MAGIC, ...new TextEncoder().encode(recordId)];
  return String.fromCharCode(START) + bytes.map(selector).join("");
}

/** The record ids invisible marks of ours in `text` name, in order: a U+FEFF followed by our bytes and a valid id. */
export function invisibleRecordIds(text: string): string[] {
  const ids: string[] = [];
  const points = [...text].map((c) => c.codePointAt(0)!);
  for (let i = points.indexOf(START); i >= 0; i = points.indexOf(START, i + 1)) {
    const bytes: number[] = [];
    for (let j = i + 1; j < points.length; j++) {
      const byte = byteOf(points[j]!);
      if (byte === undefined) break;
      bytes.push(byte);
    }
    if (bytes.length <= MAGIC.length || MAGIC.some((b, k) => bytes[k] !== b)) continue;
    const id = new TextDecoder().decode(new Uint8Array(bytes.slice(MAGIC.length)));
    if (RECORD_ID.test(id)) ids.push(id);
  }
  return ids;
}

/**
 * Opt-in only: the record's id as invisible characters (`invisibleMark`) at the very end of plain text or Markdown,
 * using the variation selectors of C2PA's text embedding (A.8) with a payload of our own. Security filters and model
 * guardrails flag or strip such characters, and some editors drop them on save (Gmail's draft save does), so it is
 * never on by default; the placement records whether they held. The sink carries `unicode-text`.
 */
export class UnicodeTextMarker implements ContentMarker {
  readonly name = "unicode-text";
  readonly layer = "metadata";

  supports(sink: SinkInfo, mediaType: string): boolean {
    const type = bareType(mediaType);
    return sink.carries.includes(Carriers.unicodeText) && (type === "text/plain" || type === "text/markdown");
  }

  prepare(content: MarkableContent, record: ProvenanceRecord): MarkableContent {
    const text = typeof content.content === "string" ? content.content : new TextDecoder().decode(content.content);
    return { ...content, content: `${text}${invisibleMark(record.id)}` };
  }

  async attach(placed: PlacedContent, record: ProvenanceRecord): Promise<MarkOutcome> {
    const back = await placed.readBack();
    const text = back instanceof Uint8Array ? new TextDecoder().decode(back) : back;
    if (text === undefined) return { applied: true, method: this.name, verified: false, detail: "not read back" };
    return invisibleRecordIds(text).includes(record.id)
      ? { applied: true, method: this.name, verified: true }
      : { applied: false, method: this.name, reason: "stripped-by-host", detail: "the invisible characters were dropped" };
  }
}
