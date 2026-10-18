import type {
  EditKind,
  LayerOutcome,
  MarkLayer,
  PlacementReport,
  ProvenancePolicy,
  ReasonCode,
  ReceiptNote,
  RecordRequest,
  SignedRecord,
  WatermarkStatus as ReceiptWatermark,
} from "@fadenstack/client";

/**
 * What a host keeps besides the content, as the built-in markers name it in `SinkInfo.carries`. A marker of your own
 * may name its own (`crm-field`).
 */
export const Carriers = {
  /** A `data-ai-generated` attribute on an element (TinyMCE and CKEditor 5 keep it). */
  htmlAttribute: "html-attribute",
  /** A `title` attribute (Gmail keeps it, through to the recipient). */
  htmlTitle: "html-title",
  /** The YAML front matter of a whole Markdown file. */
  frontMatter: "front-matter",
  /** One string the host keeps with the content, such as a hidden field: `SinkInfo.keyValue`. */
  keyValue: "key-value",
  /** A file beside the file: `SinkInfo.sidecar`. */
  sidecar: "sidecar",
  /** A response header, for content served over HTTP: `SinkInfo.http`. */
  httpHeader: "http-header",
  /** Invisible characters in plain text that the host keeps (opt-in: `UnicodeTextMarker`). */
  unicodeText: "unicode-text",
} as const;

/** One place to keep a string for the content: a hidden CRM field, a ticket's custom field, an object's metadata. */
export interface KeyValueSink {
  write(key: string, value: string): void | Promise<void>;
  read(key: string): string | undefined | null | Promise<string | undefined | null>;
  /** The longest value the host keeps. The signed record goes in only where it fits; the record's id otherwise. */
  readonly maxLength?: number;
}

/** Files beside the file the content went into, for `SidecarMarker`. */
export interface SidecarSink {
  /** The name of the file the content was written to (the name only), which names the sidecar: `<name>.provenance.json`. */
  readonly fileName: string;
  write(name: string, text: string): void | Promise<void>;
  read?(name: string): string | undefined | null | Promise<string | undefined | null>;
}

/** A response being served, for `HttpHeaderMarker`: Node's `ServerResponse` fits. */
export interface HttpHeaderSink {
  setHeader(name: string, value: string): unknown;
  getHeader?(name: string): string | number | readonly string[] | undefined | null;
}

/**
 * A place content lands, described once by the integrator: what it is, and what it can carry besides the content.
 * Never the name of a document, a mailbox or a user: the kind is reported to the server.
 */
export interface SinkInfo {
  /** What the place is: `html.editor`, `crm.note`, `nextcloud.file`, `word.range`. */
  readonly kind: string;
  /**
   * Whether the host holds structured content that carries metadata (a document, an editor's HTML, a file), so the
   * content needs a mark of its own besides the watermark. Default: whether it carries anything.
   */
  readonly container?: boolean;
  /** What it keeps besides the content: `Carriers` values, or your own markers' names for theirs. Empty: nothing. */
  readonly carries: readonly string[];
  readonly keyValue?: KeyValueSink;
  readonly sidecar?: SidecarSink;
  readonly http?: HttpHeaderSink;
  /**
   * What the host holds after the insert -- the editor's HTML, the file's text or bytes -- so markers can check
   * their mark held. Without it a mark is reported as written, not seen.
   */
  readBack?(signal: AbortSignal): string | Uint8Array | undefined | null | Promise<string | Uint8Array | undefined | null>;
}

/** Content on its way into a host: markers may change it in `prepare` (wrap it, add front matter). */
export interface MarkableContent {
  readonly content: string | Uint8Array;
  readonly mediaType: string;
  readonly sink: SinkInfo;
}

/** Content the host has taken. */
export interface PlacedContent extends MarkableContent {
  /** What the host's insert returned. */
  readonly result: unknown;
  /** What the host holds now (`SinkInfo.readBack`), read once per placement; undefined when it cannot be read. */
  readBack(): Promise<string | Uint8Array | undefined>;
}

/** What a marker says about its mark. */
export interface MarkOutcome {
  applied: boolean;
  /** How: `html-attribute`, `front-matter`, `crm-field`, ... */
  method: string;
  /** Why not, when it did not hold. */
  reason?: ReasonCode;
  /**
   * False for a mark written but not seen afterwards, because the sink cannot be read: it is reported as
   * `<method>:unverified`. A marker reports a mark as applied and verified only after reading it back.
   */
  verified?: boolean;
}

/**
 * Marks content in a host. `prepare` may change the content before it lands (wrap HTML in a marked element);
 * `attach` marks what landed (a field, a tag, a part) and says whether the mark held. A marker writes the record's id
 * and what the record holds -- never content, a user, a prompt or a document's name.
 */
export interface ContentMarker {
  readonly name: string;
  readonly layer: MarkLayer;
  /**
   * Whether it puts a mark in or beside the content (default true). A marker that only says what the server did,
   * such as `ServerSignedMarker`, says false: it does not make the content carry its layer.
   */
  readonly carrier?: boolean;
  supports(sink: SinkInfo, mediaType: string): boolean;
  prepare?(content: MarkableContent, record: ProvenanceRecord, signal: AbortSignal): MarkableContent | Promise<MarkableContent>;
  attach?(placed: PlacedContent, record: ProvenanceRecord, signal: AbortSignal): MarkOutcome | Promise<MarkOutcome>;
}

/** A fact an enricher adds to a record: short, and never personal. */
export type ExtensionValue = string | number | boolean;

/**
 * The record a placement's marks come from: one per placement, signed by the server. Marks carry its `id`; a marker
 * with room writes `signed`, the record as the server signed it, which checks against its signature. Nothing in it
 * names the user, the prompt or the document.
 */
export interface ProvenanceRecord {
  /** The server's id for the record, or this device's (`unsigned-...`) when the server could not sign. */
  readonly id: string;
  /** The record and its JWS, as the server signed them; undefined when it could not. */
  readonly signed: SignedRecord | undefined;
  readonly editKind: EditKind;
  /** The IPTC digital source type: made by a model, or changed by one. */
  readonly digitalSourceType: string;
  readonly mediaType: string;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly model: string | undefined;
  /** What the server said made the content. */
  readonly receipt: ReceiptNote | undefined;
  readonly receiptId: string | undefined;
  /** What the receipt says about the watermark, when there is a signed receipt. */
  readonly watermark: ReceiptWatermark | undefined;
  /** What record enrichers added, under their namespaces (`com.example.matter`). */
  readonly extensions: Readonly<Record<string, ExtensionValue>>;
}

/** What a tool hands to `place()`. */
export interface PlaceRequest {
  /** The content: text, or a picture's or a file's bytes (a `data:` URL for a picture is read as its bytes). */
  content: string | Uint8Array;
  mediaType: string;
  sink: SinkInfo;
  /** The edit kind, over the tool's declared one. */
  editKind?: EditKind;
  /** The content this replaces, for an edit classifier: read on the device, never sent. */
  original?: string;
  /** The receipt of what made the content, when it is not the turn's answer: a picture's own receipt. */
  receiptId?: string;
}

/** Where `place()` put content, and which layers held. */
export interface Placement<T> {
  /** What the host's insert returned. */
  readonly result: T;
  /** The record's id (`exempt-...` for exempt content, which has no record). */
  readonly recordId: string;
  /** Whether the server signed the record. */
  readonly signed: boolean;
  readonly exempt: boolean;
  /** Why it is exempt: `exempt-edit` or `short-text`. */
  readonly reason: ReasonCode | undefined;
  readonly editKind: EditKind;
  readonly layers: readonly LayerOutcome[];
  /** The layers the content needs that did not hold, and why. */
  readonly missing: readonly MissingLayer[];
}

export interface MissingLayer {
  readonly layer: MarkLayer;
  /** Undefined when it could not be told why. */
  readonly reason: ReasonCode | undefined;
}

/** What an edit classifier is shown. */
export interface EditClassification {
  readonly tool: string;
  /** The kind the tool declared, or `generated`. */
  readonly declared: EditKind;
  readonly mediaType: string;
  readonly content: string | Uint8Array;
  /** What the content replaces, when the tool said. */
  readonly original: string | undefined;
}

export interface EditDecision {
  kind: EditKind;
  /** Why: required to lower the kind to an exempt one, and recorded (on the device only). */
  reason?: string;
}

/**
 * Decides the edit kind for a domain (`corrected` or `rewritten` for a legal text). It may change the kind; it lowers
 * it to an exempt one only with a reason, which is recorded. Undefined keeps the tool's.
 */
export interface EditClassifier {
  classify(input: EditClassification): EditDecision | undefined | Promise<EditDecision | undefined>;
}

/** What a record enricher is told about a placement: never the content. */
export interface EnrichmentContext {
  readonly tool: string;
  readonly sinkKind: string;
  readonly mediaType: string;
  readonly editKind: EditKind;
}

/**
 * Adds the integrator's own non-personal facts to a placement's record (a matter number, a ticket category) under
 * their namespace. Values that look personal (a mail address, a phone number, an IBAN) are dropped and the drop is
 * recorded. The facts stay on the device and in the marks that have room for them (a sidecar file); the server's
 * signed record has its fixed fields.
 */
export interface RecordEnricher {
  /** Reverse DNS: `com.example`. Its keys are stored as `com.example.<key>`. */
  readonly namespace: string;
  enrich(context: EnrichmentContext): Record<string, ExtensionValue> | undefined | Promise<Record<string, ExtensionValue> | undefined>;
}

/** A placement as observers see it. */
export interface ObservedPlacement {
  /** The report the server got (or would have got). */
  readonly report: Readonly<PlacementReport>;
  readonly callId: string | undefined;
  readonly signed: boolean;
  readonly exempt: boolean;
  readonly missing: readonly MissingLayer[];
}

/** Sees every placement (an integrator's own audit, telemetry). It cannot change one; its errors are ignored. */
export interface PlacementObserver {
  observe(placement: ObservedPlacement): void | Promise<void>;
}

/** The server calls the pipeline makes: replaceable for tests, or for an organisation's own signing service. */
export interface ProvenanceBackend {
  policy(signal: AbortSignal): Promise<Required<ProvenancePolicy>>;
  signRecord(request: RecordRequest, signal: AbortSignal): Promise<SignedRecord>;
  reportPlacement(report: PlacementReport, signal: AbortSignal): Promise<void>;
}
