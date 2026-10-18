import {
  FadenstackError,
  MARK_LAYERS,
  bytesSha256,
  digitalSourceType,
  isEditKind,
  receiptIdOf,
  textSha256,
  type EditKind,
  type GovernanceNotice,
  type LayerOutcome,
  type MarkLayer,
  type PlacementReport,
  type ProvenancePolicy,
  type ReasonCode,
  type ReceiptNote,
  type SignedRecord,
} from "@fadenstack/client";

import { dataUrlBytes, isCode, isImage, isLabel, isRecordId, lengthClass, tokensOf } from "./content.js";
import { inspectImage } from "./markers/imageGuard.js";
import { SIGNED_RECORD_METHOD } from "./markers/serverSigned.js";
import { watermarkOf } from "./markers/watermarkStatus.js";
import { findPersonalData, type PersonalDataFinding } from "./personalData.js";
import type {
  ContentMarker,
  EditClassifier,
  ExemptReason,
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
  /** The markers, the built-ins first: a label marker among them is always used. */
  readonly markers: readonly ContentMarker[];
  /** The label marker used while the policy asks for a visible label and `markers` has none. */
  readonly policyLabels: readonly ContentMarker[];
  readonly classifier: EditClassifier | undefined;
  readonly enrichers: readonly RecordEnricher[];
  readonly observers: readonly PlacementObserver[];
  readonly tokenizer: ((text: string) => number) | undefined;
  /** Declared content a tool did not place fails the call (`ProvenanceUnmarkedError`) rather than only being recorded. */
  readonly development: boolean;
}

/** What one placement knows of its call. */
export interface PlaceContext {
  readonly tool: string;
  readonly callId?: string;
  /** The argument the tool's `output` declares. */
  readonly argument?: string;
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
  /** Raises a notice for the user. */
  notice?(notice: GovernanceNotice): Promise<void>;
  /** A placement report that could not be sent. */
  reportFailed?(error: unknown): void;
}

const SIGN_TIMEOUT_MS = 15_000;
const REPORT_TIMEOUT_MS = 10_000;
/** A reverse domain name of the integrator's own: `com.example`. */
const NAMESPACE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
/** Namespaces of the record's own vocabulary, which no enricher may write into. */
const RESERVED = ["c2pa", "stds", "iptc", "org.iptc", "com.fadenstack", "fadenstack", "provenance"];
const FACT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The methods of the outcomes the pipeline reports itself. */
const Methods = {
  /** Exempt content: no record made. */
  exempt: "record",
  /** A container no host marker fits. */
  host: "host",
  label: "visible-label",
  c2pa: "c2pa",
} as const;

/** A layer outcome with its detail, and whether it can count for its layer (the server's record is no mark in the content). */
interface Outcome extends LayerOutcome {
  detail?: string;
  /** False for an outcome that cannot make its layer held: the server's record. */
  counts: boolean;
}

interface Needs {
  metadata: boolean;
  watermark: boolean;
  label: boolean;
}

/**
 * Places content and marks it (12 §6), in this order: the policy; the edit kind (the request's, else the tool's
 * declared output's, else `generated`, then the classifier); content exempt from marking (`internal-technical`, an
 * exempt `edit-kind`, `code`, a `label`) is put in as it is, with no record, and recorded as exempt. Other content:
 * the markers that fit the sink; the layers it needs (signed metadata in a container or for a picture, the watermark
 * for text from the short-text threshold and for pictures, the label while the policy asks for one) are checked as
 * far as they can be before anything is signed; the server signs a record by the content's hash; the markers prepare
 * the content (only with a signed record: no mark carries an id the server does not know); the host inserts it; the
 * markers attach their marks and say whether they held; the placement is recorded and reported -- which layers held,
 * and why the others did not. With the policy's `on_missing: refuse`, content a needed layer is not possible for is
 * not placed, nothing is signed or reported, and the refusal is recorded and told to the user.
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
  const text = typeof content === "string" ? content : undefined;
  const policy = await ctx.policy();
  const declared = request.editKind ?? ctx.declaredEditKind ?? "generated";
  const { kind: editKind, classified } = await classify(settings.classifier, policy, {
    tool: ctx.tool, declared, mediaType, content, original: request.original,
  });
  const tokens = text !== undefined ? tokensOf(text, settings.tokenizer) : 0;
  const shortText = text !== undefined && tokens < policy.short_text_tokens;
  // A picture has its own receipt, from the answer that made it; the chat answer's receipt is the text's.
  const receipt: ReceiptNote | undefined = request.receiptId ? { status: "reference", receiptId: request.receiptId }
    : isImage(mediaType) ? undefined : ctx.receipt;
  const receiptId = receiptIdOf(receipt);
  const { facts, dropped } = await enrich(settings.enrichers, { tool: ctx.tool, sinkKind: sink.kind, mediaType, editKind });
  const base: Base = {
    tool: ctx.tool, argument: ctx.argument, sink, mediaType, editKind, classified, length: lengthClass(content, tokens, policy),
    receiptId, facts, dropped,
  };

  const exemptBecause = exemptReason(editKind, mediaType, text, policy);
  if (exemptBecause) {
    const result = await insert({ content, mediaType, sink }, signal);
    const layers: Outcome[] = [{ layer: "metadata", method: Methods.exempt, applied: false, reason: "exempt-edit", detail: exemptBecause, counts: true }];
    return finish(settings, ctx, result, { ...base, layers, missing: [], signed: undefined, exemptBecause });
  }

  const own = settings.markers.filter((m) => supports(m, sink, mediaType));
  const labels = policy.visible_label && !own.some((m) => m.layer === "label")
    ? settings.policyLabels.filter((m) => supports(m, sink, mediaType)) : [];
  const markers = [...own, ...labels].sort((a, b) => MARK_LAYERS.indexOf(a.layer) - MARK_LAYERS.indexOf(b.layer));
  const hostMarkers = markers.filter((m) => m.layer === "metadata" && m.carrier !== false);
  const needs: Needs = {
    metadata: isImage(mediaType) || sink.container === true,
    watermark: isImage(mediaType) || (text !== undefined && !shortText),
    label: policy.visible_label && text !== undefined,
  };
  const watermark = watermarkOf(receipt, mediaType, shortText);

  // What the content needs, checked before anything is signed or placed.
  const before: MissingLayer[] = [];
  if (needs.metadata) {
    if (isImage(mediaType) && !(content instanceof Uint8Array && inspectImage(content).c2pa)) {
      before.push({ layer: "metadata", method: Methods.c2pa, reason: "stripped-by-host" });
    } else if (hostMarkers.length === 0) {
      before.push({ layer: "metadata", method: Methods.host, reason: "sink-cannot-carry" });
    }
  }
  if (needs.watermark && !watermark.applied) before.push({ layer: "watermark", method: watermark.method, reason: watermark.reason });
  if (needs.label && !markers.some((m) => m.layer === "label")) before.push({ layer: "label", method: Methods.label, reason: "sink-cannot-carry" });
  if (policy.on_missing === "refuse" && before.length) await refuse(ctx, base, before);

  const signed = await sign(ctx, content, mediaType, editKind, receipt, receiptId);
  if (!signed) {
    const unsigned: MissingLayer[] = [];
    if (needs.metadata && !before.some((m) => m.layer === "metadata")) {
      unsigned.push({ layer: "metadata", method: SIGNED_RECORD_METHOD, reason: "server-unavailable" });
    }
    if (needs.label && !before.some((m) => m.layer === "label")) unsigned.push({ layer: "label", method: Methods.label, reason: "server-unavailable" });
    if (policy.on_missing === "refuse" && unsigned.length) await refuse(ctx, base, unsigned);
  }

  const record: ProvenanceRecord | undefined = signed && Object.freeze({
    id: signed.record.id,
    signed,
    editKind,
    digitalSourceType: digitalSourceType(editKind),
    mediaType,
    createdAt: signed.record.created_at,
    model: signed.record.model?.id ?? undefined,
    receipt,
    receiptId,
    watermark: receipt?.status === "signed" ? receipt.receipt.watermark : undefined,
    extensions: Object.freeze({ ...facts }),
  });

  const failures = new Map<ContentMarker, string>();
  let marked: MarkableContent = { content, mediaType, sink };
  if (record) {
    for (const marker of markers) {
      if (!marker.prepare) continue;
      try {
        marked = await marker.prepare(marked, record, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        failures.set(marker, errorName(error));
      }
    }
  }
  const result = await insert(marked, signal);
  const outcomes: Outcome[] = [];
  if (record) {
    let readBack: Promise<string | Uint8Array | undefined> | undefined;
    const placed: PlacedContent = { ...marked, result, shortText, readBack: () => (readBack ??= readSink(sink, signal)) };
    for (const marker of markers) {
      const counts = !(marker.layer === "metadata" && marker.carrier === false);
      const failed = (name: string): Outcome => ({ layer: marker.layer, method: marker.name, applied: false, detail: `failed: ${name}`, counts });
      if (failures.has(marker)) {
        outcomes.push(failed(failures.get(marker)!));
      } else if (marker.attach) {
        try {
          outcomes.push(toOutcome(marker.layer, await marker.attach(placed, record, signal), counts));
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          outcomes.push(failed(errorName(error)));
        }
      } else if (marker.prepare) {
        outcomes.push({ layer: marker.layer, method: marker.name, applied: true, verified: false, detail: "not read back", counts });
      }
    }
  }

  // What the pipeline knows itself: no record, no host marker, the watermark when no marker said.
  if (!record) {
    outcomes.push({ layer: "metadata", method: SIGNED_RECORD_METHOD, applied: false, reason: "server-unavailable", counts: true });
  } else if (hostMarkers.length === 0) {
    outcomes.push({ layer: "metadata", method: Methods.host, applied: false, reason: "sink-cannot-carry", counts: true });
  }
  if ((text !== undefined || isImage(mediaType)) && !outcomes.some((o) => o.layer === "watermark")) {
    outcomes.push(toOutcome("watermark", watermark, true));
  }
  for (const layer of ["metadata", "watermark", "label"] as const) {
    const missing = before.find((m) => m.layer === layer);
    if (needs[layer] && missing && !outcomes.some((o) => o.layer === layer && o.counts)) {
      outcomes.push({ layer, method: missing.method, applied: false, ...(missing.reason ? { reason: missing.reason } : {}), counts: true });
    }
  }
  if (!record && needs.label && !outcomes.some((o) => o.layer === "label")) {
    outcomes.push({ layer: "label", method: Methods.label, applied: false, reason: "server-unavailable", counts: true });
  }
  const layers = sortByLayer(outcomes);

  const missing: MissingLayer[] = [];
  for (const layer of ["metadata", "watermark", "label"] as const) {
    if (!needs[layer]) continue;
    const ofLayer = layers.filter((o) => o.layer === layer && o.counts);
    if (ofLayer.some((o) => o.applied)) continue;
    const lost = ofLayer.find((o) => o.reason) ?? ofLayer[0];
    const known = before.find((m) => m.layer === layer);
    missing.push(lost ? { layer, method: lost.method, reason: lost.reason ?? undefined } : known ?? { layer, method: "none", reason: undefined });
  }
  return finish(settings, ctx, result, { ...base, layers, missing, signed, exemptBecause: undefined });
}

/** What every placement knows before it is marked. */
interface Base {
  tool: string;
  argument: string | undefined;
  sink: SinkInfo;
  mediaType: string;
  editKind: EditKind;
  classified: Classified | undefined;
  length: PlacementReport["length_class"];
  receiptId: string | undefined;
  facts: Record<string, ExtensionValue>;
  dropped: string[];
}

/** What a placement ends with, to record and report. */
interface Done extends Base {
  layers: Outcome[];
  missing: MissingLayer[];
  signed: SignedRecord | undefined;
  exemptBecause: ExemptReason | undefined;
}

/** Reports the placement, writes its transcript entry, tells the observers; a report that fails never fails it. */
async function finish<T>(settings: PipelineSettings, ctx: PlaceContext, result: T, done: Done): Promise<Placement<T>> {
  const recordId = done.signed?.record.id;
  const layers: LayerOutcome[] = done.layers.map(({ layer, method, applied, reason, verified }) => ({
    layer, method, applied, ...(reason ? { reason } : {}), ...(verified !== undefined && verified !== null ? { verified } : {}),
  }));
  const report: PlacementReport = {
    ...(recordId ? { record_id: recordId } : {}), tool: done.tool, sink_kind: done.sink.kind, media_type: done.mediaType,
    edit_kind: done.editKind, length_class: done.length, layers: layers.slice(0, 32),
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
    argument: done.argument ?? null,
    record_id: recordId ?? null,
    signed: done.signed !== undefined,
    receipt_id: done.receiptId ?? null,
    sink_kind: done.sink.kind,
    media_type: done.mediaType,
    edit_kind: done.editKind,
    length_class: done.length,
    exempt: done.exemptBecause !== undefined,
    exempt_because: done.exemptBecause ?? null,
    classified: done.classified ?? null,
    layers: done.layers.map((l) => ({
      layer: l.layer, method: l.method, applied: l.applied, reason: l.reason ?? null, verified: l.verified ?? null, detail: l.detail ?? null,
    })),
    missing: done.missing.map((m) => ({ layer: m.layer, method: m.method, reason: m.reason ?? null })),
    reported,
    facts: Object.keys(done.facts).length ? done.facts : null,
    dropped_facts: done.dropped.length ? done.dropped : null,
  });
  const observed = Object.freeze({
    report: Object.freeze(structuredClone(report)), callId: ctx.callId, signed: done.signed !== undefined,
    exempt: done.exemptBecause !== undefined, exemptBecause: done.exemptBecause, missing: Object.freeze([...done.missing]),
  });
  for (const observer of settings.observers) {
    try {
      await observer.observe(observed);
    } catch {
      // an observer only watches
    }
  }
  return Object.freeze({
    result, recordId, signed: done.signed !== undefined, exempt: done.exemptBecause !== undefined,
    reason: done.exemptBecause ? "exempt-edit" as const : undefined, exemptBecause: done.exemptBecause,
    editKind: done.editKind, layers: Object.freeze(layers), missing: Object.freeze([...done.missing]),
  });
}

/** Records the refusal, tells the user, and throws it with why in words the model can pass on. Nothing is reported. */
async function refuse(ctx: PlaceContext, base: Base, missing: MissingLayer[]): Promise<never> {
  const message = refusalMessage(missing);
  await ctx.record?.(ProvenanceEntryTypes.refused, {
    call_id: ctx.callId ?? null, tool: base.tool, argument: base.argument ?? null, sink_kind: base.sink.kind, media_type: base.mediaType,
    edit_kind: base.editKind, length_class: base.length,
    missing: missing.map((m) => ({ layer: m.layer, method: m.method, reason: m.reason ?? null })),
  });
  await ctx.notice?.({ outcome: "provenance_refused", stage: "tool", category: "provenance", message });
  throw new ProvenanceRefusedError(message, missing);
}

/** Why content was not placed, for the model and the user (the .NET SDK says the same). */
export function refusalMessage(missing: readonly MissingLayer[]): string {
  const why = [...new Set(missing.map(reasonText))];
  return `Not written: this agent only places content it can mark as AI-generated, and here ${why.join("; ")}.`;
}

function reasonText(m: MissingLayer): string {
  if (m.layer === "watermark") {
    if (m.method === "trustmark") return "the picture carries no watermark of this installation";
    switch (m.reason) {
      case undefined: return "it is not known whether the text carries the model's watermark";
      case "no-watermark-remote-model": return "the text comes from a remote model without a watermark";
      case "no-watermark-greedy": return "the text was generated without a watermark (greedy decoding)";
      case "runtime-without-watermark": return "the model's runtime does not watermark text";
      case "server-unavailable": return "the answer's receipt could not be signed";
      default: return "the text carries no watermark";
    }
  }
  switch (m.reason) {
    case "server-unavailable": return "the provenance service could not sign a record of it";
    case "sink-cannot-carry": return m.layer === "label" ? "this place cannot show a visible label" : "this place cannot carry a machine-readable mark";
    case "stripped-by-host": return "the picture lost its signed metadata before it was placed";
    default: return "it could not be marked";
  }
}

/** Why content needs no mark at all, in this order; undefined when it needs marking. */
function exemptReason(editKind: EditKind, mediaType: string, text: string | undefined, policy: Required<ProvenancePolicy>): ExemptReason | undefined {
  return policy.internal_technical ? "internal-technical"
    : policy.exempt_edit_kinds.includes(editKind) ? "edit-kind"
    : isCode(mediaType) ? "code"
    : text !== undefined && isLabel(text, mediaType) ? "label"
    : undefined;
}

/** The server's signed record of the placement, by the content's hash only; undefined when it did not sign one. */
async function sign(
  ctx: PlaceContext, content: string | Uint8Array, mediaType: string, editKind: EditKind, receipt: ReceiptNote | undefined,
  receiptId: string | undefined,
): Promise<SignedRecord | undefined> {
  const sha = typeof content === "string" ? await textSha256(content) : await bytesSha256(content);
  // The agent's model writes its text, not its pictures.
  const model = receipt?.status === "signed" && receipt.receipt.model.id ? receipt.receipt.model.id : isImage(mediaType) ? undefined : ctx.model;
  try {
    const signed = await ctx.backend.signRecord({
      content_sha256: sha, media_type: mediaType, edit_kind: editKind,
      ...(receiptId !== undefined ? { receipt_id: receiptId } : {}),
      ...(model ? { model } : {}),
    }, AbortSignal.any([ctx.signal, AbortSignal.timeout(SIGN_TIMEOUT_MS)]));
    // Marks carry the id: one that is not the server's kind of id is no record to carry.
    return isRecordId(signed?.record?.id) ? signed : undefined;
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
    return undefined;
  }
}

/** The outcome as reported, with what only the transcript keeps. */
function toOutcome(layer: MarkLayer, outcome: MarkOutcome, counts: boolean): Outcome {
  return {
    layer, method: outcome.method, applied: outcome.applied,
    ...(!outcome.applied && outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.applied && outcome.verified !== undefined ? { verified: outcome.verified } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    counts,
  };
}

function sortByLayer(outcomes: Outcome[]): Outcome[] {
  return outcomes.map((o, i) => ({ o, i }))
    .sort((a, b) => MARK_LAYERS.indexOf(a.o.layer) - MARK_LAYERS.indexOf(b.o.layer) || a.i - b.i)
    .map(({ o }) => o);
}

/** The classifier's decision, as the transcript keeps it: on the device only. */
interface Classified {
  from: EditKind;
  to: EditKind;
  reason: string | null;
}

async function classify(
  classifier: EditClassifier | undefined,
  policy: Required<ProvenancePolicy>,
  input: { tool: string; declared: EditKind; mediaType: string; content: string | Uint8Array; original: string | undefined },
): Promise<{ kind: EditKind; classified: Classified | undefined }> {
  const declared = input.declared;
  if (!classifier || typeof input.content !== "string") return { kind: declared, classified: undefined };
  let decision;
  try {
    decision = await classifier.classify(input);
  } catch {
    return { kind: declared, classified: { from: declared, to: declared, reason: "the classifier failed" } };
  }
  if (!decision || !isEditKind(decision.kind) || decision.kind === declared) return { kind: declared, classified: undefined };
  const reason = decision.reason?.trim().slice(0, 200) || null;
  // Lowering to an exempt kind needs a reason; without one the tool's kind stands.
  const lowers = policy.exempt_edit_kinds.includes(decision.kind) && !policy.exempt_edit_kinds.includes(declared);
  if (lowers && !reason) return { kind: declared, classified: { from: declared, to: declared, reason: `${decision.kind} without a reason: not taken` } };
  return { kind: decision.kind, classified: { from: declared, to: decision.kind, reason } };
}

const PERSONAL: Record<PersonalDataFinding["kind"], string> = {
  email: "e-mail address", phone: "phone number", iban: "IBAN", "ip-address": "IP address", known: "a known value",
};

/**
 * The enrichers' facts under their namespaces (`com.example.matter`); what is outside, malformed, too long or looks
 * personal is dropped and said why, as the .NET SDK says it.
 */
async function enrich(
  enrichers: readonly RecordEnricher[],
  context: { tool: string; sinkKind: string; mediaType: string; editKind: EditKind },
): Promise<{ facts: Record<string, ExtensionValue>; dropped: string[] }> {
  const facts: Record<string, ExtensionValue> = {};
  const dropped: string[] = [];
  for (const enricher of enrichers) {
    const space = enricher.namespace?.trim() ?? "";
    if (!NAMESPACE.test(space) || RESERVED.some((r) => space === r || space.startsWith(`${r}.`))) {
      dropped.push(`${space}: not a namespace of the integrator's own`);
      continue;
    }
    let given: Record<string, ExtensionValue> | undefined;
    try {
      given = await enricher.enrich(Object.freeze({ ...context }));
    } catch (error) {
      dropped.push(`${space}: failed (${errorName(error)})`);
      continue;
    }
    for (const [key, value] of Object.entries(given ?? {})) {
      const name = `${space}.${key}`;
      const scalar = typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
      const found = scalar ? findPersonalData(String(value))[0] : undefined;
      if (!FACT_NAME.test(key)) dropped.push(`${name}: outside ${space}`);
      else if (!scalar || String(value).length === 0 || String(value).length > 200) dropped.push(`${name}: empty or longer than 200 characters`);
      else if (found) dropped.push(`${name}: looks like personal data (${PERSONAL[found.kind]})`);
      else facts[name] = value;
    }
  }
  return { facts, dropped };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
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
