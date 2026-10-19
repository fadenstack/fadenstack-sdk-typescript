import { DEFAULT_PROVENANCE_POLICY, type ProvenancePolicy, type ReceiptNote } from "@fadenstack/client";
import type { ToolServices } from "@fadenstack/agents";
import { Provenance, type Insert, type Placement, type PlaceRequest } from "@fadenstack/provenance";

import { toolServices } from "./tools.js";

export interface PassThroughProvenanceOptions {
  /** The policy `policy()` answers with: the contract's default, completed by these fields. */
  policy?: ProvenancePolicy;
  /** The receipt the call's answer had. */
  receipt?: ReceiptNote;
  /** The signal the inserts get; one that never aborts by default. */
  signal?: AbortSignal;
}

/**
 * A `Provenance` that puts content in as it is, for a tool run by hand in a test: `place()` keeps the request
 * (`requests`), calls the insert with the content unchanged and returns an unmarked placement -- no record, no
 * layers, nothing missing. No server, no marks, no reports. To test the marks themselves, run the tool in an agent
 * with the provenance module on a `FakeGateway`, or a marker with `checkMarker`.
 */
export class PassThroughProvenance implements Provenance {
  /** What the tool placed, in order. */
  readonly requests: PlaceRequest[] = [];
  readonly receipt: ReceiptNote | undefined;
  readonly #policy: Required<ProvenancePolicy>;
  readonly #signal: AbortSignal;

  constructor(options: PassThroughProvenanceOptions = {}) {
    this.receipt = options.receipt;
    this.#signal = options.signal ?? new AbortController().signal;
    this.#policy = {
      ...DEFAULT_PROVENANCE_POLICY,
      exempt_edit_kinds: [...DEFAULT_PROVENANCE_POLICY.exempt_edit_kinds],
      ...options.policy,
    } as Required<ProvenancePolicy>;
  }

  async place<T>(request: PlaceRequest, insert: Insert<T>): Promise<Placement<Awaited<T>>> {
    this.requests.push(request);
    const result = await insert({ content: request.content, mediaType: request.mediaType, sink: request.sink }, this.#signal);
    return Object.freeze({
      result, recordId: undefined, signed: false, exempt: false, reason: undefined, exemptBecause: undefined,
      editKind: request.editKind ?? "generated", layers: Object.freeze([]), missing: Object.freeze([]),
    });
  }

  async policy(): Promise<Required<ProvenancePolicy>> {
    return { ...this.#policy, exempt_edit_kinds: [...this.#policy.exempt_edit_kinds] };
  }
}

/**
 * Tool services that give a hand-built call `provenance` (a new `PassThroughProvenance` by default) for the
 * provenance module's key, so `provenanceOf(context)` works: `toolContext({ services: provenanceServices() })`.
 */
export function provenanceServices(provenance: Provenance = new PassThroughProvenance()): ToolServices {
  return toolServices([Provenance, provenance]);
}
