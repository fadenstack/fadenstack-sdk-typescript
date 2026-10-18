import { isReasonCode, receiptIdOf, type ReceiptNote } from "@fadenstack/client";

import { bareType, isImage } from "../content.js";
import type { ContentMarker, MarkOutcome, PlacedContent, ProvenanceRecord } from "../types.js";

/**
 * Whether the content carries a watermark, from what the server said made it: text is watermarked by the model as it
 * is written (from `short_text_tokens` on), a picture by the server before it leaves. Nothing on the device can
 * watermark or detect one, so this only reports, and never says `verified`. The methods: `vllm-<algorithm>` (a local
 * model's runtime), `upstream-<vendor>` (a remote provider's own mark), the engine's algorithm, `trustmark` (a
 * picture); `model` when the text carries none.
 */
export function watermarkOf(receipt: ReceiptNote | undefined, mediaType: string, shortText: boolean): MarkOutcome {
  if (isImage(mediaType)) {
    // The gateway marks every picture it makes before it leaves, or refuses it: a picture with its receipt has one.
    return receiptIdOf(receipt) !== undefined
      ? { applied: true, method: "trustmark", detail: "picture with a receipt" }
      : { applied: false, method: "trustmark", detail: "no receipt" };
  }
  if (shortText) return { applied: false, method: "model", reason: "short-text" };
  if (!receipt) return { applied: false, method: "model", detail: "no receipt" };
  if (receipt.status === "unsigned") {
    return { applied: false, method: "model", reason: isReasonCode(receipt.reason) ? receipt.reason : "server-unavailable", detail: "unsigned answer" };
  }
  if (receipt.status === "reference") return { applied: false, method: "model", detail: "receipt without its details" };
  const watermark = receipt.receipt.watermark;
  switch (watermark.applied) {
    case "model":
      return { applied: true, method: `vllm-${watermark.algorithm ?? "gumbel"}` };
    case "engine":
      return { applied: true, method: watermark.algorithm ?? "engine" };
    case "upstream":
      return { applied: true, method: `upstream-${watermark.vendor ?? "vendor"}` };
    default:
      return { applied: false, method: "model", ...(isReasonCode(watermark.reason) ? { reason: watermark.reason } : {}) };
  }
}

/** Records whether the content carries a watermark, from the receipt (`watermarkOf`); it never watermarks itself. */
export class WatermarkStatus implements ContentMarker {
  readonly name = "watermark-status";
  readonly layer = "watermark";

  supports(_sink: unknown, mediaType: string): boolean {
    const type = bareType(mediaType);
    return isImage(type) || type.startsWith("text/") || type === "application/xhtml+xml";
  }

  attach(placed: PlacedContent, record: ProvenanceRecord): MarkOutcome {
    return watermarkOf(record.receipt, placed.mediaType, placed.shortText);
  }
}
