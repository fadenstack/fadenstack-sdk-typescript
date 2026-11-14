import {
  DerReader, Tag, bool, equalBytes, integerBytes, integerNumber, minimal, nameBytes, nul, objectIdentifier, octetString, oidText,
  sequence, smallInteger, unsignedInteger, type DerNode,
} from "./der.js";
import {
  OID, hasExtendedKeyUsage, hashOfDigest, isCa, isSignedBy, parseCertificate, sameCertificate, subjectKeyIdentifier, validAt, verifySignature,
  type Certificate,
} from "./x509.js";

const SHA256 = "2.16.840.1.101.3.4.2.1";
const SIGNED_DATA = "1.2.840.113549.1.7.2";
const TST_INFO = "1.2.840.113549.1.9.16.1.4";
const CONTENT_TYPE = "1.2.840.113549.1.9.3";
const MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
/** The most certificates on a path from the signer to a trust anchor. */
const MAX_CHAIN = 6;
/** The most certificates an answer may carry: the chain walk tries each, so an answer cannot make it run long (DigiCert's has four). */
const MAX_CERTIFICATES = 16;

/**
 * The two RFC 3161 messages a device needs: a time-stamp request over a SHA-256 hash, and the check of the authority's answer.
 * The answer is input from outside (owner, 14 Nov): a token counts only when its signature, the authority's certificate and
 * the nonce all check out, and nothing in it ever throws past this object. A browser has no CMS or chain code, so this reads
 * the `SignedData` with the DER reader and checks the signatures with WebCrypto. .NET: `Rfc3161` (`SignedCms`, `X509Chain`).
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
   * Whether `response` (a `TimeStampResp`) grants a token that counts (sdk/51 F10; OWASP ASVS 5.0 V11): its CMS `SignedData`
   * has one signer, whose certificate carries the time-stamping purpose, whose signature over the signed attributes checks, and
   * whose chain ends at one of `roots` (DER certificates: the trust anchors, since a browser has no store of its own); and its
   * signed `TSTInfo` covers `sha256` with `nonce`. Revocation is not checked: the device may be offline. Anything else, a
   * malformed answer too, is false.
   */
  async grants(
    response: Uint8Array, sha256: Uint8Array, nonce: Uint8Array, roots: readonly Uint8Array[],
    webCrypto: Crypto = globalThis.crypto, now: Date = new Date(),
  ): Promise<boolean> {
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
      const tstInfo = encapsulated.open(Tag.context0).expect(Tag.octetString).content;
      const certificates: Certificate[] = [];
      if (signedData.peekTag() === Tag.context0) {
        const set = signedData.open(Tag.context0);
        while (set.hasData) {
          const node = set.next();
          if (node.tag !== Tag.sequence) continue; // another certificate choice
          try {
            certificates.push(parseCertificate(node.raw));
          } catch {
            // one certificate that does not read is one that is not there
          }
        }
      }
      if (certificates.length > MAX_CERTIFICATES) return false;
      if (signedData.peekTag() === Tag.context1) signedData.next(); // crls
      const signerInfos = signedData.open(Tag.set);
      const signerInfo = signerInfos.open(Tag.sequence);
      if (signerInfos.hasData || signedData.hasData) return false; // exactly one signer
      if (!(await signedBySigner(signerInfo, tstInfo, certificates, roots, webCrypto, now))) return false;
      return covers(tstInfo, sha256, nonce);
    } catch {
      return false; // a DerError, a WebCrypto error, or anything else a mangled answer causes: it does not count
    }
  },
});

/** The CMS part (RFC 5652 §5.3, RFC 3161 §2.4.2): the signed attributes, the signer's certificate, its signature and its chain. */
async function signedBySigner(
  signerInfo: DerReader, tstInfo: Uint8Array, certificates: readonly Certificate[], roots: readonly Uint8Array[], webCrypto: Crypto, now: Date,
): Promise<boolean> {
  signerInfo.expect(Tag.integer); // version
  const sid = signerInfo.next();
  const hash = hashOfDigest(oidText(new DerReader(signerInfo.expect(Tag.sequence).content).expect(Tag.objectIdentifier)));
  if (!hash) return false; // SHA-256, SHA-384 or SHA-512 only
  if (signerInfo.peekTag() !== Tag.context0) return false; // the signed attributes are required here
  const attributes = signerInfo.expect(Tag.context0);
  const signatureAlgorithm = oidText(new DerReader(signerInfo.expect(Tag.sequence).content).expect(Tag.objectIdentifier));
  const signature = signerInfo.expect(Tag.octetString).content;

  // One contentType (the TSTInfo) and one messageDigest (the digest of the TSTInfo's octets) among the signed attributes.
  const contentTypes: string[] = [];
  const digests: Uint8Array[] = [];
  const list = new DerReader(attributes.content);
  while (list.hasData) {
    const attribute = list.open(Tag.sequence);
    const type = oidText(attribute.expect(Tag.objectIdentifier));
    const values = attribute.open(Tag.set);
    if (type !== CONTENT_TYPE && type !== MESSAGE_DIGEST) continue;
    const value = values.next();
    if (values.hasData) return false; // one value each
    if (type === CONTENT_TYPE) contentTypes.push(oidText(value));
    else digests.push(value.tag === Tag.octetString ? value.content : new Uint8Array());
  }
  if (contentTypes.length !== 1 || contentTypes[0] !== TST_INFO || digests.length !== 1) return false;
  if (!equalBytes(digests[0]!, new Uint8Array(await webCrypto.subtle.digest(hash, tstInfo as BufferSource)))) return false;

  const signer = certificateOf(sid, certificates);
  if (!signer || !hasExtendedKeyUsage(signer, OID.timeStamping)) return false;

  // The signature is over the attributes as a SET (RFC 5652 §5.4): their [0] tag becomes the SET tag.
  const data = Uint8Array.from(attributes.raw);
  data[0] = Tag.set;
  if (!(await verifySignature(webCrypto, signer.spki, signatureAlgorithm, hash, data, signature))) return false;

  return chains(signer, certificates, anchors(roots), webCrypto, now);
}

/** The trust anchors that read; one that does not is left out, so it cannot take the others down with it. */
function anchors(roots: readonly Uint8Array[]): Certificate[] {
  const out: Certificate[] = [];
  for (const root of roots) {
    try {
      out.push(parseCertificate(root));
    } catch {
      // not a certificate: not an anchor
    }
  }
  return out;
}

/** The certificate a `sid` names: by issuer Name and serial number, or by subject key identifier. */
function certificateOf(sid: DerNode, certificates: readonly Certificate[]): Certificate | undefined {
  if (sid.tag === Tag.sequence) {
    const reader = new DerReader(sid.content);
    const issuer = nameBytes(reader.next());
    const serial = reader.expect(Tag.integer).content;
    return certificates.find((c) => equalBytes(c.issuer, issuer) && equalBytes(c.serial, serial));
  }
  if (sid.tag === Tag.context0Primitive) {
    return certificates.find((c) => {
      const id = subjectKeyIdentifier(c);
      return id !== undefined && equalBytes(id, sid.content);
    });
  }
  return undefined;
}

/**
 * From the signer's certificate up through `certificates` to a trust anchor in `roots` (the issuer's own certificate, or the
 * certificate itself): at each step the issuer Name is the next certificate's subject and its signature checks with that
 * certificate's key; every certificate that issues below the anchor is a CA; every certificate on the path, the anchor too, is
 * valid at `now`. At most six certificates, and none twice. No revocation check.
 */
async function chains(signer: Certificate, certificates: readonly Certificate[], roots: readonly Certificate[], webCrypto: Crypto, now: Date): Promise<boolean> {
  const walk = async (current: Certificate, path: readonly Certificate[]): Promise<boolean> => {
    if (!validAt(current, now)) return false;
    for (const root of roots) {
      if (sameCertificate(current, root)) return true;
      if (validAt(root, now) && (await isSignedBy(webCrypto, current, root))) return true;
    }
    if (path.length >= MAX_CHAIN) return false;
    for (const issuer of certificates) {
      if (path.some((c) => sameCertificate(c, issuer)) || !isCa(issuer) || !equalBytes(current.issuer, issuer.subject)) continue;
      if ((await isSignedBy(webCrypto, current, issuer)) && (await walk(issuer, [...path, issuer]))) return true;
    }
    return false;
  };
  return walk(signer, [signer]);
}

/** Whether a signed `TSTInfo` covers the hash with the nonce. */
function covers(tstInfo: Uint8Array, sha256: Uint8Array, nonce: Uint8Array): boolean {
  const info = new DerReader(tstInfo).open(Tag.sequence);
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
}
