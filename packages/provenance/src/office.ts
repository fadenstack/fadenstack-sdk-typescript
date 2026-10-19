import { RECORD_ID } from "./content.js";

/**
 * The names and formats of the marks in Office documents and mails, the same as the .NET SDK's `OfficeMarks`, for host
 * markers of Office files (ONLYOFFICE, a `.docx` written as a file) and anyone who reads them, so that every marker
 * and the server's detector agree:
 * - Word: a hidden bookmark around the inserted range (`officeAnchorName`; a later write inside it splits it into
 *   parts, `splitOfficeAnchors`, read back with `officeRecordSpans`), the signed records in a custom XML part
 *   (`officeCustomXmlPart`, namespace `OfficeMarks.namespace`), and the custom document property
 *   `AI-Generated-Content` as the flag (`officeDocumentPropertyValue`, at most 255 characters).
 * - PowerPoint: the shape or slide tag `FADEN_AI_RECORD` with the newest record's id, `FADEN_AI_RECORDS` with every
 *   record whose words are in it (`officeShapeRecords`), and the custom XML part.
 * - Excel: a hidden name per written range (`officeAnchorName`), and the custom XML part.
 * - Outlook: the internet header `X-AI-Generated` with the record's id.
 * The detector finds the record ids in any `customXml/` part with the namespace and in `docProps/custom.xml`.
 */
export const OfficeMarks = {
  /** The namespace of the custom XML part that holds the signed records. */
  namespace: "https://fadenstack.com/ns/provenance/1.0",
  /** The custom document property that flags a document as holding AI-generated content. */
  documentProperty: "AI-Generated-Content",
  /** Desktop Word cuts custom document properties at 255 characters. */
  documentPropertyMaxLength: 255,
  /** A hidden bookmark (Word) or hidden name (Excel) starts with this; an underscore hides it. */
  anchorPrefix: "_faden_ai_",
  /** The longest anchor: a record's anchor (34 characters) and a part's `_99`. Word allows 40. */
  anchorMaxLength: 37,
  /** The last part of an anchor: a record's anchor is its first part, `<anchor>_2` to `<anchor>_99` the others. */
  anchorMaxPart: 99,
  /** The PowerPoint shape and slide tag that holds the id of the newest record that wrote into it. */
  shapeTag: "FADEN_AI_RECORD",
  /**
   * The PowerPoint shape and slide tag that lists every record whose words are in it, oldest first, space-separated
   * (`officeShapeRecords`, `officeShapeRecordsAfterWrite`).
   */
  shapeRecordsTag: "FADEN_AI_RECORDS",
  /** The internet header a mail draft carries the record's id in. */
  mailHeader: "X-AI-Generated",
  /**
   * The host value (`MarkableContent.hostValues`) a Word or Excel marker's `prepare` sets to the anchor's name
   * (`officeAnchorName`), so the insert makes the bookmark or name together with the content, in one undo entry.
   */
  anchorValue: "office.anchor",
} as const;

/** One record in a document's custom XML part: its id, the anchor it marks, its signature (a JWS), its time-stamp. */
export interface OfficeRecord {
  readonly recordId: string;
  readonly anchor: string;
  readonly signature: string;
  readonly timestamp?: string | null;
}

/**
 * The bookmark or name of a record: `_faden_ai_` and the first 24 hex digits of the record's id, dashes removed (34
 * characters; Word allows 40, and letters, digits and underscores only).
 */
export function officeAnchorName(recordId: string): string {
  const hex = [...recordId].filter((c) => /[0-9a-f]/i.test(c)).slice(0, 24).join("").toLowerCase();
  if (hex.length < 24) throw new TypeError("A record id (a UUID) is needed for an anchor.");
  return OfficeMarks.anchorPrefix + hex;
}

/** A record's anchor, then optionally a part's number: `_2` to `_99`, without leading zeros. */
const ANCHOR = new RegExp(`^(${OfficeMarks.anchorPrefix}[0-9a-fA-F]{24})(?:_(?:[2-9]|[1-9][0-9]))?$`);

/**
 * Whether a bookmark or name is one of our anchors: a record's anchor (`officeAnchorName`), or a later part of it,
 * `<anchor>_<n>` with n from 2 to 99, where a later write inside the record's text split its bookmark
 * (`splitOfficeAnchors`).
 */
export function isOfficeAnchor(name: string | null | undefined): boolean {
  return officeAnchorBase(name) !== null;
}

/**
 * The record's anchor a bookmark or name is part of: the name itself for a record's anchor, the name without its `_<n>`
 * for a later part; null for a name that is no anchor of ours. Every part maps to the same record, as written.
 */
export function officeAnchorBase(name: string | null | undefined): string | null {
  return typeof name === "string" ? (ANCHOR.exec(name)?.[1] ?? null) : null;
}

/** The name of part `part` (2 to 99) of an anchor, given the anchor or any part of it: `<anchor>_<part>`. */
export function officeAnchorPart(anchor: string, part: number): string {
  const base = officeAnchorBase(anchor);
  if (base === null) throw new TypeError("A part's name needs an anchor of ours.");
  if (!Number.isInteger(part) || part < 2 || part > OfficeMarks.anchorMaxPart) {
    throw new RangeError(`An anchor's parts are numbered from 2 to ${OfficeMarks.anchorMaxPart}.`);
  }
  return `${base}_${part}`;
}

/**
 * The record of a custom XML part's that an anchor or any part of it marks (its `anchor`, or the anchor of its id);
 * undefined when none does. Anchors compare without regard to case, as Word's bookmark names do.
 */
export function officeRecordOfAnchor(records: readonly OfficeRecord[], name: string | null | undefined): OfficeRecord | undefined {
  const base = officeAnchorBase(name)?.toLowerCase();
  if (!base) return undefined;
  return records.find((r) => officeAnchorBase(r.anchor)?.toLowerCase() === base || (RECORD_ID.test(r.recordId) && officeAnchorName(r.recordId) === base));
}

/** A stretch of a document's story by character positions, `start` in it and `end` not: Word's `Range.Start` and `End`. */
export interface OfficeSpan {
  readonly start: number;
  readonly end: number;
}

/** A bookmark and where it is in its story. */
export interface OfficeAnchorSpan extends OfficeSpan {
  readonly name: string;
}

/** What a later write does to the anchors it landed in: the anchors to put (an existing name moves, a new one is added), the names to remove. */
export interface OfficeAnchorSplit {
  readonly set: OfficeAnchorSpan[];
  readonly removed: string[];
}

/** The spans sorted, those with nothing in them left out, overlapping and touching ones joined. */
function joined(spans: readonly OfficeSpan[]): OfficeSpan[] {
  const sorted = spans.filter((s) => s.end > s.start).map((s) => ({ start: s.start, end: s.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push(s);
  }
  return out;
}

/** What of `span` is outside `cuts` (sorted and joined), in order. */
function outside(span: OfficeSpan, cuts: readonly OfficeSpan[]): OfficeSpan[] {
  const pieces: OfficeSpan[] = [];
  let from = span.start;
  for (const cut of cuts) {
    if (cut.end <= from) continue;
    if (cut.start >= span.end) break;
    if (cut.start > from) pieces.push({ start: from, end: cut.start });
    from = cut.end;
  }
  if (from < span.end) pieces.push({ start: from, end: span.end });
  return pieces;
}

const overlap = (a: OfficeSpan, b: OfficeSpan) => Math.max(a.start, b.start) < Math.min(a.end, b.end);

/**
 * Marks never nest, as in HTML: after a write, the anchors of earlier records hold only their own text. Word grows a
 * bookmark around text written inside it or at its start; given the anchors of the story as they are after the write
 * and the spans it wrote (its text, a paragraph mark it added, each replacement), this says how they must be. Each
 * earlier anchor that holds written text loses it: the part before keeps the name, the part after becomes a new part
 * `<anchor>_<n>` (the lowest n from 2 to 99 that no bookmark has), and a part with nothing in it goes -- so an anchor
 * that starts where the write starts moves to just after it, keeping its name, and one the write covers is removed.
 * `own` is the write's own anchor, which stays as it is; `taken` names the document's other bookmarks, whose names a
 * new part does not take. Without a free number the text after the write stays without an anchor. Bookmarks that are
 * not ours are never touched. The .NET SDK's `OfficeMarks.SplitAnchors` is the same.
 */
export function splitOfficeAnchors(
  anchors: readonly OfficeAnchorSpan[],
  written: readonly OfficeSpan[],
  own?: string | null,
  taken: readonly string[] = [],
): OfficeAnchorSplit {
  const cuts = joined(written);
  const ownBase = own ? (officeAnchorBase(own) ?? own).toLowerCase() : null;
  const used = new Set([...anchors.map((a) => a.name), ...taken].map((n) => n.toLowerCase()));
  const set: OfficeAnchorSpan[] = [];
  const removed: string[] = [];
  for (const anchor of [...anchors].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const base = officeAnchorBase(anchor.name);
    if (base === null || base.toLowerCase() === ownBase || !cuts.some((c) => overlap(anchor, c))) continue;
    const [first, ...rest] = outside(anchor, cuts);
    if (!first) {
      removed.push(anchor.name);
      continue;
    }
    set.push({ name: anchor.name, start: first.start, end: first.end });
    for (const piece of rest) {
      const name = freePart(base, used);
      if (name) set.push({ name, start: piece.start, end: piece.end });
    }
  }
  return { set, removed };
}

function freePart(base: string, used: Set<string>): string | null {
  for (let n = 2; n <= OfficeMarks.anchorMaxPart; n++) {
    const name = `${base}_${n}`;
    if (!used.has(name.toLowerCase())) {
      used.add(name.toLowerCase());
      return name;
    }
  }
  return null;
}

/**
 * Where a record's text is in a story: the spans of its anchor and of every part of it, in document order, without
 * what anchors of other records inside them hold (one around the very same text is not inside). The record's text is
 * the text of these spans joined with nothing between: as it was placed, also after later writes split its anchor.
 * `record` is the record's id or its anchor (or a part's name); no spans when it has no anchor in `anchors`. The .NET
 * SDK's `OfficeMarks.RecordSpans` is the same.
 */
export function officeRecordSpans(anchors: readonly OfficeAnchorSpan[], record: string): OfficeSpan[] {
  const wanted = (officeAnchorBase(record) ?? (RECORD_ID.test(record) ? officeAnchorName(record) : null))?.toLowerCase();
  if (!wanted) return [];
  const ours = (a: OfficeAnchorSpan) => officeAnchorBase(a.name)?.toLowerCase() === wanted;
  const others = anchors.filter((a) => !ours(a) && officeAnchorBase(a.name) !== null && a.end > a.start);
  const spans: OfficeSpan[] = [];
  for (const part of anchors.filter((a) => ours(a) && a.end > a.start)) {
    const inside = others.filter((o) => o.start >= part.start && o.end <= part.end && !(o.start === part.start && o.end === part.end));
    spans.push(...outside(part, joined(inside)));
  }
  return joined(spans);
}

/**
 * The records whose words a PowerPoint shape (or slide) holds, oldest first: the ids its `FADEN_AI_RECORDS` tag lists
 * (`records`), then the one its `FADEN_AI_RECORD` tag holds (`record`) when the list misses it -- a shape tagged
 * before the list, or by an add-in without it. Only record ids count, each once. A shape has no bookmarks, so a write
 * into part of its text leaves it holding the words of more than one record. The .NET SDK's `OfficeMarks.ShapeRecords`
 * is the same.
 */
export function officeShapeRecords(records: string | null | undefined, record: string | null | undefined): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (RECORD_ID.test(id) && !ids.some((i) => i.toLowerCase() === id.toLowerCase())) ids.push(id);
  };
  for (const id of (records ?? "").split(/\s+/)) add(id);
  add((record ?? "").trim());
  return ids;
}

/**
 * The `FADEN_AI_RECORDS` tag of a shape (or slide) after record `recordId` wrote into it, whose `FADEN_AI_RECORD`
 * becomes `recordId` either way. A write into part of its text (`partial`: the rest of its words stay) puts the record
 * after those already there (`officeShapeRecords`, so the list starts from `FADEN_AI_RECORD` when there is none); a
 * write of its whole text, or a new shape, leaves the record alone. The .NET SDK's `OfficeMarks.ShapeRecordsAfterWrite`
 * is the same.
 */
export function officeShapeRecordsAfterWrite(
  records: string | null | undefined,
  record: string | null | undefined,
  recordId: string,
  partial: boolean,
): string {
  if (!RECORD_ID.test(recordId)) throw new TypeError("A record id (a UUID) is needed for a shape's tags.");
  if (!partial) return recordId;
  return [...officeShapeRecords(records, record).filter((id) => id.toLowerCase() !== recordId.toLowerCase()), recordId].join(" ");
}

/**
 * The document property's value: `true` and the records' ids, newest first (`recordIds` in the order they were placed),
 * as many as fit in 255 characters; the custom XML part holds them all.
 */
export function officeDocumentPropertyValue(recordIds: readonly string[]): string {
  let value = "true";
  for (const id of [...new Set([...recordIds].reverse())]) {
    if (value.length + 1 + id.length > OfficeMarks.documentPropertyMaxLength) break;
    value += ` ${id}`;
  }
  return value;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The custom XML part, exactly as the .NET SDK writes it: `<provenance xmlns="https://fadenstack.com/ns/provenance/1.0">`
 * with one `<record id="..." anchor="..." timestamp="...">JWS</record>` per placement (`timestamp` only where there is
 * one), no XML declaration, no white space between elements.
 */
export function officeCustomXmlPart(records: readonly OfficeRecord[]): string {
  const open = `<provenance xmlns="${OfficeMarks.namespace}"`;
  if (records.length === 0) return `${open} />`;
  const items = records.map((r) => `<record id="${escapeXml(r.recordId)}" anchor="${escapeXml(r.anchor)}"`
    + `${r.timestamp ? ` timestamp="${escapeXml(r.timestamp)}"` : ""}>${escapeXml(r.signature)}</record>`);
  return `${open}>${items.join("")}</provenance>`;
}

/** The records in a custom XML part of ours; none when it is not ours. Data, never instructions. */
export function readOfficeCustomXmlPart(xml: string | null | undefined): OfficeRecord[] {
  if (!xml || !new RegExp(`<provenance\\s+xmlns="${OfficeMarks.namespace.replace(/[./]/g, "\\$&")}"`).test(xml)) return [];
  const records: OfficeRecord[] = [];
  for (const m of xml.matchAll(/<record\b([^>]*)>([^<]*)<\/record>/g)) {
    const attribute = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1] ?? "")?.[1];
    const recordId = attribute("id") ?? "";
    if (!RECORD_ID.test(recordId)) continue;
    const timestamp = attribute("timestamp");
    records.push({ recordId, anchor: attribute("anchor") ?? "", signature: (m[2] ?? "").trim(), ...(timestamp ? { timestamp } : {}) });
  }
  return records;
}
