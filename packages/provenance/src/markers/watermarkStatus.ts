import { isReasonCode } from "@fadenstack/client";

import { isImage } from "../content.js";
import type { ContentMarker, MarkOutcome, PlacedContent, ProvenanceRecord } from "../types.js";
import { inspectImage } from "./imageGuard.js";

/**
 * Whether the content carries a watermark, from what the server said made it: text is watermarked by the model as it
 * is written, a picture by the server before it leaves. Nothing on the device can watermark, so this only reports.
 */
export function watermarkOf(
  record: Pick<ProvenanceRecord, "receipt" | "receiptId">,
  mediaType: string,
  content: string | Uint8Array,
): MarkOutcome {
  if (isImage(mediaType)) {
    // The gateway refuses a picture it could not mark, so a picture with a receipt or its C2PA has its watermark.
    const marked = record.receiptId !== undefined || (content instanceof Uint8Array && inspectImage(content).c2pa);
    return marked ? { applied: true, method: "trustmark", verified: false } : { applied: false, method: "trustmark" };
  }
  const note = record.receipt;
  if (!note) return { applied: false, method: "none", reason: "server-unavailable" };
  if (note.status === "unsigned") return { applied: false, method: "none", reason: isReasonCode(note.reason) ? note.reason : "server-unavailable" };
  if (note.status === "reference") return { applied: false, method: "receipt" }; // only its id: it cannot be told
  const watermark = note.receipt.watermark;
  if (watermark.applied === "none") {
    return { applied: false, method: "none", ...(isReasonCode(watermark.reason) ? { reason: watermark.reason } : {}) };
  }
  const method = watermark.applied === "upstream" ? `upstream:${watermark.vendor ?? "vendor"}` : watermark.algorithm ?? watermark.applied;
  return { applied: true, method };
}

/** Records whether the content carries a watermark, from the receipt (`watermarkOf`); it never watermarks itself. */
export class WatermarkStatus implements ContentMarker {
  readonly name = "watermark-status";
  readonly layer = "watermark";

  supports(_sink: unknown, mediaType: string): boolean {
    const type = mediaType.toLowerCase();
    return isImage(type) || type.startsWith("text/") || type === "application/xhtml+xml";
  }

  attach(placed: PlacedContent, record: ProvenanceRecord): MarkOutcome {
    return watermarkOf(record, placed.mediaType, placed.content);
  }
}
