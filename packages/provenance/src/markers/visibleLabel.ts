import { bareType, escapeAttribute, escapeHtml, newlineOf } from "../content.js";
import { resolveStrings, type MarkStringsOption } from "../titles.js";
import type { ContentMarker, MarkableContent, MarkOutcome, PlacedContent, ProvenanceRecord } from "../types.js";
import { withLineAfterFrontMatter } from "./markdownFrontMatter.js";

/** The attribute an HTML label carries the record's id in. */
export const AI_LABEL_ATTRIBUTE = "data-ai-label";

export interface VisibleLabelMarkerOptions {
  /** The label's text, in the user's language: the host's UI strings, or a function of them. */
  strings?: MarkStringsOption;
  /**
   * For HTML: an icon before the label -- an image's URL, or SVG markup the deployer chose (such as the EU's "AI"
   * icon). None by default.
   */
  icon?: string;
}

/**
 * A visible "AI-generated" label on content, where the deployer chose one (the policy's `visible_label`, or added by
 * the integrator as a marker): before HTML `<p data-ai-label="<record id>">label</p>`, before Markdown `*label*` and a
 * blank line (after its front matter), before plain text the label and a blank line. A complement to the
 * machine-readable marks, never in their place. Off by default.
 */
export class VisibleLabelMarker implements ContentMarker {
  readonly name = "visible-label";
  readonly layer = "label";
  readonly #strings: MarkStringsOption | undefined;
  readonly #icon: string | undefined;

  constructor(options: VisibleLabelMarkerOptions = {}) {
    this.#strings = options.strings;
    this.#icon = options.icon;
  }

  supports(_sink: unknown, mediaType: string): boolean {
    return ["text/html", "text/markdown", "text/plain"].includes(bareType(mediaType));
  }

  prepare(content: MarkableContent, record: ProvenanceRecord): MarkableContent {
    const label = resolveStrings(this.#strings).aiGenerated;
    const text = typeof content.content === "string" ? content.content : new TextDecoder().decode(content.content);
    const newline = newlineOf(text);
    switch (bareType(content.mediaType)) {
      case "text/html": {
        const icon = !this.#icon ? "" : this.#icon.trim().startsWith("<svg")
          ? this.#icon.trim()
          : `<img src="${escapeAttribute(this.#icon)}" alt="" width="16" height="16"> `;
        return { ...content, content: `<p ${AI_LABEL_ATTRIBUTE}="${escapeAttribute(record.id)}">${icon}${escapeHtml(label)}</p>${text}` };
      }
      case "text/markdown":
        return { ...content, content: withLineAfterFrontMatter(text, `*${label}*`) };
      default:
        return { ...content, content: `${label}${newline}${newline}${text}` };
    }
  }

  async attach(placed: PlacedContent): Promise<MarkOutcome> {
    const back = await placed.readBack();
    const text = back instanceof Uint8Array ? new TextDecoder().decode(back) : back;
    if (text === undefined) return { applied: true, method: this.name, verified: false, detail: "not read back" };
    const label = resolveStrings(this.#strings).aiGenerated;
    return text.includes(label) || text.includes(escapeHtml(label))
      ? { applied: true, method: this.name, verified: true }
      : { applied: false, method: this.name, reason: "stripped-by-host" };
  }
}
