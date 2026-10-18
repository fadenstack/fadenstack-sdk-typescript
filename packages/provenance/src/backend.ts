import {
  DEFAULT_PROVENANCE_POLICY,
  PROVENANCE_CONTRACT,
  digitalSourceType,
  toProvenancePolicy,
  type FadenstackClient,
  type PlacementReport,
  type ProvenancePolicy,
  type ProvenanceRecordPayload,
  type RecordRequest,
  type SignedRecord,
} from "@fadenstack/client";

import type { ProvenanceBackend } from "./types.js";

/** The agent's server: its provenance routes (`client.agent.provenance`). */
export class ServerBackend implements ProvenanceBackend {
  readonly #client: FadenstackClient;

  constructor(client: FadenstackClient) {
    if (!client.agent) throw new TypeError("The provenance module needs an agent's client.");
    this.#client = client;
  }

  policy(signal: AbortSignal): Promise<Required<ProvenancePolicy>> {
    return this.#client.agent!.provenance.policy(signal);
  }

  signRecord(request: RecordRequest, signal: AbortSignal): Promise<SignedRecord> {
    return this.#client.agent!.provenance.signRecord(request, signal);
  }

  reportPlacement(report: PlacementReport, signal: AbortSignal): Promise<void> {
    return this.#client.agent!.provenance.reportPlacement(report, signal);
  }
}

/**
 * A backend in memory, for tests and the marker test kit: it signs records with a signature nobody can check, keeps
 * them and the placement reports, and can be made unavailable.
 */
export class MemoryBackend implements ProvenanceBackend {
  readonly records: { request: RecordRequest; signed: SignedRecord }[] = [];
  readonly reports: PlacementReport[] = [];
  /** While true, every call fails as if the server were down. */
  down = false;
  policyValue: Required<ProvenancePolicy>;

  constructor(policy: ProvenancePolicy = {}) {
    this.policyValue = toProvenancePolicy({ ...DEFAULT_PROVENANCE_POLICY, ...policy });
  }

  async policy(): Promise<Required<ProvenancePolicy>> {
    this.#check();
    return { ...this.policyValue, exempt_edit_kinds: [...this.policyValue.exempt_edit_kinds] };
  }

  async signRecord(request: RecordRequest): Promise<SignedRecord> {
    this.#check();
    const record: ProvenanceRecordPayload = {
      contract: PROVENANCE_CONTRACT,
      id: globalThis.crypto.randomUUID(),
      digital_source_type: digitalSourceType(request.edit_kind),
      edit_kind: request.edit_kind,
      system: { name: "Fadenstack", version: "memory" },
      provider: "Example organisation",
      model: request.model ? { id: request.model, version: null } : null,
      created_at: new Date().toISOString(),
      receipt_id: request.receipt_id ?? null,
      media_type: request.media_type,
      content_hash: request.content_sha256.split("").reverse().join(""),
      hash_key_version: 1,
    };
    const signed: SignedRecord = { record, signature: `memory.${btoa(record.id)}.unsigned`, timestamp: null };
    this.records.push({ request: { ...request }, signed });
    return signed;
  }

  async reportPlacement(report: PlacementReport): Promise<void> {
    this.#check();
    this.reports.push(structuredClone(report));
  }

  #check(): void {
    if (this.down) throw new Error("The provenance service is not available.");
  }
}
