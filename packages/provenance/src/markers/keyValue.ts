import { Carriers, type ContentMarker, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";
import { FRONT_MATTER_KEYS } from "./markdownFrontMatter.js";

/** The two keys a key-value sink keeps: `ai-generated` (`true`) and `ai-record-id` (the record's id), as in front matter. */
export const KEY_VALUE_KEYS = FRONT_MATTER_KEYS;

/**
 * For a host that can keep strings with the content (a hidden CRM field, a ticket's custom field, an object's
 * metadata): the integrator passes a `KeyValueSink`, and after the insert this writes `ai-generated` = `true`, then
 * `ai-record-id` = the record's id -- the same two keys as front matter -- and reads the id back. A host with a single
 * field keeps the last write, the id. The server keeps the signed record; the id finds it.
 */
export class KeyValueMarker implements ContentMarker {
  readonly name = "key-value";
  readonly layer = "metadata";

  supports(sink: SinkInfo): boolean {
    return sink.carries.includes(Carriers.keyValue) && sink.keyValue !== undefined;
  }

  async attach(placed: PlacedContent, record: ProvenanceRecord): Promise<MarkOutcome> {
    const sink = placed.sink.keyValue!;
    await sink.write(KEY_VALUE_KEYS.aiGenerated, "true");
    await sink.write(KEY_VALUE_KEYS.record, record.id);
    const back = await sink.read(KEY_VALUE_KEYS.record);
    return back?.trim() === record.id
      ? { applied: true, method: this.name, verified: true }
      : { applied: false, method: this.name, reason: "stripped-by-host", detail: "the host did not keep the value" };
  }
}
