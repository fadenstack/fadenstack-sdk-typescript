import type { ContentMarker, MarkOutcome, ProvenanceRecord } from "../types.js";

/**
 * Says whether the server signed the placement's record: the record is kept on the server, with the content's keyed
 * hash, for the detector. It is no mark in the content (`carrier` false): the content carries the record's id where
 * a host marker puts it. Pictures and files carry their own signed metadata (C2PA), from the server.
 */
export class ServerSignedMarker implements ContentMarker {
  readonly name = "server-signed";
  readonly layer = "metadata";
  readonly carrier = false;

  supports(): boolean {
    return true;
  }

  attach(_placed: unknown, record: ProvenanceRecord): MarkOutcome {
    return record.signed ? { applied: true, method: "signed-record" } : { applied: false, method: "signed-record", reason: "server-unavailable" };
  }
}
