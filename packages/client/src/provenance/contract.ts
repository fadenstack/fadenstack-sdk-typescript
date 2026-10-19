/**
 * The provenance contract, version 1 (`provenance/v1`): what an SDK exchanges with the server about content made
 * with AI -- the receipts of generations, the signed records of placements, the placement reports, the policy and
 * the anchors that check the signatures.
 *
 * The types keep the server's field names (snake_case). Records and receipts are signed as they are, so they are
 * passed on and written unchanged; a mark that holds a signed record still checks against its signature. A copy of
 * the contract's JSON Schemas is in this package's `contracts/provenance/v1/`, and a test keeps these types and the
 * schemas in step. Nothing here carries content, a user, a prompt or a document name.
 */

export const PROVENANCE_CONTRACT = "provenance/v1";

/** What an edit did to the content it placed (12 §6.1). */
export const EDIT_KINDS = [
  "generated", "rewritten", "summarised", "translated", "corrected", "formatted", "extracted",
] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

/** Marked by default: new content, and content a model changed in style, structure or meaning. */
export const MARKED_EDIT_KINDS: readonly EditKind[] = ["generated", "rewritten", "summarised"];

/** Exempt by default: translations, corrections, formatting and extracts (Art. 50 guidelines, paras 65 and 90). */
export const DEFAULT_EXEMPT_EDIT_KINDS: readonly EditKind[] = ["translated", "corrected", "formatted", "extracted"];

/** Why a layer was not applied. */
export const REASON_CODES = [
  "sink-cannot-carry",
  "stripped-by-host",
  "short-text",
  "exempt-edit",
  "no-watermark-remote-model",
  "no-watermark-greedy",
  "runtime-without-watermark",
  "server-unavailable",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** The kinds of mark, in the order a placement applies them. */
export const MARK_LAYERS = ["metadata", "watermark", "fingerprint", "label"] as const;
export type MarkLayer = (typeof MARK_LAYERS)[number];

/** How long placed content is, as reported. */
export type LengthClass = "short" | "medium" | "long";

/** IPTC digital source type: content a model made. */
export const TRAINED_ALGORITHMIC_MEDIA = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
/** IPTC digital source type: existing content a model changed. */
export const COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA =
  "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia";

/** The IPTC source type an edit kind stands for: new content (`generated`), or content a model changed. */
export function digitalSourceType(editKind: EditKind): string {
  return editKind === "generated" ? TRAINED_ALGORITHMIC_MEDIA : COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA;
}

export function isEditKind(value: unknown): value is EditKind {
  return typeof value === "string" && (EDIT_KINDS as readonly string[]).includes(value);
}

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && (REASON_CODES as readonly string[]).includes(value);
}

/** One layer of one mark: applied, or not and why. */
export interface LayerOutcome {
  layer: MarkLayer;
  /** How: `c2pa`, `trustmark-Q`, `vllm-gumbel`, `html-attribute`, `front-matter`, ... */
  method: string;
  applied: boolean;
  reason?: ReasonCode | null;
  /**
   * For an applied layer: read back from the host after placing (true), or not readable there (false). Absent when
   * nothing was read back to try (the server's record, a watermark).
   */
  verified?: boolean | null;
}

/** Whether a generation carries a watermark, whose, and if not, why. */
export interface WatermarkStatus {
  applied: "model" | "engine" | "upstream" | "none";
  algorithm?: string | null;
  /** The remote provider whose own mark it is, for `upstream`. */
  vendor?: string | null;
  reason?: ReasonCode | null;
  /** The watermark key's version, for a model's watermark. */
  key_version?: number | null;
  /** The runtime's context width, for a model's watermark. */
  context_width?: number | null;
  /** The model repository whose tokenizer generation used, for a model's watermark. */
  tokenizer?: string | null;
}

/** The model that generated the content. */
export interface ModelInfo {
  id: string;
  version?: string | null;
}

/** The AI system that made or placed the content. */
export interface SystemInfo {
  name: string;
  version: string;
}

/** One generation, signed by the server: a model wrote a text or made a picture. */
export interface GenerationReceipt {
  contract?: typeof PROVENANCE_CONTRACT;
  id: string;
  kind: "text" | "image";
  model: ModelInfo;
  created_at: string;
  watermark: WatermarkStatus;
  /** HMAC-SHA-256 of the output, hex, with the hash key version below. */
  output_hash: string;
  hash_key_version: number;
}

/** A receipt with its JWS and, where a time-stamp authority answered, its RFC 3161 token (base64 DER). */
export interface SignedReceipt {
  receipt: GenerationReceipt;
  signature: string;
  timestamp?: string | null;
}

/**
 * One placement of generated content as the server signs it (the contract's `ProvenanceRecord`): the payload of the
 * record's JWS. `@fadenstack/provenance` hands markers its own `ProvenanceRecord`, which carries this one signed.
 */
export interface ProvenanceRecordPayload {
  contract?: typeof PROVENANCE_CONTRACT;
  id: string;
  digital_source_type: string;
  edit_kind: EditKind;
  system: SystemInfo;
  /** The organisation running the server. */
  provider: string;
  model?: ModelInfo | null;
  created_at: string;
  receipt_id?: string | null;
  media_type: string;
  /** HMAC-SHA-256 of the placed content, hex. */
  content_hash: string;
  hash_key_version: number;
  /** For HTML and Markdown: HMAC-SHA-256 of the plain text a reader sees, under the same key version. */
  text_hash?: string | null;
}

/** A provenance record with its JWS and, where a time-stamp authority answered, its token. */
export interface SignedRecord {
  record: ProvenanceRecordPayload;
  signature: string;
  timestamp?: string | null;
}

/**
 * A placement to record and sign, by the content's hash only (`textSha256`, `bytesSha256`): never the content. The
 * agent is the route's (`POST /v1/agents/{agent}/provenance/records`).
 */
export interface RecordRequest {
  content_sha256: string;
  /**
   * For HTML and Markdown: SHA-256 of the plain text a reader sees, normalised as `content_sha256` is
   * (`@fadenstack/provenance`'s `readerTextSha256`), so the words someone copies out of the host find the record.
   */
  text_sha256?: string | null;
  media_type: string;
  edit_kind: EditKind;
  receipt_id?: string | null;
  model?: string | null;
}

/** What an SDK reports after placing content: where, how much, which layers held. Never the content. */
export interface PlacementReport {
  /**
   * The signed record's id; absent (or null) for a placement without one: exempt content, a record the server could
   * not sign, content a tool put in without `place()`.
   */
  record_id?: string | null;
  tool: string;
  /** `word.range`, `html.editor`, `nextcloud.file`, ... */
  sink_kind: string;
  media_type: string;
  edit_kind: EditKind;
  length_class: LengthClass;
  layers: LayerOutcome[];
  /**
   * False only for an insert that failed after the record was signed: the server marks the record "not written". Left
   * out otherwise (true, the default), so a server that does not know the field yet still takes the report.
   */
  written?: boolean;
  /** Only with `written` false: the error's name as a short code (`placementFailure`), never its message or content. */
  failure?: string;
}

/** What a `failure` may be: a name of letters, digits and `_.:-`, at most 64 of them. */
export const PLACEMENT_FAILURE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * An error's name as a placement's `failure`: every other character as `_` (each UTF-16 unit, as .NET counts them), cut
 * to 64, `Error` when nothing is left. A name says what failed without anything of what was written.
 */
export function placementFailure(name: string | undefined): string {
  return (name ?? "").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64) || "Error";
}

/** The marking policy in an agent's profile. Local options may only tighten it. */
export interface ProvenancePolicy {
  /** What a placement does when a layer the content needs is not possible: record it (default), or refuse. */
  on_missing?: "record" | "refuse";
  /** Text shorter than this (in tokens) is exempt. */
  short_text_tokens?: number;
  exempt_edit_kinds?: EditKind[];
  /** The internal technical output switch (guidelines para 87), per agent. */
  internal_technical?: boolean;
  /** Whether placements add a visible label too. */
  visible_label?: boolean;
  output_log?: boolean;
}

/** The policy where the server says nothing: record, 200 tokens, translations, corrections, formats, extracts exempt. */
export const DEFAULT_PROVENANCE_POLICY: Readonly<Required<ProvenancePolicy>> = Object.freeze({
  on_missing: "record",
  short_text_tokens: 200,
  exempt_edit_kinds: [...DEFAULT_EXEMPT_EDIT_KINDS],
  internal_technical: false,
  visible_label: false,
  output_log: false,
});

/** The detection solution's identifier and what it checks. */
export interface DetectorInfo {
  id: string;
  methods: string[];
}

/** What anyone needs to check this installation's signatures offline (`GET /v1/provenance/anchors`). */
export interface Anchors {
  contract?: typeof PROVENANCE_CONTRACT;
  /** Every signing certificate chain this installation used, PEM. */
  signing_chains: string[];
  /** The CA certificates those chains end in, PEM. */
  trust_anchors: string[];
  detector: DetectorInfo;
}

/** Content to check (`POST /v1/provenance/verify`): text or a file's bytes (base64). Nothing submitted is kept. */
export interface VerifyRequest {
  text?: string | null;
  file?: string | null;
  media_type?: string | null;
  /** Return the result signed, to download. */
  signed?: boolean;
}

/** What one detection mechanism found. */
export interface VerifyFinding {
  layer: MarkLayer;
  method: string;
  found: boolean;
  detail: string;
  record_id?: string | null;
  receipt_id?: string | null;
  /** The mechanism's own measure, e.g. a p-value. */
  score?: number | null;
}

/** A detection result: the verdict, the layers it rests on, signed on request. */
export interface VerifyResult {
  contract?: typeof PROVENANCE_CONTRACT;
  verdict: "ai-generated" | "no-mark-found" | "inconclusive";
  findings: VerifyFinding[];
  /** SHA-256 of what was submitted, hex. */
  content_hash: string;
  detector: string;
  checked_at: string;
  signature?: string | null;
}
