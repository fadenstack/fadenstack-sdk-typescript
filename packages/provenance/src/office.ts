import { RECORD_ID } from "./content.js";

/**
 * The names and formats of the marks in Office documents and mails, the same as the .NET SDK's `OfficeMarks`, for host
 * markers of Office files (ONLYOFFICE, a `.docx` written as a file) and anyone who reads them, so that every marker
 * and the server's detector agree:
 * - Word: a hidden bookmark around the inserted range (`officeAnchorName`), the signed records in a custom XML part
 *   (`officeCustomXmlPart`, namespace `OfficeMarks.namespace`), and the custom document property
 *   `AI-Generated-Content` as the flag (`officeDocumentPropertyValue`, at most 255 characters).
 * - PowerPoint: the shape or slide tag `FADEN_AI_RECORD` with the record's id, and the custom XML part.
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
  /** The PowerPoint shape and slide tag that holds the record's id. */
  shapeTag: "FADEN_AI_RECORD",
  /** The internet header a mail draft carries the record's id in. */
  mailHeader: "X-AI-Generated",
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

/** Whether a bookmark or name is one of our anchors. */
export function isOfficeAnchor(name: string | null | undefined): boolean {
  return typeof name === "string" && new RegExp(`^${OfficeMarks.anchorPrefix}[0-9a-fA-F]{24}$`).test(name);
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
