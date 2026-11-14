import { DerError, DerReader, Tag, equalBytes, integerBytes, nameBytes, oidText, readTime, type DerNode } from "./der.js";

/**
 * The X.509 bits a time-stamp token's check needs (sdk/51 F10; OWASP ASVS 5.0 V11 cryptography): a certificate read apart, and
 * a signature checked with a certificate's key through WebCrypto. A browser has no certificate store and no chain builder,
 * so the check reads certificates itself; .NET uses `X509Chain` for this. Everything here throws a `DerError` (or WebCrypto's
 * own error) on what it cannot read, and the caller turns that into "does not count".
 */

export const OID = Object.freeze({
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  sha384WithRsa: "1.2.840.113549.1.1.12",
  sha512WithRsa: "1.2.840.113549.1.1.13",
  ecPublicKey: "1.2.840.10045.2.1",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  ecdsaWithSha384: "1.2.840.10045.4.3.3",
  ecdsaWithSha512: "1.2.840.10045.4.3.4",
  prime256v1: "1.2.840.10045.3.1.7",
  secp384r1: "1.3.132.0.34",
  secp521r1: "1.3.132.0.35",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  subjectKeyIdentifier: "2.5.29.14",
  basicConstraints: "2.5.29.19",
  extendedKeyUsage: "2.5.29.37",
  timeStamping: "1.3.6.1.5.5.7.3.8",
});

export type HashName = "SHA-256" | "SHA-384" | "SHA-512";

/** The hash a digest algorithm identifier names (SHA-256, SHA-384 or SHA-512); undefined for any other. */
export function hashOfDigest(oid: string): HashName | undefined {
  return oid === OID.sha256 ? "SHA-256" : oid === OID.sha384 ? "SHA-384" : oid === OID.sha512 ? "SHA-512" : undefined;
}

/** A certificate read apart. The byte fields are slices of the DER it was read from. */
export interface Certificate {
  /** The whole certificate. */
  readonly raw: Uint8Array;
  /** The `tbsCertificate`, whole (what the issuer signed). */
  readonly tbs: Uint8Array;
  /** The issuer Name, whole (tag, length, content). */
  readonly issuer: Uint8Array;
  /** The subject Name, whole. */
  readonly subject: Uint8Array;
  /** The serial number's content bytes, as encoded. */
  readonly serial: Uint8Array;
  /** The `SubjectPublicKeyInfo`, whole. */
  readonly spki: Uint8Array;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** The extensions by object identifier: the extension's value (the OCTET STRING's content). */
  readonly extensions: ReadonlyMap<string, Uint8Array>;
  /** The outer `signatureAlgorithm`'s object identifier. */
  readonly signatureAlgorithm: string;
  /** The signature (the BIT STRING's bytes). */
  readonly signature: Uint8Array;
}

export function parseCertificate(der: Uint8Array): Certificate {
  const certificate = new DerReader(der).open(Tag.sequence);
  const tbsNode = certificate.expect(Tag.sequence);
  const algorithm = new DerReader(certificate.expect(Tag.sequence).content);
  const signature = bitStringBytes(certificate.expect(Tag.bitString));
  const tbs = new DerReader(tbsNode.content);
  if (tbs.peekTag() === Tag.context0) tbs.next(); // version
  const serial = tbs.expect(Tag.integer).content;
  tbs.expect(Tag.sequence); // signature
  const issuer = nameBytes(tbs.next());
  const validity = tbs.open(Tag.sequence);
  const notBefore = readTime(validity.next());
  const notAfter = readTime(validity.next());
  const subject = nameBytes(tbs.next());
  const spki = tbs.expect(Tag.sequence).raw;
  const extensions = new Map<string, Uint8Array>();
  while (tbs.hasData) {
    const node = tbs.next();
    if (node.tag !== Tag.context3) continue; // issuerUniqueID, subjectUniqueID
    const list = new DerReader(node.content).open(Tag.sequence);
    while (list.hasData) {
      const extension = list.open(Tag.sequence);
      const oid = oidText(extension.expect(Tag.objectIdentifier));
      if (extension.peekTag() === Tag.boolean) extension.next(); // critical
      extensions.set(oid, extension.expect(Tag.octetString).content);
    }
  }
  return {
    raw: der, tbs: tbsNode.raw, issuer, subject, serial, spki, notBefore, notAfter, extensions,
    signatureAlgorithm: oidText(algorithm.expect(Tag.objectIdentifier)), signature,
  };
}

function bitStringBytes(node: DerNode): Uint8Array {
  if (node.content.length === 0 || node.content[0] !== 0) throw new DerError("A signature has no unused bits.");
  return node.content.subarray(1);
}

/** Whether the certificate says `cA` in its basic constraints (RFC 5280 §4.2.1.9); without the extension, it is not a CA. */
export function isCa(certificate: Certificate): boolean {
  const value = certificate.extensions.get(OID.basicConstraints);
  if (!value) return false;
  const constraints = new DerReader(value).open(Tag.sequence);
  return constraints.hasData && constraints.peekTag() === Tag.boolean && constraints.next().content[0] !== 0;
}

/** Whether the certificate's extended key usage names `purpose` (an object identifier). */
export function hasExtendedKeyUsage(certificate: Certificate, purpose: string): boolean {
  const value = certificate.extensions.get(OID.extendedKeyUsage);
  if (!value) return false;
  const usages = new DerReader(value).open(Tag.sequence);
  while (usages.hasData) if (oidText(usages.expect(Tag.objectIdentifier)) === purpose) return true;
  return false;
}

/** The subject key identifier extension's key id, or undefined. */
export function subjectKeyIdentifier(certificate: Certificate): Uint8Array | undefined {
  const value = certificate.extensions.get(OID.subjectKeyIdentifier);
  return value ? new DerReader(value).expect(Tag.octetString).content : undefined;
}

/** Whether the certificate is valid at `at` (`notBefore` and `notAfter` included). */
export const validAt = (certificate: Certificate, at: Date): boolean => certificate.notBefore <= at && at <= certificate.notAfter;

export const sameCertificate = (a: Certificate, b: Certificate): boolean => equalBytes(a.raw, b.raw);

const ECDSA_HASH: Readonly<Record<string, HashName>> = {
  [OID.ecdsaWithSha256]: "SHA-256", [OID.ecdsaWithSha384]: "SHA-384", [OID.ecdsaWithSha512]: "SHA-512",
};
const RSA_HASH: Readonly<Record<string, HashName>> = {
  [OID.sha256WithRsa]: "SHA-256", [OID.sha384WithRsa]: "SHA-384", [OID.sha512WithRsa]: "SHA-512",
};
const CURVES: Readonly<Record<string, { name: "P-256" | "P-384" | "P-521"; size: number }>> = {
  [OID.prime256v1]: { name: "P-256", size: 32 }, [OID.secp384r1]: { name: "P-384", size: 48 }, [OID.secp521r1]: { name: "P-521", size: 66 },
};

/**
 * Whether `signature` is `signatureAlgorithm`'s signature over `data` by the key in `spki`. RSA PKCS#1 v1.5 (`rsaEncryption`
 * with `digestHash`, or sha256, sha384 or sha512 with RSA) and ECDSA (with SHA-256, 384 or 512) on P-256, P-384 or P-521; any
 * other algorithm, RSA-PSS too, is false. An ECDSA signature is a DER `SEQUENCE { r, s }`, which WebCrypto wants as the fixed
 * length `r || s`. A signature that does not match is false; a key or signature that cannot be read throws.
 */
export async function verifySignature(
  webCrypto: Crypto, spki: Uint8Array, signatureAlgorithm: string, digestHash: HashName | undefined, data: Uint8Array, signature: Uint8Array,
): Promise<boolean> {
  const info = new DerReader(spki).open(Tag.sequence);
  const keyAlgorithm = new DerReader(info.expect(Tag.sequence).content);
  const keyType = oidText(keyAlgorithm.expect(Tag.objectIdentifier));
  if (keyType === OID.rsaEncryption) {
    const hash = signatureAlgorithm === OID.rsaEncryption ? digestHash : RSA_HASH[signatureAlgorithm];
    if (!hash) return false;
    const key = await webCrypto.subtle.importKey("spki", spki as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
    return webCrypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature as BufferSource, data as BufferSource);
  }
  if (keyType === OID.ecPublicKey) {
    const hash = ECDSA_HASH[signatureAlgorithm];
    const curve = keyAlgorithm.hasData ? CURVES[oidText(keyAlgorithm.expect(Tag.objectIdentifier))] : undefined;
    if (!hash || !curve) return false;
    const pair = new DerReader(signature).open(Tag.sequence);
    const r = integerBytes(pair.expect(Tag.integer));
    const s = integerBytes(pair.expect(Tag.integer));
    if (pair.hasData || r.length > curve.size || s.length > curve.size) return false;
    const fixed = new Uint8Array(2 * curve.size);
    fixed.set(r, curve.size - r.length);
    fixed.set(s, 2 * curve.size - s.length);
    const key = await webCrypto.subtle.importKey("spki", spki as BufferSource, { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
    return webCrypto.subtle.verify({ name: "ECDSA", hash }, key, fixed as BufferSource, data as BufferSource);
  }
  return false;
}

/** Whether `certificate` was signed by `issuer`: its issuer Name is the issuer's subject, and the signature checks with the issuer's key. */
export async function isSignedBy(webCrypto: Crypto, certificate: Certificate, issuer: Certificate): Promise<boolean> {
  if (!equalBytes(certificate.issuer, issuer.subject)) return false;
  return verifySignature(webCrypto, issuer.spki, certificate.signatureAlgorithm, undefined, certificate.tbs, certificate.signature);
}
