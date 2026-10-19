import { FadenstackError } from "../errors.js";
import type { FadenstackTransport } from "../http/transport.js";
import {
  DEFAULT_PROVENANCE_POLICY,
  isEditKind,
  type Anchors,
  type PlacementReport,
  type ProvenancePolicy,
  type RecordRequest,
  type SignedRecord,
  type VerifyRequest,
  type VerifyResult,
} from "../provenance/contract.js";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The agent's provenance routes: its marking policy, signing the record of a placement, and reporting where content
 * went. Content never goes to the server: a record is signed by the content's hash.
 */
export class AgentProvenanceResource {
  readonly #transport: FadenstackTransport;
  readonly #agent: string;

  constructor(transport: FadenstackTransport, agent: string) {
    this.#transport = transport;
    this.#agent = agent;
  }

  #route(rest: string): URL {
    return this.#transport.gateway(`v1/agents/${encodeURIComponent(this.#agent)}/provenance/${rest}`);
  }

  /** The agent's marking policy (`GET .../provenance/policy`), completed with the contract's defaults. */
  async policy(signal?: AbortSignal): Promise<Required<ProvenancePolicy>> {
    return toProvenancePolicy(await this.#transport.get<unknown>(this.#route("policy"), signal));
  }

  /**
   * Records one placement and has the server sign the record (`POST .../provenance/records`). The request holds the
   * content's SHA-256 (`textSha256`, `bytesSha256`), never the content.
   */
  async signRecord(request: RecordRequest, signal?: AbortSignal): Promise<SignedRecord> {
    if (!SHA256.test(request.content_sha256)) throw new TypeError("content_sha256 is a SHA-256 in lowercase hex.");
    if (request.text_sha256 && !SHA256.test(request.text_sha256)) throw new TypeError("text_sha256 is a SHA-256 in lowercase hex.");
    if (!isEditKind(request.edit_kind)) throw new TypeError(`Not an edit kind: '${String(request.edit_kind)}'.`);
    const body: Json = { content_sha256: request.content_sha256, media_type: request.media_type, edit_kind: request.edit_kind };
    if (request.text_sha256) body["text_sha256"] = request.text_sha256;
    if (request.receipt_id) body["receipt_id"] = request.receipt_id;
    if (request.model) body["model"] = request.model;
    return toSignedRecord(await this.#transport.post<unknown>(this.#route("records"), body, signal));
  }

  /** Reports a placement (`POST .../provenance/placements`): where content went and which layers held. */
  async reportPlacement(report: PlacementReport, signal?: AbortSignal): Promise<void> {
    await this.#transport.post<unknown>(this.#route("placements"), report, signal);
  }

  /** Checks content for marks with the agent's token (`POST .../provenance/verify`). Nothing submitted is kept. */
  verify(request: VerifyRequest, signal?: AbortSignal): Promise<VerifyResult> {
    return verifyAt(this.#transport, this.#route("verify"), request, signal);
  }
}

/** The server's provenance routes any client may use: the anchors that check signatures, and the detector. */
export class ProvenanceResource {
  readonly #transport: FadenstackTransport;
  readonly #agent: string | undefined;

  /** `agent`: the client's agent, whose route `verify` takes (an agent token is refused on the user's route). */
  constructor(transport: FadenstackTransport, agent?: string) {
    this.#transport = transport;
    this.#agent = agent;
  }

  /** Every signing certificate chain the installation used and the CAs they end in (`GET /v1/provenance/anchors`). */
  async anchors(signal?: AbortSignal): Promise<Anchors> {
    const answer = obj(await this.#transport.get<unknown>(this.#transport.gateway("v1/provenance/anchors"), signal));
    if (!answer || !Array.isArray(answer["signing_chains"]) || !Array.isArray(answer["trust_anchors"]) || !obj(answer["detector"])) {
      throw new FadenstackError("The server's anchors are not in the provenance/v1 shape.");
    }
    return answer as unknown as Anchors;
  }

  /**
   * Checks content for marks. Nothing submitted is kept. An agent's client checks on its agent's route
   * (`POST /v1/agents/{agent}/provenance/verify`, its agent token), as its other routes go; a client without an agent
   * on the signed-in user's (`POST /v1/provenance/verify`).
   */
  verify(request: VerifyRequest, signal?: AbortSignal): Promise<VerifyResult> {
    const route = this.#agent !== undefined
      ? `v1/agents/${encodeURIComponent(this.#agent)}/provenance/verify` : "v1/provenance/verify";
    return verifyAt(this.#transport, this.#transport.gateway(route), request, signal);
  }
}

async function verifyAt(transport: FadenstackTransport, url: URL, request: VerifyRequest, signal?: AbortSignal): Promise<VerifyResult> {
  if ((typeof request.text === "string") === (typeof request.file === "string")) {
    throw new TypeError("Check either a text or a file (base64), not both and not neither.");
  }
  if (typeof request.file === "string" && !request.media_type) throw new TypeError("A file to check needs its media_type.");
  const answer = obj(await transport.post<unknown>(url, request, signal));
  if (!answer || typeof answer["verdict"] !== "string" || !Array.isArray(answer["findings"])) {
    throw new FadenstackError("The server's verify result is not in the provenance/v1 shape.");
  }
  return answer as unknown as VerifyResult;
}

/** A policy from the server, completed with the contract's defaults; a field of the wrong type takes its default. */
export function toProvenancePolicy(json: unknown): Required<ProvenancePolicy> {
  const p = obj(json) ?? {};
  const d = DEFAULT_PROVENANCE_POLICY;
  const tokens = p["short_text_tokens"];
  return {
    on_missing: p["on_missing"] === "refuse" ? "refuse" : "record",
    short_text_tokens: typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? Math.floor(tokens) : d.short_text_tokens,
    exempt_edit_kinds: Array.isArray(p["exempt_edit_kinds"]) ? p["exempt_edit_kinds"].filter(isEditKind) : [...d.exempt_edit_kinds],
    internal_technical: typeof p["internal_technical"] === "boolean" ? p["internal_technical"] : d.internal_technical,
    visible_label: typeof p["visible_label"] === "boolean" ? p["visible_label"] : d.visible_label,
    output_log: typeof p["output_log"] === "boolean" ? p["output_log"] : d.output_log,
  };
}

/** A signed record from the server, kept exactly as it came (its signature covers it); refused if it is not one. */
export function toSignedRecord(json: unknown): SignedRecord {
  const answer = obj(json);
  const record = obj(answer?.["record"]);
  if (!answer || !record || typeof record["id"] !== "string" || !record["id"] || typeof answer["signature"] !== "string") {
    throw new FadenstackError("The server's signed record is not in the provenance/v1 shape.");
  }
  return answer as unknown as SignedRecord;
}
