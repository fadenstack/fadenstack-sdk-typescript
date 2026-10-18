import { RECORD_ID } from "../content.js";
import { Carriers, type ContentMarker, type MarkableContent, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/** The front matter keys of a Markdown file with content made with AI. */
export const FRONT_MATTER_KEYS = { aiGenerated: "ai-generated", record: "ai-generated-record" } as const;

const BOM = String.fromCharCode(0xfeff);
const OURS = new RegExp(`^(?:${FRONT_MATTER_KEYS.aiGenerated}|${FRONT_MATTER_KEYS.record})\\s*:`);

interface FrontMatter {
  bom: string;
  newline: string;
  fields: string[];
  /** Everything after the closing line, exactly as it was. */
  body: string;
}

/** A Markdown text's YAML front matter (between `---` lines at its very start), or undefined when it has none. */
function frontMatterOf(text: string): FrontMatter | undefined {
  const bom = text.startsWith(BOM) ? BOM : "";
  const line = (from: number) => {
    const nl = text.indexOf("\n", from);
    return { text: text.slice(from, nl < 0 ? text.length : nl).replace(/\r$/, ""), end: nl < 0 ? text.length : nl + 1 };
  };
  const first = line(bom.length);
  if (first.text.trimEnd() !== "---") return undefined;
  const newline = text.slice(bom.length, first.end).endsWith("\r\n") ? "\r\n" : "\n";
  const fields: string[] = [];
  for (let at = first.end; at < text.length;) {
    const next = line(at);
    if (next.text.trimEnd() === "---" || next.text.trimEnd() === "...") return { bom, newline, fields, body: text.slice(next.end) };
    fields.push(next.text);
    at = next.end;
  }
  return undefined;
}

/**
 * `text` with `ai-generated: true` and the record's id in its front matter: merged into front matter it already has
 * (its other fields and the body stay as they were; an earlier mark of ours is replaced), or a new block at the start.
 */
export function withFrontMatter(text: string, recordId: string): string {
  const ours = [`${FRONT_MATTER_KEYS.aiGenerated}: true`, `${FRONT_MATTER_KEYS.record}: ${recordId}`];
  const existing = frontMatterOf(text);
  if (!existing) {
    const bom = text.startsWith(BOM) ? BOM : "";
    return `${bom}---\n${ours.join("\n")}\n---\n${text.slice(bom.length)}`;
  }
  const { bom, newline, fields, body } = existing;
  const kept = fields.filter((field) => !OURS.test(field));
  return `${bom}---${newline}${[...kept, ...ours].join(newline)}${newline}---${newline}${body}`;
}

/** `text` with `line` and a blank line first: after its front matter, which must stay at the very start. */
export function withLineAfterFrontMatter(text: string, line: string): string {
  const fm = frontMatterOf(text);
  if (!fm) return `${line}\n\n${text}`;
  return `${text.slice(0, text.length - fm.body.length)}${line}${fm.newline}${fm.newline}${fm.body}`;
}

/** What a Markdown text's front matter says: whether it is AI-generated, and the record's id if it names a valid one. */
export function frontMatterMark(text: string): { aiGenerated: boolean; recordId: string | undefined } | undefined {
  const fm = frontMatterOf(text);
  if (!fm) return undefined;
  const value = (key: string) => {
    const field = fm.fields.find((f) => new RegExp(`^${key}\\s*:`).test(f));
    return field?.slice(field.indexOf(":") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  };
  const flag = value(FRONT_MATTER_KEYS.aiGenerated);
  const id = value(FRONT_MATTER_KEYS.record);
  const recordId = id && RECORD_ID.test(id) ? id : undefined;
  if (flag !== "true" && !recordId) return undefined;
  return { aiGenerated: flag === "true" || recordId !== undefined, recordId };
}

/**
 * For whole Markdown files the agent writes: `ai-generated: true` and the record's id in YAML front matter, merged
 * into front matter the file already has. Nextcloud Text shows it as a metadata box and keeps it; it travels with a
 * download. The sink carries `front-matter` for a whole file, never for a snippet inserted into one.
 */
export class MarkdownFrontMatterMarker implements ContentMarker {
  readonly name = "markdown-front-matter";
  readonly layer = "metadata";

  supports(sink: SinkInfo, mediaType: string): boolean {
    return sink.carries.includes(Carriers.frontMatter) && mediaType.toLowerCase() === "text/markdown";
  }

  prepare(content: MarkableContent, record: ProvenanceRecord): MarkableContent {
    const text = typeof content.content === "string" ? content.content : new TextDecoder().decode(content.content);
    return { ...content, content: withFrontMatter(text, record.id) };
  }

  async attach(placed: PlacedContent, record: ProvenanceRecord): Promise<MarkOutcome> {
    const back = await placed.readBack();
    const text = back instanceof Uint8Array ? new TextDecoder().decode(back) : back;
    if (text === undefined) return { applied: true, method: "front-matter", verified: false };
    return frontMatterMark(text)?.recordId === record.id
      ? { applied: true, method: "front-matter" }
      : { applied: false, method: "front-matter", reason: "stripped-by-host" };
  }
}
