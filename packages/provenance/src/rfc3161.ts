import {
  DerError, DerReader, Tag, bool, equalBytes, integerBytes, integerNumber, minimal, nul, objectIdentifier, octetString, oidText,
  sequence, smallInteger, unsignedInteger,
} from "./der.js";

const SHA256 = "2.16.840.1.101.3.4.2.1";
const SIGNED_DATA = "1.2.840.113549.1.7.2";
const TST_INFO = "1.2.840.113549.1.9.16.1.4";

/**
 * The two RFC 3161 messages a device needs: a time-stamp request over a SHA-256 hash, and the check that an answer grants a
 * token over that hash with that nonce. The token's own signature is the verifier's to check, as the provenance engine
 * leaves it. .NET: `Rfc3161`.
 */
export const Rfc3161 = Object.freeze({
  /** A `TimeStampReq`: version 1, the hash, the nonce, and the authority's certificate asked for. */
  request(sha256: Uint8Array, nonce: Uint8Array): Uint8Array {
    return sequence(
      smallInteger(1),
      sequence(sequence(objectIdentifier(SHA256), nul()), octetString(sha256)),
      unsignedInteger(minimal(nonce)),
      bool(true), // certReq
    );
  },

  /**
   * Whether `response` (a `TimeStampResp`) granted a token whose `TSTInfo` covers `sha256` with `nonce`. Anything else, a
   * malformed answer too, is false.
   */
  grants(response: Uint8Array, sha256: Uint8Array, nonce: Uint8Array): boolean {
    try {
      const resp = new DerReader(response).open(Tag.sequence);
      const status = integerNumber(resp.open(Tag.sequence).expect(Tag.integer));
      if (status !== 0 && status !== 1) return false; // granted, or granted with modifications; anything else is a refusal
      if (!resp.hasData) return false;
      const contentInfo = resp.open(Tag.sequence);
      if (oidText(contentInfo.expect(Tag.objectIdentifier)) !== SIGNED_DATA) return false;
      const signedData = contentInfo.open(Tag.context0).open(Tag.sequence);
      signedData.expect(Tag.integer); // version
      signedData.expect(Tag.set); // digestAlgorithms
      const encapsulated = signedData.open(Tag.sequence);
      if (oidText(encapsulated.expect(Tag.objectIdentifier)) !== TST_INFO) return false;
      const wrapped = encapsulated.open(Tag.context0);
      const info = new DerReader(wrapped.expect(Tag.octetString).content).open(Tag.sequence);
      info.expect(Tag.integer); // version
      info.expect(Tag.objectIdentifier); // policy
      const imprint = info.open(Tag.sequence);
      if (oidText(imprint.open(Tag.sequence).expect(Tag.objectIdentifier)) !== SHA256) return false;
      if (!equalBytes(imprint.expect(Tag.octetString).content, sha256)) return false;
      info.expect(Tag.integer); // serialNumber
      info.expect(Tag.generalizedTime); // genTime
      while (info.hasData) {
        if (info.peekTag() === Tag.integer) return equalBytes(integerBytes(info.next()), minimal(nonce));
        info.next(); // accuracy, ordering
      }
      return false; // we sent a nonce: an answer without it is not ours
    } catch (error) {
      if (error instanceof DerError) return false;
      throw error;
    }
  },
});
