import {
  DerReader, Tag, bitString, bool, concat, explicit0, generalizedTime, integerBytes, minimal, nul, objectIdentifier, octetString, sequence, set,
  smallInteger, tlv, unsignedInteger, utcTime, utf8String,
} from "../src/der.js";

/**
 * A real time-stamp authority for the tests, made with WebCrypto and the DER writer (sdk/51 F10; .NET: `TestAuthority` in
 * LocalProvenanceTests): a root CA (ECDSA P-256, self-signed), an intermediate CA (ECDSA P-384), and a TSA certificate (RSA 2048,
 * PKCS#1 v1.5, the time-stamping purpose) it signs the token with. `answer` reads a `TimeStampReq` and returns a `TimeStampResp`
 * holding a CMS `SignedData` over a `TSTInfo`, with signed attributes, the certificates and an IssuerAndSerialNumber. The
 * options break one thing at a time.
 */
const OID = {
  sha256: "2.16.840.1.101.3.4.2.1",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  ecdsaWithSha384: "1.2.840.10045.4.3.3",
  commonName: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  extendedKeyUsage: "2.5.29.37",
  subjectKeyIdentifier: "2.5.29.14",
  timeStamping: "1.3.6.1.5.5.7.3.8",
};

/** Which certificate chain the token carries. */
export type ChainKind = "root" | "intermediate" | "intermediateNotCa" | "untrusted" | "noEku" | "expired";

export interface AnswerOptions {
  /** Flips a byte in the signature. */
  tamper?: boolean;
  /** Answers over another hash than the one asked for. */
  wrongHash?: boolean;
  /** Answers with another nonce than the one sent. */
  wrongNonce?: boolean;
  /** The `PKIStatus`; 2 and above is a refusal, with no token. */
  status?: number;
  /** The certificate the TSA signs with (default `root`: issued by the trusted root). */
  chain?: ChainKind;
  /** The signer is named by its subject key identifier instead of issuer and serial number. */
  subjectKeyIdentifier?: boolean;
  /** The CMS's signed attributes name another content type than the TSTInfo. */
  wrongContentType?: boolean;
  /** The CMS's message digest is not the digest of the TSTInfo. */
  wrongMessageDigest?: boolean;
  /** The token is not signed over its attributes: no signed attributes at all. */
  noSignedAttributes?: boolean;
}

type TsaSet = Readonly<Record<ChainKind, { signer: Uint8Array; others: Uint8Array[] }>>;

interface CertificateOptions {
  serial: number;
  subject: string;
  issuer: string;
  spki: Uint8Array;
  signWith: { key: CryptoKey; kind: "p256" | "p384" };
  notBefore: Date;
  notAfter: Date;
  ca: boolean;
  timeStamping: boolean;
  keyId?: Uint8Array;
}

const name = (cn: string): Uint8Array => sequence(set(sequence(objectIdentifier(OID.commonName), utf8String(cn))));
const signatureAlgorithm = (kind: "p256" | "p384" | "rsa"): Uint8Array =>
  kind === "rsa" ? sequence(objectIdentifier(OID.sha256WithRsa), nul()) : sequence(objectIdentifier(kind === "p256" ? OID.ecdsaWithSha256 : OID.ecdsaWithSha384));

const toDerSignature = (raw: Uint8Array): Uint8Array => {
  const half = raw.length / 2;
  return sequence(unsignedInteger(minimal(raw.slice(0, half))), unsignedInteger(minimal(raw.slice(half))));
};

async function certificate(o: CertificateOptions): Promise<Uint8Array> {
  const extensions: Uint8Array[] = [];
  if (o.ca) extensions.push(sequence(objectIdentifier(OID.basicConstraints), bool(true), octetString(sequence(bool(true)))));
  if (o.timeStamping) extensions.push(sequence(objectIdentifier(OID.extendedKeyUsage), bool(true), octetString(sequence(objectIdentifier(OID.timeStamping)))));
  if (o.keyId) extensions.push(sequence(objectIdentifier(OID.subjectKeyIdentifier), octetString(octetString(o.keyId))));
  const toBeSigned = sequence(
    explicit0(smallInteger(2)),
    unsignedInteger(minimal(Uint8Array.of(o.serial))),
    signatureAlgorithm(o.signWith.kind),
    name(o.issuer),
    sequence(utcTime(o.notBefore), generalizedTime(o.notAfter)),
    name(o.subject),
    o.spki,
    tlv(Tag.context3, sequence(...extensions)),
  );
  const algorithm = o.signWith.kind === "p256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "ECDSA", hash: "SHA-384" };
  const raw = new Uint8Array(await crypto.subtle.sign(algorithm, o.signWith.key, toBeSigned as BufferSource));
  return sequence(toBeSigned, signatureAlgorithm(o.signWith.kind), bitString(toDerSignature(raw)));
}

async function ecKey(curve: "P-256" | "P-384"): Promise<{ key: CryptoKey; spki: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, false, ["sign", "verify"]);
  return { key: pair.privateKey, spki: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)) };
}

export class TestAuthority {
  /** The trusted root's certificate, DER: the `timestampRoots` of a backend that trusts this authority. */
  readonly root: Uint8Array;
  /** The root nobody trusts. */
  readonly otherRoot: Uint8Array;
  readonly #tsaKey: CryptoKey;
  readonly #tsa: TsaSet;
  readonly #keyId: Uint8Array;
  #serial = 1000;

  private constructor(root: Uint8Array, otherRoot: Uint8Array, tsaKey: CryptoKey, tsa: TsaSet, keyId: Uint8Array) {
    this.root = root;
    this.otherRoot = otherRoot;
    this.#tsaKey = tsaKey;
    this.#tsa = tsa;
    this.#keyId = keyId;
  }

  static async create(): Promise<TestAuthority> {
    const now = Date.now();
    const day = 86_400_000;
    const valid = { notBefore: new Date(now - 30 * day), notAfter: new Date(now + 365 * day) };
    const rootKey = await ecKey("P-256");
    const otherKey = await ecKey("P-256");
    const intermediateKey = await ecKey("P-384");
    const badIntermediateKey = await ecKey("P-384");
    const root = await certificate({ serial: 1, subject: "Test Root", issuer: "Test Root", spki: rootKey.spki, signWith: { key: rootKey.key, kind: "p256" }, ...valid, ca: true, timeStamping: false });
    const otherRoot = await certificate({ serial: 2, subject: "Other Root", issuer: "Other Root", spki: otherKey.spki, signWith: { key: otherKey.key, kind: "p256" }, ...valid, ca: true, timeStamping: false });
    const intermediate = await certificate({ serial: 3, subject: "Test Intermediate", issuer: "Test Root", spki: intermediateKey.spki, signWith: { key: rootKey.key, kind: "p256" }, ...valid, ca: true, timeStamping: false });
    const badIntermediate = await certificate({ serial: 4, subject: "Test Not A CA", issuer: "Test Root", spki: badIntermediateKey.spki, signWith: { key: rootKey.key, kind: "p256" }, ...valid, ca: false, timeStamping: false });

    // The TSA's RSA key, one for every variant of its certificate.
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }, false, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const keyId = new Uint8Array(await crypto.subtle.digest("SHA-1", spki as BufferSource));
    const tsa = (serial: number, issuer: string, signWith: CertificateOptions["signWith"], over: Partial<CertificateOptions> = {}) =>
      certificate({ serial, subject: "Test TSA", issuer, spki, signWith, ...valid, ca: false, timeStamping: true, keyId, ...over });
    const byRoot = { key: rootKey.key, kind: "p256" } as const;
    const tsaSet: TsaSet = {
      root: { signer: await tsa(10, "Test Root", byRoot), others: [] },
      intermediate: { signer: await tsa(11, "Test Intermediate", { key: intermediateKey.key, kind: "p384" }), others: [intermediate] },
      intermediateNotCa: { signer: await tsa(12, "Test Not A CA", { key: badIntermediateKey.key, kind: "p384" }), others: [badIntermediate] },
      untrusted: { signer: await tsa(13, "Other Root", { key: otherKey.key, kind: "p256" }), others: [otherRoot] },
      noEku: { signer: await tsa(14, "Test Root", byRoot, { timeStamping: false }), others: [] },
      expired: { signer: await tsa(15, "Test Root", byRoot, { notBefore: new Date(now - 60 * day), notAfter: new Date(now - day) }), others: [] },
    };
    return new TestAuthority(root, otherRoot, pair.privateKey, tsaSet, keyId);
  }

  /** The answer to a `TimeStampReq`. */
  async answer(requestBytes: Uint8Array, options: AnswerOptions = {}): Promise<Uint8Array> {
    const request = new DerReader(requestBytes).open(Tag.sequence);
    request.expect(Tag.integer); // version
    const imprint = request.open(Tag.sequence);
    imprint.expect(Tag.sequence);
    const hash = imprint.expect(Tag.octetString).content.slice();
    const nonce = Uint8Array.from(integerBytes(request.expect(Tag.integer)));
    const status = options.status ?? 0;
    if (status >= 2) return sequence(sequence(smallInteger(status)));

    const answeredHash = options.wrongHash ? hash.map((b) => b ^ 0xff) : hash;
    const answeredNonce = options.wrongNonce ? minimal(Uint8Array.from([...nonce.slice(0, -1), nonce[nonce.length - 1]! ^ 0x01])) : nonce;
    const info = sequence(
      smallInteger(1), objectIdentifier("1.2.3.4"),
      sequence(sequence(objectIdentifier(OID.sha256)), octetString(answeredHash)),
      unsignedInteger(minimal(Uint8Array.of((this.#serial >> 8) & 0x7f, this.#serial++ & 0xff))),
      generalizedTime(new Date()),
      unsignedInteger(answeredNonce),
    );
    const chain = this.#tsa[options.chain ?? "root"];

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", info as BufferSource));
    const attributes = concat(
      sequence(objectIdentifier(OID.contentType), set(objectIdentifier(options.wrongContentType ? "1.2.840.113549.1.7.1" : OID.tstInfo))),
      sequence(objectIdentifier(OID.messageDigest), set(octetString(options.wrongMessageDigest ? digest.map((b) => b ^ 0x01) : digest))),
    );
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, this.#tsaKey, tlv(Tag.set, attributes) as BufferSource));
    if (options.tamper) signature[Math.floor(signature.length / 2)]! ^= 0x01;

    const signer = new DerReader(chain.signer).open(Tag.sequence).open(Tag.sequence);
    signer.expect(Tag.context0); // version
    const serial = signer.expect(Tag.integer);
    signer.next();
    const issuer = signer.next();
    const sid = options.subjectKeyIdentifier ? tlv(Tag.context0Primitive, this.#keyId) : sequence(issuer.raw, serial.raw);
    const signerInfo = sequence(
      smallInteger(options.subjectKeyIdentifier ? 3 : 1), sid,
      sequence(objectIdentifier(OID.sha256), nul()),
      ...(options.noSignedAttributes ? [] : [tlv(Tag.context0, attributes)]),
      sequence(objectIdentifier(OID.sha256WithRsa), nul()),
      octetString(signature),
    );
    const signedData = sequence(
      smallInteger(3), set(sequence(objectIdentifier(OID.sha256))),
      sequence(objectIdentifier(OID.tstInfo), explicit0(octetString(info))),
      tlv(Tag.context0, concat(chain.signer, ...chain.others)),
      set(signerInfo),
    );
    return sequence(sequence(smallInteger(status)), sequence(objectIdentifier(OID.signedData), explicit0(signedData)));
  }
}

/** A fake `fetch` around the authority: records what it was asked, and can be taken offline. */
export class TsaFake {
  readonly requests: { contentType: string | null; body: Uint8Array; hash: Uint8Array; url: string }[] = [];
  down = false;
  options: AnswerOptions = {};
  /** When set, an answer waits for this promise first (to hold a round open). */
  gate: Promise<void> | undefined;
  readonly #authority: TestAuthority;

  constructor(authority: TestAuthority) {
    this.#authority = authority;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError("fetch failed");
    const body = init!.body as Uint8Array;
    const req = new DerReader(body).open(Tag.sequence);
    req.expect(Tag.integer);
    const imprint = req.open(Tag.sequence);
    imprint.expect(Tag.sequence);
    const hash = imprint.expect(Tag.octetString).content.slice();
    this.requests.push({ contentType: new Headers(init!.headers).get("content-type"), body, hash, url: String(input) });
    if (this.gate) await this.gate;
    return new Response(await this.#authority.answer(body, this.options) as BodyInit, { status: 200 });
  };
}
