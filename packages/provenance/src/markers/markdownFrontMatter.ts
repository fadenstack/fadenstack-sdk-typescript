import { RECORD_ID, bareType, newlineOf } from "../content.js";
import { Carriers, type ContentMarker, type MarkableContent, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/**
 * The keys of a mark in YAML front matter and in a key-value sink (`KeyValueMarker`): `ai-generated: true` and
 * `ai-record-id: "<record id>"`. The .NET SDK and the host agents write the same.
 */
export const FRONT_MATTER_KEYS = { aiGenerated: "ai-generated", record: "ai-record-id" } as const;

const BOM = String.fromCharCode(0xfeff);

interface FrontMatter {
  /** The lines between the opening `---` and the closing line. */
  lines: string[];
  /** The closing line (`---` or `...`) with its line break, exactly as it was. */
  close: string;
  /** Everything after the closing line, exactly as it was. */
  rest: string;
}

/** YAML front matter at the very start of a Markdown text (after a BOM): `---`, the lines, `---` or `...`; else undefined. */
function frontMatterOf(text: string): FrontMatter | undefined {
  const first = text.indexOf("\n");
  if (first < 0 || text.slice(0, first).replace(/\r$/, "") !== "---") return undefined;
  const lines: string[] = [];
  for (let at = first + 1; at < text.length;) {
    const end = text.indexOf("\n", at);
    const next = end < 0 ? text.length : end + 1;
    const line = text.slice(at, end < 0 ? text.length : end).replace(/\r$/, "");
    if (line === "---" || line === "...") return { lines, close: text.slice(at, next), rest: text.slice(next) };
    lines.push(line);
    at = next;
  }
  return undefined; // never closed: not front matter
}

const isKey = (line: string, key: string) => line.startsWith(`${key}:`);

/**
 * `text` with `ai-generated: true` and `ai-record-id: "<id>"` in its front matter: added after the fields of front
 * matter it already has (an earlier mark of ours is replaced; the other fields, the closing line and the body stay
 * byte for byte), or new front matter and a blank line before it. The text's own line breaks (CRLF when it has any).
 */
export function withFrontMatter(text: string, recordId: string): string {
  const newline = newlineOf(text);
  const bom = text.startsWith(BOM) ? BOM : "";
  const body = text.slice(bom.length);
  const ours = [`${FRONT_MATTER_KEYS.aiGenerated}: true`, `${FRONT_MATTER_KEYS.record}: "${recordId}"`];
  const existing = frontMatterOf(body);
  if (existing) {
    const kept = existing.lines.filter((l) => !isKey(l, FRONT_MATTER_KEYS.aiGenerated) && !isKey(l, FRONT_MATTER_KEYS.record));
    return `${bom}---${newline}${[...kept, ...ours].join(newline)}${newline}${existing.close}${existing.rest}`;
  }
  return `${bom}---${newline}${ours.join(newline)}${newline}---${newline}${newline}${body}`;
}

/** `text` with `line` and a blank line first: after its front matter, which must stay at the very start. */
export function withLineAfterFrontMatter(text: string, line: string): string {
  const newline = newlineOf(text);
  const fm = frontMatterOf(text.startsWith(BOM) ? text.slice(1) : text);
  if (!fm) return `${line}${newline}${newline}${text}`;
  const head = text.slice(0, text.length - fm.rest.length);
  return `${head}${line}${newline}${newline}${fm.rest.replace(/^[\r\n]+/, "")}`;
}

/** What a Markdown text's front matter says: whether it is AI-generated, and the record's id if it names a valid one. */
export function frontMatterMark(text: string): { aiGenerated: boolean; recordId: string | undefined } | undefined {
  const fm = frontMatterOf(text.startsWith(BOM) ? text.slice(1) : text);
  if (!fm) return undefined;
  const value = (key: string) => {
    const line = fm.lines.find((l) => isKey(l, key));
    return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  };
  if (value(FRONT_MATTER_KEYS.aiGenerated)?.toLowerCase() !== "true") return undefined;
  const id = value(FRONT_MATTER_KEYS.record)?.trim();
  return { aiGenerated: true, recordId: id && RECORD_ID.test(id) ? id : undefined };
}

/**
 * For whole Markdown files the agent writes: `ai-generated: true` and `ai-record-id` in YAML front matter, merged into
 * front matter the file already has (`withFrontMatter`). Nextcloud Text shows it as a metadata box and keeps it; it
 * travels with a download. The sink carries `front-matter` for a whole file, never for a snippet inserted into one.
 */
export class MarkdownFrontMatterMarker implements ContentMarker {
  readonly name = "front-matter";
  readonly layer = "metadata";

  supports(sink: SinkInfo, mediaType: string): boolean {
    return sink.carries.includes(Carriers.frontMatter) && bareType(mediaType) === "text/markdown";
  }

  prepare(content: MarkableContent, record: ProvenanceRecord): MarkableContent {
    const text = typeof content.content === "string" ? content.content : new TextDecoder().decode(content.content);
    return { ...content, content: withFrontMatter(text, record.id) };
  }

  async attach(placed: PlacedContent, record: ProvenanceRecord): Promise<MarkOutcome> {
    const back = await placed.readBack();
    const text = back instanceof Uint8Array ? new TextDecoder().decode(back) : back;
    if (text === undefined) return { applied: true, method: this.name, verified: false, detail: "not read back" };
    return frontMatterMark(text)?.recordId === record.id
      ? { applied: true, method: this.name, verified: true }
      : { applied: false, method: this.name, reason: "stripped-by-host" };
  }
}
