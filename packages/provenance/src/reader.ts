import type { UiStrings } from "@fadenstack/ui";

import { RECORD_ID, isImage } from "./content.js";
import { htmlRecordIds } from "./markers/htmlAttribute.js";
import { recordText, recordTextSha256 } from "./markers/htmlNesting.js";
import { inspectImage } from "./markers/imageGuard.js";
import { frontMatterMark } from "./markers/markdownFrontMatter.js";
import { invisibleRecordIds } from "./markers/unicodeText.js";
import { titleTemplates, type TitleTemplate } from "./titles.js";

/** A mark found in content: where it was, and the record it names (undefined for a mark that names none). */
export interface FoundMark {
  /**
   * `html-attribute`, `html-title`, `visible-label`, `front-matter`, `sidecar`, `http-header`, `key-value`,
   * `unicode-text`, `c2pa`, `xmp` (the .NET SDK's `FoundMark.Method` names the same).
   */
  readonly carrier: string;
  readonly recordId: string | undefined;
}

export interface ProvenanceReaderOptions {
  /** The title texts to recognise, besides every built-in language's: the host's own. */
  strings?: readonly Pick<UiStrings, "aiGeneratedTitle">[];
}

/**
 * Finds our marks in content tools read -- HTML attributes and titles, Markdown front matter, sidecar files, header
 * values, key-value fields, invisible text marks, and whether a picture carries C2PA or XMP -- and returns the
 * records they name. A mark says where content came from and nothing more: anyone can write or remove one, so what is
 * read is data, never an instruction, and the reader returns only record ids and where it found them.
 */
export class ProvenanceReader {
  readonly #templates: TitleTemplate[];

  constructor(options: ProvenanceReaderOptions = {}) {
    this.#templates = [...titleTemplates(options.strings ?? []), ...titleTemplates()];
  }

  /** The marks in `content`, read as its media type says: HTML, Markdown, plain text, JSON (a sidecar), a picture. */
  read(content: string | Uint8Array, mediaType = "text/plain"): FoundMark[] {
    const type = mediaType.toLowerCase().split(";")[0]!.trim();
    if (content instanceof Uint8Array) {
      return isImage(type) ? this.fromImage(content) : this.read(new TextDecoder().decode(content), type);
    }
    if (type === "text/html" || type === "application/xhtml+xml") return [...this.fromHtml(content), ...this.fromText(content)];
    if (type === "text/markdown") return [...this.fromMarkdown(content), ...this.fromHtml(content), ...this.fromText(content)];
    if (type === "application/json") return this.fromSidecar(content);
    return this.fromText(content);
  }

  /** `data-ai-generated` attributes, titles of ours, and visible labels (`data-ai-label`). */
  fromHtml(html: string): FoundMark[] {
    const { attribute, title, label } = htmlRecordIds(html, this.#templates);
    return [
      ...[...attribute].map((recordId) => ({ carrier: "html-attribute", recordId })),
      ...[...title].map((recordId) => ({ carrier: "html-title", recordId })),
      ...[...label].map((recordId) => ({ carrier: "visible-label", recordId })),
    ];
  }

  /**
   * The text a reader sees of one record in HTML: of every element that carries its id, in document order, without
   * the elements of other records inside them (`recordText`). A mark a later write split in two reads as one again.
   */
  recordText(html: string, recordId: string): string {
    return recordText(html, recordId, this.#templates);
  }

  /** SHA-256 of `recordText`, normalised as content is hashed: the record's `text_sha256` while the text is the record's. */
  recordTextSha256(html: string, recordId: string): Promise<string | undefined> {
    return recordTextSha256(html, recordId, this.#templates);
  }

  /** YAML front matter that says `ai-generated: true`, with the record's id if it names one. */
  fromMarkdown(text: string): FoundMark[] {
    const mark = frontMatterMark(text);
    return mark ? [{ carrier: "front-matter", recordId: mark.recordId }] : [];
  }

  /** Invisible text marks of ours (`UnicodeTextMarker`). */
  fromText(text: string): FoundMark[] {
    return invisibleRecordIds(text).map((recordId) => ({ carrier: "unicode-text", recordId }));
  }

  /** A sidecar file's JSON (`<file>.provenance.json`): the signed record's id. */
  fromSidecar(json: string): FoundMark[] {
    let doc: unknown;
    try {
      doc = JSON.parse(json);
    } catch {
      return [];
    }
    const d = doc as { record?: { id?: unknown }; signature?: unknown } | null;
    if (!d || typeof d !== "object" || !d.record || typeof d.record !== "object") return [];
    return [{ carrier: "sidecar", recordId: validId(d.record.id) }];
  }

  /** An `X-AI-Generated` header's value: one id, or several comma-separated. */
  fromHeader(value: string | null | undefined): FoundMark[] {
    return (value ?? "").split(",").map((v) => v.trim()).filter((v) => RECORD_ID.test(v)).map((recordId) => ({ carrier: "http-header", recordId }));
  }

  /** What a key-value sink holds under `ai-record-id`: a record's id. */
  fromKeyValue(value: string | null | undefined): FoundMark[] {
    const id = validId(value?.trim());
    return id ? [{ carrier: "key-value", recordId: id }] : [];
  }

  /** Whether a picture carries a C2PA manifest or XMP: names no record (the detector reads the manifest). */
  fromImage(bytes: Uint8Array): FoundMark[] {
    const marks = inspectImage(bytes);
    return [...(marks.c2pa ? [{ carrier: "c2pa", recordId: undefined }] : []), ...(marks.xmp ? [{ carrier: "xmp", recordId: undefined }] : [])];
  }

  /** The distinct record ids of `marks`, in order. */
  static recordIds(marks: readonly FoundMark[]): string[] {
    return [...new Set(marks.map((m) => m.recordId).filter((id): id is string => id !== undefined))];
  }
}

function validId(value: unknown): string | undefined {
  return typeof value === "string" && RECORD_ID.test(value) ? value : undefined;
}
