/**
 * Context the user attached to a message: a selection, a page, a range, a slide, a picture. It is sent with the
 * message and kept with it in the local transcript, so later turns still see what the question was about.
 */
export interface MessageAttachment {
  /** What the user sees on the chip: "Selection", "example.com/pricing", "Sheet1!A1:D20". */
  title: string;
  /**
   * The text the model gets (Markdown by default). For a picture (`mediaType` `image/...`), its `data:` URL: the
   * model sees it, for a model that sees pictures.
   */
  content: string;
  /** Where it comes from: a context provider's id (`page`, `excel`). */
  source?: string;
  /** What it is: `selection`, `page`, `range`, `slide`, `document`. */
  kind?: string;
  /** An id the agent's context tools can read again, e.g. for the part after a truncated page. */
  reference?: string;
  mediaType?: string;
}

/** A picture: its content is a `data:` URL the model sees, not text. */
export function isPicture(a: { mediaType?: string | undefined }): boolean {
  return a.mediaType?.startsWith("image/") ?? false;
}

/** The picture types a gateway accepts (core 0.7.1 rc23): PNG, JPEG, WebP and GIF, judged by the data's first bytes. */
export type PictureType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** A picture that passed `checkPicture`: its real type and its data URL with that type in it. */
export interface CheckedPicture {
  ok: true;
  /** The type the bytes show, not the type the data URL claimed. */
  mediaType: PictureType;
  /** `data:<mediaType>;base64,...`. */
  dataUrl: string;
}

/** A picture that did not pass: `missing` (no data), or `type` (not a PNG, JPEG, WebP or GIF). */
export interface RefusedPicture {
  ok: false;
  reason: "missing" | "type";
}

/**
 * What type the first bytes of a picture show: PNG (89 50 4E 47 0D 0A 1A 0A), JPEG (FF D8 FF), GIF ("GIF87a" or "GIF89a") or WebP
 * ("RIFF" at 0-3 and "WEBP" at 8-11); undefined for anything else. The same judgement the gateway makes (`picture_type_not_allowed`).
 * .NET: `PictureData.TypeOf`.
 */
export function pictureTypeOf(bytes: Uint8Array): PictureType | undefined {
  const at = (i: number, ...values: number[]): boolean => values.every((v, k) => bytes[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

/**
 * Checks a picture's `data:` URL before anything is sent, by the data's first bytes and not by what the URL claims: no data is
 * `missing`, anything but a PNG, JPEG, WebP or GIF is `type`. A picture that passes comes back with the type its bytes show, and
 * its URL says that type (base64). OWASP ASVS 5.0 V5 (file handling: the content decides the type, not the declared one).
 * .NET: `PictureData.Check`.
 */
export function checkPicture(dataUrl: string): CheckedPicture | RefusedPicture {
  const match = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(dataUrl.trim());
  if (!match) return { ok: false, reason: dataUrl.trim() ? "type" : "missing" };
  const payload = match[3] ?? "";
  if (payload.length === 0) return { ok: false, reason: "missing" };
  let bytes: Uint8Array;
  let base64: string;
  try {
    if (match[2]) {
      base64 = payload.replace(/\s+/g, "");
      bytes = decodeBase64(base64.slice(0, 24)); // 18 bytes are plenty for every signature
    } else {
      bytes = percentDecode(payload);
      base64 = encodeBase64(bytes);
    }
  } catch {
    return { ok: false, reason: "type" };
  }
  if (bytes.length === 0) return { ok: false, reason: "missing" };
  const mediaType = pictureTypeOf(bytes);
  if (!mediaType) return { ok: false, reason: "type" };
  return { ok: true, mediaType, dataUrl: `data:${mediaType};base64,${base64}` };
}

function decodeBase64(text: string): Uint8Array {
  const whole = text.slice(0, text.length - (text.length % 4)); // atob wants whole groups of four
  return Uint8Array.from(atob(whole), (c) => c.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function percentDecode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x25 && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c < 0x100) out.push(c);
    else throw new TypeError("Not a byte.");
  }
  return Uint8Array.from(out);
}

/** The attachment as the transcript keeps it (snake_case, as in every SDK). */
export function attachmentData(a: MessageAttachment): Record<string, unknown> {
  const data: Record<string, unknown> = { title: a.title, content: a.content, media_type: a.mediaType ?? "text/markdown" };
  if (a.source !== undefined) data["source"] = a.source;
  if (a.kind !== undefined) data["kind"] = a.kind;
  if (a.reference !== undefined) data["reference"] = a.reference;
  return data;
}
