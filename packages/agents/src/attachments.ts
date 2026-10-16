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

/** The attachment as the transcript keeps it (snake_case, as in every SDK). */
export function attachmentData(a: MessageAttachment): Record<string, unknown> {
  const data: Record<string, unknown> = { title: a.title, content: a.content, media_type: a.mediaType ?? "text/markdown" };
  if (a.source !== undefined) data["source"] = a.source;
  if (a.kind !== undefined) data["kind"] = a.kind;
  if (a.reference !== undefined) data["reference"] = a.reference;
  return data;
}
