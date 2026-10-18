import { RECORD_ID, decodeEntities, escapeAttribute, escapeHtml } from "../content.js";
import { recordIdInTitle, resolveStrings, titleTemplates, type MarkStringsOption, type TitleTemplate } from "../titles.js";
import { Carriers, type ContentMarker, type MarkableContent, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/** The attribute that names the record, on the element around content made with AI. */
export const AI_GENERATED_ATTRIBUTE = "data-ai-generated";

const BLOCK = /<(?:p|div|ul|ol|li|table|h[1-6]|blockquote|pre|section|article|figure|hr|dl)\b/i;
const START_TAG = /<[a-zA-Z][^\s/>]*((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The record ids an HTML text's marks name: in `data-ai-generated` attributes, and in titles of ours. */
export function htmlRecordIds(html: string, templates: readonly TitleTemplate[] = titleTemplates()): { attribute: Set<string>; title: Set<string> } {
  const attribute = new Set<string>();
  const title = new Set<string>();
  for (const tag of html.matchAll(START_TAG)) {
    for (const a of (tag[1] ?? "").matchAll(ATTRIBUTE)) {
      const name = a[1]!.toLowerCase();
      const value = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "").trim();
      if (name === AI_GENERATED_ATTRIBUTE && RECORD_ID.test(value)) attribute.add(value);
      else if (name === "title") {
        const id = recordIdInTitle(value, templates);
        if (id) title.add(id);
      }
    }
  }
  return { attribute, title };
}

export interface HtmlAttributeMarkerOptions {
  /** The title's text, in the user's language: the host's UI strings (`stringsFor(language)`), or a function of them. */
  strings?: MarkStringsOption;
}

/**
 * For HTML hosts (web editors, mail): wraps the content in an element with `data-ai-generated` (the record's id),
 * which TinyMCE and CKEditor 5 keep, and a `title` saying it is AI-generated with the record's id, which Gmail keeps
 * through to the recipient. The sink says which it carries (`html-attribute`, `html-title`). After the insert it reads
 * the host's HTML back (`SinkInfo.readBack`) and records which held. Plain text is escaped into HTML.
 */
export class HtmlAttributeMarker implements ContentMarker {
  readonly name = "html-attribute";
  readonly layer = "metadata";
  readonly #strings: MarkStringsOption | undefined;

  constructor(options: HtmlAttributeMarkerOptions = {}) {
    this.#strings = options.strings;
  }

  supports(sink: SinkInfo, mediaType: string): boolean {
    const type = mediaType.toLowerCase();
    return (sink.carries.includes(Carriers.htmlAttribute) || sink.carries.includes(Carriers.htmlTitle))
      && (type === "text/html" || type === "text/plain");
  }

  prepare(content: MarkableContent, record: ProvenanceRecord): MarkableContent {
    const text = typeof content.content === "string" ? content.content : new TextDecoder().decode(content.content);
    const html = content.mediaType.toLowerCase() === "text/html" ? text : escapeHtml(text).replace(/\r?\n/g, "<br>");
    const attributes: string[] = [];
    if (content.sink.carries.includes(Carriers.htmlAttribute)) attributes.push(`${AI_GENERATED_ATTRIBUTE}="${escapeAttribute(record.id)}"`);
    if (content.sink.carries.includes(Carriers.htmlTitle)) {
      attributes.push(`title="${escapeAttribute(resolveStrings(this.#strings).aiGeneratedTitle(record.id))}"`);
    }
    const tag = BLOCK.test(html) ? "div" : "span";
    return { content: `<${tag} ${attributes.join(" ")}>${html}</${tag}>`, mediaType: "text/html", sink: content.sink };
  }

  async attach(placed: PlacedContent, record: ProvenanceRecord): Promise<MarkOutcome> {
    const wrote = methodOf(placed.sink.carries.includes(Carriers.htmlAttribute), placed.sink.carries.includes(Carriers.htmlTitle));
    const back = await placed.readBack();
    if (typeof back !== "string") return { applied: true, method: wrote, verified: false };
    // The host's own texts, and every built-in language's: a host may keep a title written in another language.
    const held = htmlRecordIds(back, [...titleTemplates([resolveStrings(this.#strings)]), ...titleTemplates()]);
    const attribute = held.attribute.has(record.id);
    const title = held.title.has(record.id);
    if (!attribute && !title) return { applied: false, method: wrote, reason: "stripped-by-host" };
    return { applied: true, method: methodOf(attribute, title) };
  }
}

function methodOf(attribute: boolean, title: boolean): string {
  return attribute && title ? "html-attribute+title" : attribute ? "html-attribute" : "html-title";
}
