import { PROVENANCE_CONTRACT } from "@fadenstack/client";

import { Carriers, type ContentMarker, type ExtensionValue, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/** The sidecar of `fileName`: `<fileName>.provenance.json`. */
export function sidecarName(fileName: string): string {
  return `${fileName}.provenance.json`;
}

/**
 * What a sidecar file holds, as compact JSON: the contract, the signed record as the server signed it (`record`,
 * `signature`, `timestamp`), and the integrator's facts where there are any. The .NET SDK writes the same.
 */
export function sidecarDocument(record: ProvenanceRecord): Record<string, unknown> {
  const facts: Record<string, ExtensionValue> = record.extensions;
  return {
    contract: PROVENANCE_CONTRACT,
    record: record.signed.record,
    signature: record.signed.signature,
    ...(record.signed.timestamp ? { timestamp: record.signed.timestamp } : {}),
    ...(Object.keys(facts).length ? { facts } : {}),
  };
}

/**
 * For files the agent writes where nothing else fits (a text file, a format with no metadata of its own): the signed
 * record in `<file>.provenance.json` beside the file (`sidecarDocument`), written after the file and read back where
 * the sink can be read. The sidecar holds no content and no name but its own.
 */
export class SidecarMarker implements ContentMarker {
  readonly name = "sidecar";
  readonly layer = "metadata";

  supports(sink: SinkInfo): boolean {
    return sink.carries.includes(Carriers.sidecar) && sink.sidecar !== undefined;
  }

  async attach(placed: PlacedContent, record: ProvenanceRecord): Promise<MarkOutcome> {
    const sink = placed.sink.sidecar!;
    if (!sink.fileName || /[\\/]/.test(sink.fileName)) throw new TypeError("A sidecar's fileName is a file's name, without a folder.");
    const name = sidecarName(sink.fileName);
    await sink.write(name, JSON.stringify(sidecarDocument(record)));
    if (!sink.read) return { applied: true, method: this.name, verified: false, detail: "not read back" };
    const back = await sink.read(name);
    try {
      const doc = back ? (JSON.parse(back) as { record?: { id?: unknown } }) : undefined;
      if (doc?.record?.id === record.id) return { applied: true, method: this.name, verified: true };
    } catch {
      // not JSON any more: the host changed it
    }
    return { applied: false, method: this.name, reason: "stripped-by-host" };
  }
}
