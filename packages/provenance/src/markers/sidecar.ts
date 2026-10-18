import { PROVENANCE_CONTRACT } from "@fadenstack/client";

import { Carriers, type ContentMarker, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/** The sidecar of `fileName`: `<fileName>.provenance.json`. */
export function sidecarName(fileName: string): string {
  return `${fileName}.provenance.json`;
}

/** What a sidecar file holds: that the file is AI-generated, its record's id, and the record as the server signed it. */
export function sidecarDocument(record: ProvenanceRecord): Record<string, unknown> {
  return {
    contract: PROVENANCE_CONTRACT,
    ai_generated: true,
    record_id: record.id,
    edit_kind: record.editKind,
    digital_source_type: record.digitalSourceType,
    media_type: record.mediaType,
    signed_record: record.signed ?? null,
    extensions: record.extensions,
  };
}

/**
 * For files the agent writes where nothing else fits (a text file, a format with no metadata of its own): the signed
 * record in `<file>.provenance.json` beside the file, written after the file and read back where the sink can be
 * read. The sidecar holds no content and no name but its own.
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
    await sink.write(name, `${JSON.stringify(sidecarDocument(record), null, 2)}\n`);
    if (!sink.read) return { applied: true, method: "sidecar", verified: false };
    const back = await sink.read(name);
    try {
      if (back && (JSON.parse(back) as Record<string, unknown>)["record_id"] === record.id) return { applied: true, method: "sidecar" };
    } catch {
      // not JSON any more: the host changed it
    }
    return { applied: false, method: "sidecar", reason: "stripped-by-host" };
  }
}
