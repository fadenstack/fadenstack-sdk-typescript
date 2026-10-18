import { Carriers, type ContentMarker, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/** The key a record is kept under in a key-value sink, unless the marker is given another. */
export const KEY_VALUE_KEY = "ai-generated-record";

export interface KeyValueMarkerOptions {
  /** The key to write (`ai-generated-record` by default); a sink with one field may ignore it. */
  key?: string;
}

/**
 * For a host that can keep one string with the content (a hidden CRM field, a ticket's custom field, an object's
 * metadata): the integrator passes a `KeyValueSink`, and this writes the record's id there -- the signed record
 * itself where it fits (`KeyValueSink.maxLength`) -- after the insert, then reads it back.
 */
export class KeyValueMarker implements ContentMarker {
  readonly name = "key-value";
  readonly layer = "metadata";
  readonly key: string;

  constructor(options: KeyValueMarkerOptions = {}) {
    this.key = options.key ?? KEY_VALUE_KEY;
  }

  supports(sink: SinkInfo): boolean {
    return sink.carries.includes(Carriers.keyValue) && sink.keyValue !== undefined;
  }

  async attach(placed: PlacedContent, record: ProvenanceRecord): Promise<MarkOutcome> {
    const sink = placed.sink.keyValue!;
    const signed = record.signed ? JSON.stringify(record.signed) : undefined;
    const value = signed !== undefined && sink.maxLength !== undefined && signed.length <= sink.maxLength ? signed : record.id;
    await sink.write(this.key, value);
    const back = await sink.read(this.key);
    if (back === value) return { applied: true, method: "key-value" };
    return { applied: false, method: "key-value", reason: "stripped-by-host" };
  }
}
