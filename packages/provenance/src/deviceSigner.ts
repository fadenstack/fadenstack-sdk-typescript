import {
  DerError, DerReader, Tag, bitString, explicit0, generalizedTime, minimal, objectIdentifier, sequence, set, smallInteger,
  unsignedInteger, utcTime, utf8String,
} from "./der.js";
import { openProvenanceDatabase, readKey, writeKeyIfAbsent } from "./deviceStore.js";

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const COORDINATE = 32; // P-256
const TYP = "faden-provenance+jws";
const KID_PREFIX = "device:";
const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";

/** Where the installation's key is kept: a database per principal (see `LocalProvenanceOptions`). */
export interface DeviceSignerStorage {
  /** The database's name; the provenance module uses `userStoreName("fadenstack-provenance", principal)`. */
  name: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`). */
  indexedDB?: IDBFactory | undefined;
  /** WebCrypto (default `globalThis.crypto`). */
  crypto?: Crypto | undefined;
}

/** What is kept of the key: the non-extractable private `CryptoKey` (structured clone) and its self-signed certificate. */
interface KeptKey {
  privateKey: CryptoKey;
  certificate: Uint8Array;
}

/**
 * Signs provenance records on the device (sdk/51 F10, owner 14 Nov), in the provenance engine's own format so one verifier
 * reads both: a compact JWS (RFC 7515, payload attached) over the record's canonical JSON (keys sorted, no spaces, UTF-8),
 * ES256 with a P-256 key, the header `{"alg":"ES256","typ":"faden-provenance+jws","kid":"device:...","x5c":[...]}`. The
 * `x5c` holds a self-signed certificate of the device's public key, so anyone can check the signature; the signer shows as
 * unknown, since no trust list names it. .NET: `DeviceSigner`.
 *
 * The key is one per principal in a browser profile, made on first use: a **non-extractable** WebCrypto key kept in the
 * principal's own IndexedDB database as a `CryptoKey` object. Script on the page can sign with it but never read its bytes;
 * the public key is exported for the certificate only. Where there is no IndexedDB (Node) the key lives in memory for as
 * long as the signer does and nothing is written. Never logged. OWASP ASVS 5.0 V11, V14.
 */
export class DeviceSigner {
  static readonly typ = TYP;
  /** The `kid` of a device's signature starts so: a server's names its key version instead. */
  static readonly kidPrefix = KID_PREFIX;

  readonly keyId: string;
  /** Whether the key is kept across runs (in IndexedDB); false: in memory only. */
  readonly persisted: boolean;
  readonly #key: CryptoKey;
  readonly #certificate: Uint8Array;
  readonly #crypto: Crypto;

  private constructor(key: CryptoKey, certificate: Uint8Array, keyId: string, persisted: boolean, webCrypto: Crypto) {
    this.#key = key;
    this.#certificate = certificate;
    this.#crypto = webCrypto;
    this.keyId = keyId;
    this.persisted = persisted;
  }

  /** The self-signed certificate of the public key, DER, as the JWS carries it. */
  get certificate(): Uint8Array {
    return this.#certificate.slice();
  }

  /**
   * The installation's signer: its key from the principal's database, or a new key stored there. Without IndexedDB, a key in
   * memory only. A stored key that is not a usable P-256 signing key (damaged, another format) is replaced; records signed
   * before keep their own public key, so they still verify.
   */
  static async forInstallation(storage: DeviceSignerStorage): Promise<DeviceSigner> {
    const webCrypto = storage.crypto ?? globalThis.crypto;
    const factory = storage.indexedDB ?? globalThis.indexedDB;
    if (!webCrypto?.subtle) throw new Error("WebCrypto is not available here; supply a DeviceSigner of your own.");
    if (!factory) return DeviceSigner.ephemeral(webCrypto);
    const db = await openProvenanceDatabase(factory, storage.name);
    try {
      const kept = await readKey(db);
      if (isUsable(kept)) {
        const signer = await DeviceSigner.#from(kept, true, webCrypto);
        if (signer) return signer;
      }
      const made = await DeviceSigner.#create(webCrypto);
      const chosen = await writeKeyIfAbsent(db, made.kept, (row) => isUsable(row));
      if (chosen === made.kept) return DeviceSigner.#signer(made.kept, made.keyId, true, webCrypto);
      // Another tab stored its key first: both use that one.
      return (await DeviceSigner.#from(chosen as KeptKey, true, webCrypto)) ?? DeviceSigner.#signer(made.kept, made.keyId, false, webCrypto);
    } finally {
      db.close();
    }
  }

  /** A signer whose key lives in memory only. */
  static async ephemeral(webCrypto: Crypto = globalThis.crypto): Promise<DeviceSigner> {
    if (!webCrypto?.subtle) throw new Error("WebCrypto is not available here.");
    const made = await DeviceSigner.#create(webCrypto);
    return DeviceSigner.#signer(made.kept, made.keyId, false, webCrypto);
  }

  static #signer(kept: KeptKey, keyId: string, persisted: boolean, webCrypto: Crypto): DeviceSigner {
    return new DeviceSigner(kept.privateKey, kept.certificate, keyId, persisted, webCrypto);
  }

  static async #from(kept: KeptKey, persisted: boolean, webCrypto: Crypto): Promise<DeviceSigner | undefined> {
    try {
      return DeviceSigner.#signer(kept, await keyIdOfAsync(publicPoint(kept.certificate), webCrypto), persisted, webCrypto);
    } catch {
      return undefined; // a certificate that does not read: the key is replaced
    }
  }

  static async #create(webCrypto: Crypto): Promise<{ kept: KeptKey; keyId: string }> {
    const pair = await webCrypto.subtle.generateKey(ES256, false, ["sign", "verify"]); // the private half is not extractable
    const point = new Uint8Array(await webCrypto.subtle.exportKey("raw", pair.publicKey)); // a public key always is
    const certificate = await selfSigned(pair.privateKey, point, webCrypto);
    return { kept: { privateKey: pair.privateKey, certificate }, keyId: await keyIdOfAsync(point, webCrypto) };
  }

  /** The compact JWS over `payload`'s canonical JSON. */
  async sign(payload: unknown): Promise<string> {
    const header = { alg: "ES256", typ: TYP, kid: this.keyId, x5c: [toBase64(this.#certificate)] };
    const input = `${toBase64Url(canonicalBytes(header))}.${toBase64Url(canonicalBytes(payload))}`;
    // WebCrypto's ECDSA signature is IEEE P1363, r || s: what a JWS wants.
    const signature = new Uint8Array(await this.#crypto.subtle.sign(SIGN, this.#key, ascii(input)));
    return `${input}.${toBase64Url(signature)}`;
  }

  /**
   * Checks a device's or a server's JWS with the key in its `x5c`: its payload when the signature matches, else null. It says
   * nothing about who signed: a device's certificate is on no trust list.
   */
  static async verify(jws: string, webCrypto: Crypto = globalThis.crypto): Promise<Record<string, unknown> | null> {
    try {
      const parts = (jws ?? "").split(".");
      if (parts.length !== 3) return null;
      const header: unknown = JSON.parse(utf8(fromBase64Url(parts[0]!)));
      if (typeof header !== "object" || header === null) return null;
      const { alg, x5c } = header as { alg?: unknown; x5c?: unknown };
      if (alg !== "ES256" || !Array.isArray(x5c) || x5c.length === 0 || typeof x5c[0] !== "string") return null;
      const signature = fromBase64Url(parts[2]!);
      if (signature.length !== 2 * COORDINATE) return null;
      const key = await webCrypto.subtle.importKey("spki", subjectPublicKeyInfo(fromBase64(x5c[0])) as BufferSource, ES256, false, ["verify"]);
      if (!(await webCrypto.subtle.verify(SIGN, key, signature as BufferSource, ascii(`${parts[0]}.${parts[1]}`)))) return null;
      const payload: unknown = JSON.parse(utf8(fromBase64Url(parts[1]!)));
      return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
    } catch {
      return null; // not base64, not JSON, not a certificate this platform reads, not a P-256 key
    }
  }

  /** The bytes of the signature part of a JWS (what an RFC 3161 time-stamp covers, as the engine's does). */
  static signatureBytes(jws: string): Uint8Array {
    return fromBase64Url(jws.slice(jws.lastIndexOf(".") + 1));
  }
}

function isUsable(row: unknown): row is KeptKey {
  const kept = row as Partial<KeptKey> | undefined;
  const key = kept?.privateKey;
  return !!kept && typeof key === "object" && key !== null && key.type === "private" && key.algorithm.name === "ECDSA"
    && (key.algorithm as EcKeyAlgorithm).namedCurve === "P-256" && key.usages.includes("sign") && kept.certificate instanceof Uint8Array;
}

// ---- the self-signed certificate ----

const name = (): Uint8Array => sequence(set(sequence(objectIdentifier("2.5.4.3"), utf8String("Fadenstack device signer"))));
const algorithm = (): Uint8Array => sequence(objectIdentifier(ECDSA_WITH_SHA256));

/**
 * A self-signed X.509 v3 certificate of the key (CN "Fadenstack device signer", valid for 30 years). It only carries the
 * public key: it vouches for nothing. The key signs it, so the private half is used, never exported.
 */
async function selfSigned(privateKey: CryptoKey, point: Uint8Array, webCrypto: Crypto): Promise<Uint8Array> {
  const serial = webCrypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0]! & 0x7f) | 0x01; // positive, and without a leading zero to strip
  const now = new Date();
  const notBefore = new Date(now.getTime() - 86_400_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 30);
  const toBeSigned = sequence(
    explicit0(smallInteger(2)), // v3
    unsignedInteger(serial),
    algorithm(),
    name(),
    sequence(utcTime(notBefore), generalizedTime(notAfter)),
    name(),
    sequence( // SubjectPublicKeyInfo
      sequence(objectIdentifier("1.2.840.10045.2.1"), objectIdentifier("1.2.840.10045.3.1.7")), // id-ecPublicKey, prime256v1
      bitString(point),
    ),
  );
  const raw = new Uint8Array(await webCrypto.subtle.sign(SIGN, privateKey, toBeSigned as BufferSource));
  // A DER integer has no redundant leading zero, and r or s starts with one about once in 256: trimmed (`minimal`).
  const signature = sequence(unsignedInteger(minimal(raw.slice(0, COORDINATE))), unsignedInteger(minimal(raw.slice(COORDINATE))));
  return sequence(toBeSigned, algorithm(), bitString(signature));
}

/** The certificate's `SubjectPublicKeyInfo`, whole. */
function subjectPublicKeyInfo(certificate: Uint8Array): Uint8Array {
  const toBeSigned = new DerReader(certificate).open(Tag.sequence).open(Tag.sequence);
  if (toBeSigned.peekTag() === Tag.context0) toBeSigned.next(); // version
  for (let i = 0; i < 5; i++) toBeSigned.next(); // serial, signature, issuer, validity, subject
  return toBeSigned.expect(Tag.sequence).raw;
}

/** The uncompressed public point (`04 || X || Y`) of the certificate's key. */
function publicPoint(certificate: Uint8Array): Uint8Array {
  const bits = new DerReader(subjectPublicKeyInfo(certificate)).open(Tag.sequence);
  bits.expect(Tag.sequence);
  const content = bits.expect(Tag.bitString).content;
  if (content.length !== 1 + 1 + 2 * COORDINATE || content[0] !== 0 || content[1] !== 4) throw new DerError("Not an uncompressed P-256 point.");
  return content.slice(1);
}

/** `device:` and the first 16 hex digits of the SHA-256 of the public point. */
async function keyIdOfAsync(point: Uint8Array, webCrypto: Crypto): Promise<string> {
  const hash = new Uint8Array(await webCrypto.subtle.digest("SHA-256", point as BufferSource));
  return KID_PREFIX + [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- canonical JSON and base64 ----

/**
 * The canonical JSON a signature covers: keys sorted (by UTF-16 code unit, as .NET sorts them ordinally), no spaces, characters
 * as they are (only what JSON requires is escaped), as the engine's `json.dumps(sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)`. A property whose value is `undefined` is left out.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((k) => object[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(object[k])}`).join(",")}}`;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

const ascii = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(text, (c) => c.charCodeAt(0));
const utf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(s + "=".repeat((4 - (s.length % 4)) % 4));
}
