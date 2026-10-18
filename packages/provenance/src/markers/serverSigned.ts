import type { ContentMarker, MarkOutcome, ProvenanceRecord } from "../types.js";

/** The method a placement report names the server's signed record by. */
export const SIGNED_RECORD_METHOD = "signed-record";

/**
 * Says the server signed the placement's record: the record is kept on the server, with the content's keyed hash,
 * for the detector. It is no mark in the content (`carrier` false): where the content lands in a container, a host
 * marker is needed as well. It runs only with a signed record (as every marker); without one the pipeline reports
 * `signed-record` not applied, `server-unavailable`.
 */
export class ServerSignedMarker implements ContentMarker {
  readonly name = "server-record";
  readonly layer = "metadata";
  readonly carrier = false;

  supports(): boolean {
    return true;
  }

  attach(_placed: unknown, record: ProvenanceRecord): MarkOutcome {
    return { applied: true, method: SIGNED_RECORD_METHOD, detail: record.signed.timestamp ? "signed, time-stamped" : "signed" };
  }
}
