import { Carriers, type ContentMarker, type MarkableContent, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/**
 * The header that names the record of content served over HTTP, and of a mail draft: `X-AI-Generated: <record id>`.
 * (`X-Faden-Provenance` is the gateway's header with an answer's receipt ids, not a mark.)
 */
export const AI_GENERATED_HEADER = "X-AI-Generated";

/**
 * For content an integration serves over HTTP: `X-AI-Generated` with the record's id, set before the host sends the
 * response (in `prepare`) and read back after (where the sink can read its headers).
 */
export class HttpHeaderMarker implements ContentMarker {
  readonly name = "http-header";
  readonly layer = "metadata";

  supports(sink: SinkInfo): boolean {
    return sink.carries.includes(Carriers.httpHeader) && sink.http !== undefined;
  }

  prepare(content: MarkableContent, record: ProvenanceRecord): MarkableContent {
    content.sink.http!.setHeader(AI_GENERATED_HEADER, record.id);
    return content;
  }

  attach(placed: PlacedContent, record: ProvenanceRecord): MarkOutcome {
    const http = placed.sink.http!;
    if (!http.getHeader) return { applied: true, method: this.name, verified: false, detail: "not read back" };
    const value = http.getHeader(AI_GENERATED_HEADER) ?? http.getHeader(AI_GENERATED_HEADER.toLowerCase());
    const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [String(value)];
    return values.some((v) => String(v).split(",").map((s) => s.trim()).includes(record.id))
      ? { applied: true, method: this.name, verified: true }
      : { applied: false, method: this.name, reason: "stripped-by-host" };
  }
}
