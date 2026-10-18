import type { GenerationReceipt } from "./contract.js";

/**
 * The header the gateway names the receipts of an answer in: one id, or several comma-separated in order (an answer
 * with pictures has one per picture). A streamed answer's receipt comes as its last event instead.
 */
export const RECEIPT_HEADER = "x-faden-provenance";

/** The gateway's event with an answer's signed receipt, at the end of a streamed answer. */
export const RECEIPT_EVENT = "faden.provenance";

/**
 * What the gateway said about the provenance of an answer: its signed receipt (the stream's last event), only the
 * receipt's id (the `x-faden-provenance` header of an answer that was not streamed, or of pictures), or that no
 * receipt could be signed and why.
 */
export type ReceiptNote =
  | { status: "signed"; receipt: GenerationReceipt; signature: string; timestamp?: string | null }
  | { status: "reference"; receiptId: string }
  | { status: "unsigned"; reason: string };

/** The receipt's id, when there is one. */
export function receiptIdOf(note: ReceiptNote | undefined): string | undefined {
  if (!note) return undefined;
  return note.status === "signed" ? note.receipt.id : note.status === "reference" ? note.receiptId : undefined;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

/** The receipt in a `faden.provenance` event's value, or undefined for a value that is neither shape. */
export function readReceiptEvent(value: unknown): ReceiptNote | undefined {
  const v = obj(value);
  if (!v) return undefined;
  const receipt = obj(v["receipt"]);
  if (receipt) {
    const id = receipt["id"];
    const signature = v["signature"];
    if (typeof id !== "string" || !ID.test(id) || typeof signature !== "string" || !signature) return undefined;
    const note: ReceiptNote = { status: "signed", receipt: receipt as unknown as GenerationReceipt, signature };
    if (typeof v["timestamp"] === "string") note.timestamp = v["timestamp"];
    return note;
  }
  if (v["status"] === "unsigned") {
    return { status: "unsigned", reason: typeof v["reason"] === "string" && v["reason"] ? v["reason"] : "server-unavailable" };
  }
  return undefined;
}

/** The receipts an `x-faden-provenance` header names, in order; none for an empty or missing header. */
export function readReceiptHeader(value: string | null | undefined): ReceiptNote[] {
  if (!value) return [];
  return value.split(",").map((id) => id.trim()).filter((id) => ID.test(id)).map((receiptId) => ({ status: "reference", receiptId }));
}
