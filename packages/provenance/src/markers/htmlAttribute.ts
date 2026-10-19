import { RECORD_ID, bareType, decodeEntities, escapeAttribute } from "../content.js";
import { recordIdInTitle, resolveStrings, titleTemplates, type MarkStringsOption, type TitleTemplate } from "../titles.js";
import { Carriers, type ContentMarker, type MarkableContent, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/** The attribute that names the record, on the element around content made with AI. */
export const AI_GENERATED_ATTRIBUTE = "data-ai-generated";

/** HTML with any of these is wrapped in a `div`; anything else in a `span`. */
const BLOCK = /<(?:p|div|ul|ol|li|table|h[1-6]|blockquote|pre|section|article|header|footer|figure|hr|dl)\b/i;
/** HTML that is one paragraph: `<p ...>`, its inline content, `</p>`, white space around it. */
const ONE_PARAGRAPH = /^([ \t\r\n\f]*)<p((?:[ \t\r\n\f][^>]*)?)>([\s\S]*)<\/p>([ \t\r\n\f]*)$/i;
const PARAGRAPH_END = /<\/p[ \t\r\n\f>]/i;
const START_TAG = /<[a-zA-Z][^\s/>]*((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/** The attribute a visible label names its record in (`VisibleLabelMarker`). */
const LABEL_ATTRIBUTE = "data-ai-label";

/** An attribute of a start tag: its name in lower case, its value decoded and trimmed, and the attribute as written. */
export interface TagAttribute {
  readonly name: string;
  readonly value: string;
  readonly written: string;
}

/** The attributes in a start tag's attribute text (what follows its name). */
export function tagAttributes(text: string): TagAttribute[] {
  return [...text.matchAll(ATTRIBUTE)].map((a) => ({ name: a[1]!.toLowerCase(), value: decodeEntities(a[2] ?? a[3] ?? a[4] ?? "").trim(), written: a[0] }));
}

/**
 * The record whose text an element with these attributes holds: the record its `data-ai-generated` names, else the
 * one a title of ours names; `null` for a visible label (`data-ai-label`), which holds no record's text; undefined
 * for any other element.
 */
export function markOf(attributes: Iterable<{ readonly name: string; readonly value: string }>, templates: readonly TitleTemplate[]): string | null | undefined {
  let title: string | undefined;
  let label = false;
  for (const { name, value } of attributes) {
    if (name === AI_GENERATED_ATTRIBUTE && RECORD_ID.test(value)) return value;
    if (name === LABEL_ATTRIBUTE && RECORD_ID.test(value)) label = true;
    else if (name === "title") title ??= recordIdInTitle(value, templates);
  }
  return label ? null : title;
}

/**
 * The record ids an HTML text's marks name: in `data-ai-generated` attributes, in titles of ours, and in the
 * `data-ai-label` of a visible label.
 */
export function htmlRecordIds(
  html: string,
  templates: readonly TitleTemplate[] = titleTemplates(),
): { attribute: Set<string>; title: Set<string>; label: Set<string> } {
  const attribute = new Set<string>();
  const title = new Set<string>();
  const label = new Set<string>();
  for (const tag of html.matchAll(START_TAG)) {
    for (const { name, value } of tagAttributes(tag[1] ?? "")) {
      if (name === AI_GENERATED_ATTRIBUTE && RECORD_ID.test(value)) attribute.add(value);
      else if (name === LABEL_ATTRIBUTE && RECORD_ID.test(value)) label.add(value);
      else if (name === "title") {
        const id = recordIdInTitle(value, templates);
        if (id) title.add(id);
      }
    }
  }
  return { attribute, title, label };
}

/**
 * The element a mark wraps HTML in: `<span data-ai-generated="<id>" title="<label> <id>">`, the attribute values
 * escaped for `&`, `<`, `>` and `"` only. Content that is one paragraph is marked inside it,
 * `<p ...><span ...>...</span></p>` (the form the lab measured in real editors); a `div` goes around several
 * blocks; inline content gets the `span`. The .NET SDK writes the same.
 */
export function wrapHtml(html: string, recordId: string, title: string): string {
  const attributes = `${AI_GENERATED_ATTRIBUTE}="${escapeAttribute(recordId)}" title="${escapeAttribute(title)}"`;
  const paragraph = ONE_PARAGRAPH.exec(html);
  if (paragraph && !BLOCK.test(paragraph[3]!) && !PARAGRAPH_END.test(paragraph[3]!)) {
    return `${paragraph[1]}<p${paragraph[2]}><span ${attributes}>${paragraph[3]}</span></p>${paragraph[4]}`;
  }
  const tag = BLOCK.test(html) ? "div" : "span";
  return `<${tag} ${attributes}>${html}</${tag}>`;
}

export interface HtmlAttributeMarkerOptions {
  /** The title's text, in the user's language: the host's UI strings (`stringsFor(language)`), or a function of them. */
  strings?: MarkStringsOption;
}

/**
 * For HTML hosts (web editors, mail): wraps the HTML in one element with `data-ai-generated` (the record's id), which
 * TinyMCE and CKEditor 5 keep, and a `title` -- "AI-generated" in the user's language, a space, the record's id --
 * which Gmail keeps through to the recipient (`wrapHtml`). For `text/html` into a sink that carries `html-attribute`
 * or `html-title`; a tool that has plain text escapes it into HTML first. After the insert it reads the host's HTML
 * back (`SinkInfo.readBack`) and records which held: method `html-attribute` when the attribute did, `html-title`
 * when only the title did.
 */
export class HtmlAttributeMarker implements ContentMarker {
  readonly name = "html-attribute";
  readonly layer = "metadata";
  readonly #strings: MarkStringsOption | undefined;

  constructor(options: HtmlAttributeMarkerOptions = {}) {
    this.#strings = options.strings;
  }

  supports(sink: SinkInfo, mediaType: string): boolean {
    return (sink.carries.includes(Carriers.htmlAttribute) || sink.carries.includes(Carriers.htmlTitle)) && bareType(mediaType) === "text/html";
  }

  prepare(content: MarkableContent, record: ProvenanceRecord): MarkableContent {
    const html = typeof content.content === "string" ? content.content : new TextDecoder().decode(content.content);
    return { ...content, content: wrapHtml(html, record.id, resolveStrings(this.#strings).aiGeneratedTitle(record.id)) };
  }

  async attach(placed: PlacedContent, record: ProvenanceRecord): Promise<MarkOutcome> {
    const back = await placed.readBack();
    const html = back instanceof Uint8Array ? new TextDecoder().decode(back) : back;
    if (html === undefined) return { applied: true, method: this.name, verified: false, detail: "not read back" };
    // The host's own texts, and every built-in language's: a host may keep a title written in another language.
    const held = htmlRecordIds(html, [...titleTemplates([resolveStrings(this.#strings)]), ...titleTemplates()]);
    const attribute = held.attribute.has(record.id);
    const title = held.title.has(record.id);
    if (attribute) {
      return { applied: true, method: this.name, verified: true, detail: title ? "data-ai-generated, title" : "data-ai-generated; title dropped" };
    }
    return title
      ? { applied: true, method: "html-title", verified: true, detail: "title; data-ai-generated dropped" }
      : { applied: false, method: this.name, reason: "stripped-by-host", detail: "data-ai-generated and title dropped" };
  }
}
