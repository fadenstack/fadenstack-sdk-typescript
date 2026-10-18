import {
  FadenstackError,
  MARK_LAYERS,
  bytesSha256,
  digitalSourceType,
  isEditKind,
  receiptIdOf,
  textSha256,
  type EditKind,
  type LayerOutcome,
  type MarkLayer,
  type PlacementReport,
  type ProvenancePolicy,
  type ReasonCode,
  type ReceiptNote,
  type SignedRecord,
} from "@fadenstack/client";

import { dataUrlBytes, isCode, isImage, lengthClass, localId, tokensOf } from "./content.js";
import { inspectImage } from "./markers/imageGuard.js";
import { watermarkOf } from "./markers/watermarkStatus.js";
import { findPersonalData } from "./personalData.js";
import type {
  ContentMarker,
  EditClassifier,
  ExtensionValue,
  MarkableContent,
  MarkOutcome,
  MissingLayer,
  PlacedContent,
  Placement,
  PlacementObserver,
  PlaceRequest,
  ProvenanceBackend,
  ProvenanceRecord,
  RecordEnricher,
  SinkInfo,
} from "./types.js";

/** The transcript entries the provenance module writes: ids, kinds and layers, never content. */
export const ProvenanceEntryTypes = {
  /** Content went through `place()`: where, which layers held, why the others did not. */
  placed: "provenance.placed",
  /** `place()` refused, as the policy says (`on_missing: refuse`), because a layer the content needs was not possible. */
  refused: "provenance.refused",
  /** A tool declared content for people (`output`) and did not place it through `place()`. */
  unmarked: "provenance.unmarked",
} as const;

/** `place()` refused, as the policy says: a layer the content needs is not possible. Nothing was placed. */
export class ProvenanceRefusedError extends FadenstackError {
  readonly missing: readonly MissingLayer[];

  constructor(message: string, missing: readonly MissingLayer[]) {
    super(message);
    this.missing = missing;
  }
}

/** In development: a tool declared content for people and did not place it through `place()`. */
export class ProvenanceUnmarkedError extends FadenstackError {}

/** The host's own insert: puts the (marked) content where it goes, and returns what the tool needs back. */
export type Insert<T> = (marked: MarkableContent, signal: AbortSignal) => T | Promise<T>;

/** What the pipeline is made of: the module's options, settled. */
export interface PipelineSettings {
  readonly markers: readonly ContentMarker[];
  /** Label markers used only while the policy asks for a visible label. */
  readonly policyLabels: readonly ContentMarker[];
  readonly classifier: EditClassifier | undefined;
  readonly enrichers: readonly RecordEnricher[];
  readonly observers: readonly PlacementObserver[];
  readonly tokenizer: ((text: string) => number) | undefined;
  /** A marker's error fails the placement (after it is recorded), rather than only being recorded. */
  readonly development: boolean;
}

/** What one placement knows of its call. */
export interface PlaceContext {
  readonly tool: string;
  readonly callId?: string;
  /** The kind the tool's `output` declares for this call. */
  readonly declaredEditKind?: EditKind;
  /** The receipt of the answer that made the call. */
  readonly receipt?: ReceiptNote;
  /** The agent's model, where no receipt names one. */
  readonly model?: string;
  readonly signal: AbortSignal;
  policy(): Promise<Required<ProvenancePolicy>>;
  readonly backend: ProvenanceBackend;
  /** Writes the module's transcript entries. */
  record?(type: string, data: Record<string, unknown>): Promise<void>;
  /** A placement report that could not be sent. */
  reportFailed?(error: unknown): void;
}

const SIGN_TIMEOUT_MS = 15_000;
const REPORT_TIMEOUT_MS = 10_000;
const NAMESPACE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
/** Namespaces of the record's own vocabulary, which no enricher may write into. */
const RESERVED_NAMESPACE = /^(c2pa|stds|org\.iptc|com\.fadenstack)(\.|$)/;
const EXTENSION_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Places content and marks it (12 §6): exempt content (an exempt edit kind, code, short text) is put in as it is and
 * recorded as exempt. Other content gets a record the server signs by the content's hash, the markers that fit the
 * sink prepare it, the host inserts it, the markers attach their marks and say whether they held, and the placement
 * is recorded and reported -- which layers held, and why the others did not. With the policy's `on_missing: refuse`,
 * content a layer it needs is not possible for is not placed at all.
 */
export async function placeContent<T>(settings: PipelineSettings, request: PlaceRequest, insert: Insert<T>, ctx: PlaceContext): Promise<Placement<T>> {
  checkRequest(request);
  const signal = ctx.signal;
  const sink = request.sink;
  const mediaType = request.mediaType;
  let content = request.content;
  if (isImage(mediaType) && typeof content === "string") {
    const bytes = dataUrlBytes(content);
    if (!bytes) throw new TypeError("A picture is placed as its bytes, or a data: URL of them.");
    content = bytes;
  }
  const policy = await ctx.policy();
  const declared = request.editKind ?? ctx.declaredEditKind ?? "generated";
  const { kind: editKind, reason: editReason } = await classify(settings.classifier, policy, {
    tool: ctx.tool, declared, mediaType, content, original: request.original,
  });
  const tokens = typeof content === "string" ? tokensOf(content, mediaType, settings.tokenizer) : 0;
  const base: Omit<Done, "layers" | "missing" | "record" | "exempt" | "dropped" | "errors"> = {
    tool: ctx.tool, sink, mediaType, editKind, declared, editReason, length: lengthClass(content, tokens, policy),
  };
  const required = requiredLayers(sink, mediaType, policy);

  const exempt: ReasonCode | undefined =
    policy.exempt_edit_kinds.includes(editKind) || isCode(mediaType) || policy.internal_technical ? "exempt-edit"
    : typeof content === "string" && tokens < policy.short_text_tokens ? "short-text"
    : undefined;
  if (exempt) {
    const result = await insert({ content, mediaType, sink }, signal);
    const layers = required.filter((l) => l !== "label").map((layer): LayerOutcome => ({ layer, method: "none", applied: false, reason: exempt }));
    return finish(settings, ctx, result, { ...base, layers, missing: [], record: undefined, exempt, dropped: [], errors: [] });
  }

  // What the content needs, checked before anything is signed or placed.
  // A picture has its own receipt, from the answer that made it; the chat answer's receipt is the text's.
  const receipt: ReceiptNote | undefined = request.receiptId ? { status: "reference", receiptId: request.receiptId }
    : isImage(mediaType) ? undefined : ctx.receipt;
  const receiptId = receiptIdOf(receipt);
  const markers = [...settings.markers, ...(policy.visible_label ? settings.policyLabels : [])]
    .filter((m) => supports(m, sink, mediaType))
    .sort((a, b) => MARK_LAYERS.indexOf(a.layer) - MARK_LAYERS.indexOf(b.layer));
  const watermark = watermarkOf({ receipt, receiptId }, mediaType, content);
  const before: MissingLayer[] = [];
  if (required.includes("metadata")) {
    if (isImage(mediaType)) {
      if (!(content instanceof Uint8Array && inspectImage(content).c2pa)) before.push({ layer: "metadata", reason: "stripped-by-host" });
    } else if (!markers.some((m) => m.layer === "metadata" && m.carrier !== false)) {
      before.push({ layer: "metadata", reason: "sink-cannot-carry" });
    }
  }
  if (required.includes("watermark") && !watermark.applied) before.push({ layer: "watermark", reason: watermark.reason });
  if (required.includes("label") && !markers.some((m) => m.layer === "label")) before.push({ layer: "label", reason: "sink-cannot-carry" });
  if (policy.on_missing === "refuse" && before.length) await refuse(ctx, base, before);

  const sha = typeof content === "string" ? await textSha256(content) : await bytesSha256(content);
  const model = receipt?.status === "signed" ? receipt.receipt.model.id : ctx.model;
  let signed: SignedRecord | undefined;
  try {
    signed = await ctx.backend.signRecord({
      content_sha256: sha, media_type: mediaType, edit_kind: editKind,
      ...(receiptId !== undefined ? { receipt_id: receiptId } : {}),
      ...(model ? { model } : {}),
    }, AbortSignal.any([signal, AbortSignal.timeout(SIGN_TIMEOUT_MS)]));
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
  }
  if (!signed && !isImage(mediaType) && required.includes("metadata") && !before.some((m) => m.layer === "metadata")) {
    before.push({ layer: "metadata", reason: "server-unavailable" });
  }
  if (policy.on_missing === "refuse" && before.length) await refuse(ctx, base, before);

  const { extensions, dropped } = await enrich(settings.enrichers, { tool: ctx.tool, sinkKind: sink.kind, mediaType, editKind });
  const record: ProvenanceRecord = Object.freeze({
    id: signed?.record.id ?? `unsigned-${localId()}`,
    signed,
    editKind,
    digitalSourceType: digitalSourceType(editKind),
    mediaType,
    createdAt: signed?.record.created_at ?? new Date().toISOString(),
    model: signed?.record.model?.id ?? model,
    receipt,
    receiptId,
    watermark: receipt?.status === "signed" ? receipt.receipt.watermark : undefined,
    extensions: Object.freeze(extensions),
  });

  const errors = new Map<ContentMarker, unknown>();
  let marked: MarkableContent = { content, mediaType, sink };
  for (const marker of markers) {
    if (!marker.prepare) continue;
    try {
      marked = await marker.prepare(marked, record, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      errors.set(marker, error);
    }
  }
  const result = await insert(marked, signal);
  let readBack: Promise<string | Uint8Array | undefined> | undefined;
  const placed: PlacedContent = { ...marked, result, readBack: () => (readBack ??= readSink(sink, signal)) };
  const outcomes: { marker: ContentMarker; outcome: MarkOutcome }[] = [];
  for (const marker of markers) {
    let outcome: MarkOutcome | undefined;
    if (errors.has(marker)) outcome = { applied: false, method: marker.name };
    else if (marker.attach) {
      try {
        outcome = await marker.attach(placed, record, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        errors.set(marker, error);
        outcome = { applied: false, method: marker.name };
      }
    } else if (marker.prepare) outcome = { applied: true, method: marker.name, verified: false };
    if (outcome) outcomes.push({ marker, outcome });
  }

  const layers: LayerOutcome[] = outcomes.map(({ marker, outcome }) => ({
    layer: marker.layer,
    method: outcome.verified === false ? `${outcome.method}:unverified` : outcome.method,
    applied: outcome.applied,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  }));
  const missing: MissingLayer[] = [];
  for (const layer of required) {
    const counted = outcomes.filter(({ marker }) => marker.layer === layer && (layer !== "metadata" || marker.carrier !== false));
    // Metadata is signed metadata: a host mark of a record the server could not sign flags the content, and no more.
    const unsigned = layer === "metadata" && !isImage(mediaType) && !signed;
    const held = !unsigned
      && (counted.some(({ outcome }) => outcome.applied) || (layer === "watermark" && counted.length === 0 && watermark.applied));
    if (held) continue;
    const reason = unsigned ? "server-unavailable"
      : counted.find(({ outcome }) => outcome.reason)?.outcome.reason ?? before.find((m) => m.layer === layer)?.reason;
    missing.push({ layer, reason });
    if (counted.length === 0) layers.push({ layer, method: "none", applied: false, ...(reason ? { reason } : {}) });
  }
  const placement = await finish(settings, ctx, result, {
    ...base, layers, missing, record, exempt: undefined, dropped, errors: [...errors.keys()].map((m) => m.name),
  });
  if (settings.development && errors.size) throw [...errors.values()][0];
  return placement;
}

/** What a placement ends with, to record and report. */
interface Done {
  tool: string;
  sink: SinkInfo;
  mediaType: string;
  editKind: EditKind;
  declared: EditKind;
  editReason: string | undefined;
  length: PlacementReport["length_class"];
  layers: LayerOutcome[];
  missing: MissingLayer[];
  record: ProvenanceRecord | undefined;
  exempt: ReasonCode | undefined;
  dropped: string[];
  errors: string[];
}

/** Reports the placement, writes its transcript entry, tells the observers; a report that fails never fails it. */
async function finish<T>(settings: PipelineSettings, ctx: PlaceContext, result: T, done: Done): Promise<Placement<T>> {
  const recordId = done.record?.id ?? `exempt-${localId()}`;
  const report: PlacementReport = {
    record_id: recordId, tool: done.tool, sink_kind: done.sink.kind, media_type: done.mediaType, edit_kind: done.editKind,
    length_class: done.length, layers: done.layers,
  };
  let reported = true;
  try {
    await ctx.backend.reportPlacement(report, AbortSignal.timeout(REPORT_TIMEOUT_MS));
  } catch (error) {
    reported = false;
    ctx.reportFailed?.(error);
  }
  await ctx.record?.(ProvenanceEntryTypes.placed, {
    call_id: ctx.callId ?? null,
    tool: done.tool,
    record_id: recordId,
    signed: done.record?.signed !== undefined,
    exempt: done.exempt !== undefined,
    reason: done.exempt ?? null,
    sink_kind: done.sink.kind,
    media_type: done.mediaType,
    edit_kind: done.editKind,
    ...(done.declared !== done.editKind ? { declared_edit_kind: done.declared, edit_reason: done.editReason ?? null } : {}),
    length_class: done.length,
    receipt_id: done.record?.receiptId ?? null,
    layers: done.layers.map((l) => ({ ...l, reason: l.reason ?? null })),
    missing: done.missing.map((m) => ({ layer: m.layer, reason: m.reason ?? null })),
    reported,
    ...(done.errors.length ? { marker_errors: done.errors } : {}),
    ...(done.dropped.length ? { dropped_extensions: done.dropped } : {}),
  });
  const observed = Object.freeze({
    report: Object.freeze(structuredClone(report)), callId: ctx.callId, signed: done.record?.signed !== undefined,
    exempt: done.exempt !== undefined, missing: Object.freeze([...done.missing]),
  });
  for (const observer of settings.observers) {
    try {
      await observer.observe(observed);
    } catch {
      // an observer only watches
    }
  }
  return Object.freeze({
    result, recordId, signed: done.record?.signed !== undefined, exempt: done.exempt !== undefined, reason: done.exempt,
    editKind: done.editKind, layers: Object.freeze([...done.layers]), missing: Object.freeze([...done.missing]),
  });
}

/** Records the refusal and throws it, with why in words the model can pass on. */
async function refuse(ctx: PlaceContext, base: Pick<Done, "tool" | "sink" | "mediaType" | "editKind">, missing: MissingLayer[]): Promise<never> {
  await ctx.record?.(ProvenanceEntryTypes.refused, {
    call_id: ctx.callId ?? null, tool: base.tool, sink_kind: base.sink.kind, media_type: base.mediaType, edit_kind: base.editKind,
    missing: missing.map((m) => ({ layer: m.layer, reason: m.reason ?? null })),
  });
  throw new ProvenanceRefusedError(refusalMessage(missing), missing);
}

/** Why content was not placed, for the model and the user. */
export function refusalMessage(missing: readonly MissingLayer[]): string {
  const why = missing.map((m) => `its ${m.layer} layer (${REASONS[m.reason ?? "unknown"] ?? REASONS["unknown"]})`);
  return `Not placed: this agent's policy places content made with AI only with every mark it needs, and ${why.join(" and ")} `
    + "is not possible here. Nothing was written; tell the user why.";
}

const REASONS: Record<string, string> = {
  "sink-cannot-carry": "this place cannot carry a mark",
  "stripped-by-host": "the host removed the mark",
  "server-unavailable": "the server could not sign the record",
  "runtime-without-watermark": "the model's runtime does not watermark text",
  "no-watermark-remote-model": "the remote model's text carries no watermark",
  "no-watermark-greedy": "text written at temperature 0 carries no watermark",
  unknown: "it could not be checked",
};

/** The layers content needs where it lands: a container or a picture two (metadata and watermark), free text the watermark. */
function requiredLayers(sink: SinkInfo, mediaType: string, policy: Required<ProvenancePolicy>): MarkLayer[] {
  const container = isImage(mediaType) || (sink.container ?? sink.carries.length > 0);
  const layers: MarkLayer[] = container ? ["metadata", "watermark"] : ["watermark"];
  if (policy.visible_label && !isImage(mediaType)) layers.push("label");
  return layers;
}

async function classify(
  classifier: EditClassifier | undefined,
  policy: Required<ProvenancePolicy>,
  input: { tool: string; declared: EditKind; mediaType: string; content: string | Uint8Array; original: string | undefined },
): Promise<{ kind: EditKind; reason: string | undefined }> {
  if (!classifier) return { kind: input.declared, reason: undefined };
  const decision = await classifier.classify(input);
  if (!decision || !isEditKind(decision.kind) || decision.kind === input.declared) return { kind: input.declared, reason: undefined };
  const reason = decision.reason?.trim().slice(0, 200) || undefined;
  // Lowering to an exempt kind needs a reason; without one the tool's kind stands.
  const lowers = policy.exempt_edit_kinds.includes(decision.kind) && !policy.exempt_edit_kinds.includes(input.declared);
  return lowers && !reason ? { kind: input.declared, reason: undefined } : { kind: decision.kind, reason };
}

/** The enrichers' facts under their namespaces; what is malformed or looks personal is dropped and named. */
async function enrich(
  enrichers: readonly RecordEnricher[],
  context: { tool: string; sinkKind: string; mediaType: string; editKind: EditKind },
): Promise<{ extensions: Record<string, ExtensionValue>; dropped: string[] }> {
  const extensions: Record<string, ExtensionValue> = {};
  const dropped: string[] = [];
  for (const enricher of enrichers) {
    const namespace = enricher.namespace;
    if (!NAMESPACE.test(namespace) || RESERVED_NAMESPACE.test(namespace)) {
      dropped.push(`${namespace}.*`);
      continue;
    }
    let facts: Record<string, ExtensionValue> | undefined;
    try {
      facts = await enricher.enrich(Object.freeze({ ...context }));
    } catch {
      dropped.push(`${namespace}.*`);
      continue;
    }
    for (const [key, value] of Object.entries(facts ?? {})) {
      const name = `${namespace}.${key}`;
      const scalar = typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
      if (!EXTENSION_KEY.test(key) || !scalar || String(value).length > 200 || findPersonalData(String(value)).length) {
        dropped.push(name);
        continue;
      }
      extensions[name] = value;
    }
  }
  return { extensions, dropped };
}

function supports(marker: ContentMarker, sink: SinkInfo, mediaType: string): boolean {
  try {
    return marker.supports(sink, mediaType);
  } catch {
    return false;
  }
}

async function readSink(sink: SinkInfo, signal: AbortSignal): Promise<string | Uint8Array | undefined> {
  if (!sink.readBack) return undefined;
  try {
    return (await sink.readBack(signal)) ?? undefined;
  } catch {
    return undefined;
  }
}

function checkRequest(request: PlaceRequest): void {
  if (typeof request.content !== "string" && !(request.content instanceof Uint8Array)) throw new TypeError("Content is text or bytes.");
  if (!request.mediaType?.trim()) throw new TypeError("Content needs its media type.");
  if (!request.sink?.kind?.trim() || !Array.isArray(request.sink.carries)) {
    throw new TypeError("A sink needs a kind and what it carries (carries: [] for nothing).");
  }
  if (request.editKind !== undefined && !isEditKind(request.editKind)) throw new TypeError(`Not an edit kind: '${String(request.editKind)}'.`);
}
