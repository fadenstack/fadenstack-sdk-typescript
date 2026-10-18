import { escapeHtml } from "./content.js";
import { MemoryBackend } from "./backend.js";
import { findPersonalData } from "./personalData.js";
import { placeContent } from "./pipeline.js";
import { ProvenanceReader, type FoundMark } from "./reader.js";
import { Carriers, type ContentMarker, type MarkableContent, type MarkOutcome, type Placement, type SinkInfo } from "./types.js";

/** What a marker wrote, as the test kit's sink kept it. */
export interface WrittenMarks {
  /** The content as the host got it, after the markers' `prepare`. */
  content: string | Uint8Array | undefined;
  readonly keyValues: Map<string, string>;
  readonly files: Map<string, string>;
  readonly headers: Map<string, string>;
}

export interface MemorySinkOptions {
  /** Default `test.sink`. */
  kind?: string;
  /** What it carries; every built-in carrier by default. */
  carries?: readonly string[];
  /** What the host holds after the insert; by default the content as it was given. */
  readBack?: (written: WrittenMarks) => string | Uint8Array | undefined;
}

/** The writes of the sinks `memorySink` made, so the test kit sees them. */
const WRITES = new WeakMap<SinkInfo, WrittenMarks>();

/** A sink that keeps everything in memory -- the content, key-value fields, sidecar files, headers -- all readable back. */
export function memorySink(options: MemorySinkOptions = {}): { sink: SinkInfo; written: WrittenMarks } {
  const written: WrittenMarks = { content: undefined, keyValues: new Map(), files: new Map(), headers: new Map() };
  const sink: SinkInfo = {
    kind: options.kind ?? "test.sink",
    container: true,
    carries: options.carries ?? Object.values(Carriers),
    keyValue: {
      write: (key, value) => void written.keyValues.set(key, value),
      read: (key) => written.keyValues.get(key),
    },
    sidecar: { fileName: "Reply.md", write: (name, text) => void written.files.set(name, text), read: (name) => written.files.get(name) },
    http: { setHeader: (name, value) => written.headers.set(name.toLowerCase(), value), getHeader: (name) => written.headers.get(name.toLowerCase()) },
    readBack: () => (options.readBack ? options.readBack(written) : written.content),
  };
  WRITES.set(sink, written);
  return { sink, written };
}

/** The test kit's content: a reply with personal data in it, which no mark may copy. */
export const FIXTURE = {
  name: "Erika Mustermann",
  email: "erika.mustermann@example.com",
  prompt: "Write a reply to Erika about the late delivery",
  html: "<p>Dear Erika Mustermann,</p><p>thank you for your message. The delivery for order 4711 arrives on Friday; "
    + "if anything is missing, write to erika.mustermann@example.com or call +49 30 1234567. Payments go to "
    + "DE89 3704 0044 0532 0130 00.</p><p>Kind regards</p>",
} as const;

export interface MarkerCheckOptions {
  /**
   * Where the content goes: a `memorySink` (whose writes the kit reads), or your host's own (then `read` reads the
   * marks). By default a memory sink carrying `carries`, or every built-in carrier.
   */
  sink?: SinkInfo;
  carries?: readonly string[];
  /** The content; by default `FIXTURE.html`, which has personal data a mark must not copy. */
  content?: string | Uint8Array;
  /** Its media type; `text/html` by default. */
  mediaType?: string;
  /** Values no mark may hold, besides mail addresses, phone numbers and IBANs; `FIXTURE`'s by default. */
  personalData?: readonly string[];
  /** The host's insert; by default the memory sink keeps the content. */
  insert?: (marked: MarkableContent) => unknown;
  /** Reads the marks back for a host the kit's reader cannot read (your marker's own place): their record ids. */
  read?: (written: WrittenMarks) => readonly FoundMark[] | Promise<readonly FoundMark[]>;
}

export interface MarkerCheckResult {
  /** True when the marker applied its mark, it reads back, and it holds no personal data. */
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly outcome: MarkOutcome | undefined;
  readonly placement: Placement<unknown> | undefined;
  readonly recordId: string | undefined;
  readonly written: WrittenMarks;
  readonly found: readonly FoundMark[];
}

/** The methods of the outcomes the pipeline reports itself, which are no marker's. */
const PIPELINE_METHODS = new Set(["host", "signed-record", "record"]);

/**
 * Runs a marker through `place()` with a backend in memory, and checks what it did: that it applied its mark, that the
 * mark reads back with the record's id (by `ProvenanceReader`, or `read` for a host only you can read), and that
 * nothing it wrote -- added to the content, into fields, files or headers -- holds personal data. A marker that
 * throws fails the check.
 */
export async function checkMarker(marker: ContentMarker, options: MarkerCheckOptions = {}): Promise<MarkerCheckResult> {
  const sink = options.sink ?? memorySink(options.carries ? { carries: options.carries } : {}).sink;
  const written: WrittenMarks = WRITES.get(sink) ?? { content: undefined, keyValues: new Map(), files: new Map(), headers: new Map() };
  const content = options.content ?? FIXTURE.html;
  const mediaType = options.mediaType ?? "text/html";
  const problems: string[] = [];
  if (!marker.supports(sink, mediaType)) problems.push(`'${marker.name}' does not support the sink '${sink.kind}' for ${mediaType}.`);
  // Every text is marked here, however short, and the label marker runs as it would with the policy's label on.
  const backend = new MemoryBackend({ short_text_tokens: 0, ...(marker.layer === "label" ? { visible_label: true } : {}) });
  const records: string[] = [];
  const entries: Record<string, unknown>[] = [];
  let placement: Placement<unknown> | undefined;
  try {
    placement = await placeContent({
      markers: [marker], policyLabels: [], classifier: undefined, enrichers: [], observers: [], tokenizer: undefined, development: true,
    }, { content, mediaType, sink }, (marked) => {
      written.content = marked.content;
      return options.insert?.(marked);
    }, {
      tool: "test_tool",
      callId: "call-1",
      receipt: { status: "signed", signature: "a.b.c", receipt: {
        id: "00000000-0000-4000-8000-000000000001", kind: "text", model: { id: "test-model" }, created_at: new Date().toISOString(),
        watermark: { applied: "model", algorithm: "gumbel" }, output_hash: "0".repeat(64), hash_key_version: 1,
      } },
      signal: AbortSignal.timeout(30_000),
      policy: () => backend.policy(),
      backend,
      record: async (_type, data) => {
        records.push(JSON.stringify(data));
        entries.push(data);
      },
    });
  } catch (error) {
    problems.push(`place() failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The marker's own outcome, not what the pipeline adds (the server's record, a host that carries nothing, the watermark).
  const layers = (entries[0]?.["layers"] ?? []) as { layer: string; method: string; applied: boolean; reason: string | null; verified: boolean | null; detail: string | null }[];
  const own = layers.find((l) => l.layer === marker.layer && !PIPELINE_METHODS.has(l.method)
    && !(l.layer === "watermark" && marker.layer !== "watermark"));
  const outcome: MarkOutcome | undefined = own ? {
    applied: own.applied, method: own.method,
    ...(own.reason ? { reason: own.reason as NonNullable<MarkOutcome["reason"]> } : {}),
    ...(own.verified !== null ? { verified: own.verified } : {}),
  } : undefined;
  if (placement?.exempt) problems.push(`The content needs no mark (${placement.exemptBecause}): give the kit longer content.`);
  else if (own?.detail?.startsWith("failed:")) problems.push(`'${marker.name}' ${own.detail}.`);
  else if (placement && !outcome) problems.push(`'${marker.name}' reported nothing.`);
  else if (outcome && !outcome.applied) problems.push(`'${marker.name}' did not apply its mark (${outcome.reason ?? "no reason"}).`);

  const recordId = placement?.recordId;
  const reader = new ProvenanceReader();
  const found = options.read ? [...(await options.read(written))] : [
    ...(written.content !== undefined ? reader.read(written.content, mediaTypeOf(written.content, mediaType)) : []),
    ...[...written.keyValues.values()].flatMap((v) => reader.fromKeyValue(v)),
    ...[...written.files.values()].flatMap((v) => reader.fromSidecar(v)),
    ...[...written.headers.values()].flatMap((v) => reader.fromHeader(v)),
  ];
  if (recordId && marker.layer === "metadata" && !found.some((m) => m.recordId === recordId)) {
    problems.push(`The record's id did not read back from what '${marker.name}' wrote${options.read ? "" : "; pass `read` for a host only you can read"}.`);
  }

  const known = options.personalData ?? [FIXTURE.name, FIXTURE.email, FIXTURE.prompt];
  for (const [where, text] of addedTexts(content, written)) {
    for (const finding of findPersonalData(text, known)) problems.push(`'${marker.name}' wrote personal data (${finding.kind}) into ${where}.`);
  }
  for (const entry of records) {
    for (const finding of findPersonalData(entry, known)) problems.push(`The placement's record holds personal data (${finding.kind}).`);
  }
  return Object.freeze({ ok: problems.length === 0, problems, outcome, placement, recordId, written, found });
}

/** What the marker added, by where it went: the content without the original in it, and every field, file and header. */
function addedTexts(original: string | Uint8Array, written: WrittenMarks): [string, string][] {
  const texts: [string, string][] = [];
  const marked = written.content;
  if (typeof marked === "string" && typeof original === "string") {
    const variant = [original, escapeHtml(original).replace(/\r?\n/g, "<br>"), escapeHtml(original)].find((v) => marked.includes(v));
    // Content changed beyond wrapping: its attributes and comments are what a mark could have added.
    texts.push(["the content", variant !== undefined ? marked.replace(variant, " ") : attributesAndComments(marked)]);
  }
  for (const [key, value] of written.keyValues) texts.push([`the field '${key}'`, value]);
  for (const [name, text] of written.files) texts.push([`the file '${name}'`, text]);
  for (const [name, value] of written.headers) texts.push([`the header '${name}'`, value]);
  return texts;
}

function attributesAndComments(html: string): string {
  return [...html.matchAll(/=\s*("[^"]*"|'[^']*')|<!--([\s\S]*?)-->/g)].map((m) => m[1] ?? m[2] ?? "").join(" ");
}

function mediaTypeOf(content: string | Uint8Array, fallback: string): string {
  return typeof content === "string" && content.trimStart().startsWith("<") ? "text/html" : fallback;
}
