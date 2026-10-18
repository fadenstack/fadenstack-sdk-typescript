import { Carriers, type ContentMarker, type MarkableContent, type MarkOutcome, type PlacedContent, type ProvenanceRecord, type SinkInfo } from "../types.js";

/** The header that names the record of content served over HTTP. */
export const PROVENANCE_HEADER = "X-Faden-Provenance";

/**
 * For content an integration serves over HTTP: `X-Faden-Provenance` with the record's id, set before the host sends
 * the response (in `prepare`) and checked after (where the sink can read its headers).
 */
export class HttpHeaderMarker implements ContentMarker {
  readonly name = "http-header";
  readonly layer = "metadata";

  supports(sink: SinkInfo): boolean {
    return sink.carries.includes(Carriers.httpHeader) && sink.http !== undefined;
  }

  prepare(content: MarkableContent, record: ProvenanceRecord): MarkableContent {
    content.sink.http!.setHeader(PROVENANCE_HEADER, record.id);
    return content;
  }

  attach(placed: PlacedContent, record: ProvenanceRecord): MarkOutcome {
    const http = placed.sink.http!;
    if (!http.getHeader) return { applied: true, method: "http-header", verified: false };
    const value = http.getHeader(PROVENANCE_HEADER) ?? http.getHeader(PROVENANCE_HEADER.toLowerCase());
    const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [String(value)];
    return values.some((v) => String(v).split(",").map((s) => s.trim()).includes(record.id))
      ? { applied: true, method: "http-header" }
      : { applied: false, method: "http-header", reason: "stripped-by-host" };
  }
}
