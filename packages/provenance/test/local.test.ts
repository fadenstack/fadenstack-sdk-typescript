import { X509Certificate, createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";

import { EndpointDialect, StaticTokenProvider, textSha256, type PlacementReport, type RecordRequest } from "@fadenstack/client";
import {
  AgentDefinition, FadenstackAgent, MachinePolicy, MemoryApprovalStore, MemorySessionStore, StageOrder, TimestampingPolicy, defineTool,
} from "@fadenstack/agents";
import {
  AUTHORITY_TIME, DEFAULT_TIMESTAMP_AUTHORITY, DEVICE_CLOCK_TIME, DIGICERT_TIMESTAMP_ROOTS, DeviceSigner, LocalProvenanceBackend, MemoryBackend,
  Rfc3161, canonicalJson, provenanceModule, provenanceOf, type LocalProvenanceContext, type LocalProvenanceOptions, type Placement, type ProvenanceBackend,
} from "@fadenstack/provenance";
import { OpenAiFake } from "@fadenstack/testing";

import { DerReader, Tag, minimal, unsignedInteger } from "../src/der.js";
import { DIGICERT_TRUSTED_ROOT_G4_SHA256 } from "../src/timestampRoots.js";
import { Editor, LONG } from "./helpers.js";
import { TestAuthority, TsaFake, type AnswerOptions } from "./tsaAuthority.js";

/**
 * sdk/51 F10: the device's own provenance backend, records signed on the device, the time-stamp, the local log. Port of the
 * .NET LocalProvenanceTests (ac6d9ac and 53f6b6f). Not ported, because a browser has none of it: the key file, the OS key
 * store's protector and a file the user cannot read (the key lives in IndexedDB as a non-extractable CryptoKey instead:
 * tested as such below), and the file log's byte size rotation (the log rotates by entries).
 */
const request = (): RecordRequest => ({ content_sha256: "a".repeat(64), media_type: "text/plain", edit_kind: "generated", model: "qwen3:14b" });

const signal = () => new AbortController().signal;
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");


let authority: TestAuthority;
beforeAll(async () => {
  authority = await TestAuthority.create();
});

/** A backend that trusts the test authority, and its fake `fetch`. */
function withTsa(options: LocalProvenanceOptions = {}): { local: LocalProvenanceBackend; tsa: TsaFake } {
  const tsa = new TsaFake(authority);
  return { tsa, local: backend({ timestampAuthority: "https://tsa.example.test/", timestampRoots: [authority.root], fetch: tsa.fetch as typeof fetch, ...options }) };
}
function backend(options: LocalProvenanceOptions = {}): LocalProvenanceBackend {
  return new LocalProvenanceBackend({ indexedDB: new IDBFactory(), ...options });
}

async function sign(local: LocalProvenanceBackend) {
  return local.signRecord(request(), signal());
}

async function ephemeral(): Promise<DeviceSigner> {
  return DeviceSigner.ephemeral();
}

describe("signing", () => {
  it("a record verifies with its own public key, in the engine's format", async () => {
    const signer = await ephemeral();
    const jws = await signer.sign({ id: "r-1", content_hash: "ab", b: 1, a: "Grüße" });

    const parts = jws.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as Record<string, unknown>;
    expect(header).toMatchObject({ alg: "ES256", typ: DeviceSigner.typ });
    expect(String(header["kid"])).toMatch(/^device:[0-9a-f]{16}$/);
    // The payload is canonical: keys sorted, no spaces, characters as they are.
    expect(Buffer.from(parts[1]!, "base64url").toString("utf8")).toBe('{"a":"Grüße","b":1,"content_hash":"ab","id":"r-1"}');
    expect(Buffer.from(parts[2]!, "base64url")).toHaveLength(64); // ES256: r || s
    const certificate = new X509Certificate(Buffer.from((header["x5c"] as string[])[0]!, "base64"));
    expect(certificate.subject).toBe("CN=Fadenstack device signer");
    expect(certificate.verify(certificate.publicKey)).toBe(true); // self-signed, and the DER is one a strict parser takes
    expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(await DeviceSigner.verify(jws)).toMatchObject({ id: "r-1" });
    expect(Buffer.from(parts[0]!, "base64url").toString()).toBe(
      `{"alg":"ES256","kid":"${String(header["kid"])}","typ":"faden-provenance+jws","x5c":["${(header["x5c"] as string[])[0]!}"]}`,
    );
  });

  it("canonical JSON is the engine's: sorted by key, no spaces, characters kept, nothing undefined", () => {
    expect(canonicalJson({ z: [1, { y: null, x: "é\n" }], a: undefined, "ä": true })).toBe('{"z":[1,{"x":"é\\n","y":null}],"ä":true}');
  });

  /**
   * An ECDSA r or s, like a nonce, starts with a zero byte about once in 256: the certificate and the time-stamp request must
   * encode it all the same (a redundant leading zero is no valid DER integer). 53f6b6f.
   */
  it("thousands of keys and records never fail on a leading zero", async () => {
    for (let i = 0; i < 2000; i++) {
      const signer = await ephemeral();
      const certificate = new X509Certificate(signer.certificate); // a strict parser: a redundant leading zero would not load or verify
      expect(certificate.verify(certificate.publicKey)).toBe(true);
      expect(await DeviceSigner.verify(await signer.sign({ i }))).not.toBeNull();
    }
    const { local, tsa } = withTsa();
    for (let i = 0; i < 600; i++) expect((await sign(local)).timestamp).not.toBeNull();
    for (const sent of tsa.requests) {
      const req = new DerReader(sent.body).open(Tag.sequence);
      req.next();
      req.next();
      const nonce = req.expect(Tag.integer).content;
      expect(nonce[0]).toBeGreaterThanOrEqual(0x40); // never a zero byte in front
    }
  }, 120_000);

  it("DER integers are minimal: a leading zero is refused, a high bit gets its sign byte", () => {
    expect(() => unsignedInteger(Uint8Array.of(0, 5))).toThrow(/redundant/);
    expect(minimal(Uint8Array.of(0, 0, 5))).toEqual(Uint8Array.of(5));
    expect(minimal(Uint8Array.of(0, 0))).toEqual(Uint8Array.of(0));
    expect([...unsignedInteger(minimal(Uint8Array.of(0, 0x80, 1)))]).toEqual([0x02, 0x03, 0x00, 0x80, 0x01]);
    expect([...unsignedInteger(minimal(Uint8Array.of(0, 0, 0x7f)))]).toEqual([0x02, 0x01, 0x7f]);
  });

  it.each([0, 1, 2])("a flipped byte in part %i fails", async (part) => {
    const signer = await ephemeral();
    const parts = (await signer.sign({ id: "r-1" })).split(".");
    const bytes = Buffer.from(parts[part]!, "base64url");
    bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
    parts[part] = b64url(bytes);

    expect(await DeviceSigner.verify(parts.join("."))).toBeNull();
  });

  it("another key's signature does not verify under this certificate", async () => {
    const one = await ephemeral();
    const other = await ephemeral();
    const mine = (await one.sign({ id: "r-1" })).split(".");
    const theirs = (await other.sign({ id: "r-1" })).split(".");

    expect(await DeviceSigner.verify(`${mine[0]}.${mine[1]}.${theirs[2]}`)).toBeNull();
    expect(one.keyId).not.toBe(other.keyId);
  });

  it("garbage is no signature", async () => {
    for (const text of ["", "a.b", "a.b.c", "....", "e30.e30.e30"]) expect(await DeviceSigner.verify(text)).toBeNull();
  });

  it("the key is a non-extractable CryptoKey in the principal's database, read back as the same key", async () => {
    const factory = new IDBFactory();
    const first = await DeviceSigner.forInstallation({ name: "fadenstack-provenance:t:u", indexedDB: factory });
    expect(first.persisted).toBe(true);
    const again = await DeviceSigner.forInstallation({ name: "fadenstack-provenance:t:u", indexedDB: factory });

    expect(again.keyId).toBe(first.keyId);
    expect(await DeviceSigner.verify(await again.sign({ id: "x" }))).toMatchObject({ id: "x" });
    // What is stored: a CryptoKey that cannot be exported, and the certificate; no private bytes anywhere.
    const row = await storedKey(factory, "fadenstack-provenance:t:u");
    expect(row.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("pkcs8", row.privateKey)).rejects.toThrow();
    await expect(globalThis.crypto.subtle.exportKey("jwk", row.privateKey)).rejects.toThrow();
    expect(Object.keys(row).sort()).toEqual(["certificate", "privateKey"]);
  });

  it("each principal has a key of its own", async () => {
    const factory = new IDBFactory();
    const mine = await DeviceSigner.forInstallation({ name: "fadenstack-provenance:t:alice", indexedDB: factory });
    const theirs = await DeviceSigner.forInstallation({ name: "fadenstack-provenance:t:bob", indexedDB: factory });
    expect(mine.keyId).not.toBe(theirs.keyId);
  });

  it("without IndexedDB the key lives in memory and nothing is written", async () => {
    const signer = await DeviceSigner.forInstallation({ name: "fadenstack-provenance:t:u", indexedDB: undefined });

    expect(signer.persisted).toBe(false);
    expect(await DeviceSigner.verify(await signer.sign({ id: "x" }))).not.toBeNull();
  });

  it("a stored key that is no usable P-256 signing key is replaced", async () => {
    const factory = new IDBFactory();
    const name = "fadenstack-provenance:t:u";
    const old = await DeviceSigner.forInstallation({ name, indexedDB: factory });
    await putKey(factory, name, { privateKey: "not a key", certificate: new Uint8Array([1, 2, 3]) });

    const fresh = await DeviceSigner.forInstallation({ name, indexedDB: factory });

    expect(fresh.persisted).toBe(true);
    expect(fresh.keyId).not.toBe(old.keyId);
    expect((await DeviceSigner.forInstallation({ name, indexedDB: factory })).keyId).toBe(fresh.keyId);
    // Records signed before keep their own public key, so they still verify.
    expect(await DeviceSigner.verify(await old.sign({ id: "before" }))).toMatchObject({ id: "before" });
  });
});

describe("the record", () => {
  it("is the server's format signed by the device", async () => {
    const local = backend({ timestamping: false });

    const signed = await sign(local);

    const r = signed.record;
    expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(r).toMatchObject({
      contract: "provenance/v1", digital_source_type: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
      edit_kind: "generated", provider: "standalone", content_hash: "a".repeat(64), hash_key_version: 0, model: { id: "qwen3:14b" },
      system: { name: "Fadenstack SDK" },
    });
    expect(signed.timestamp).toBeNull(); // the device's clock
    const payload = (await DeviceSigner.verify(signed.signature))!;
    expect(payload).toEqual(JSON.parse(JSON.stringify(r)));
    expect(payload["hash_key_version"]).toBe(0);
    expect(LocalProvenanceBackend.plainHashKeyVersion).toBe(0);
  });

  it("a rewritten text is the composite source type", async () => {
    const signed = await backend().signRecord({ ...request(), edit_kind: "rewritten" }, signal());
    expect(signed.record.digital_source_type).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia");
  });

  it("online, with an authority named, the signature gets a time-stamp and only its hash leaves", async () => {
    const { local, tsa } = withTsa();

    const signed = await sign(local);

    expect(signed.timestamp).not.toBeNull();
    expect(tsa.requests).toHaveLength(1);
    const sent = tsa.requests[0]!;
    expect(sent.contentType).toBe("application/timestamp-query");
    expect(sent.url).toBe("https://tsa.example.test/");
    expect(sent.hash).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", DeviceSigner.signatureBytes(signed.signature) as BufferSource)));
    expect(sent.hash).toHaveLength(32);
    expect(Buffer.from(sent.body).includes(Buffer.from(signed.record.content_hash))).toBe(false); // no record field, just the hash
  });

  it("with the authority set to null nothing is sent at all", async () => {
    const { local, tsa } = withTsa({ timestampAuthority: null });
    const signed = await sign(local);
    expect(signed.timestamp).toBeNull();
    expect(tsa.requests).toHaveLength(0);
    expect(await local.keptRecords()).toMatchObject([{ timeSource: DEVICE_CLOCK_TIME, queued: false }]); // kept, and nothing waits
  });

  it("with no authority named the default is DigiCert's", async () => {
    expect(DEFAULT_TIMESTAMP_AUTHORITY).toBe("http://timestamp.digicert.com");
    const tsa = new TsaFake(authority);
    const local = backend({ fetch: tsa.fetch as typeof fetch });
    await sign(local);
    expect(tsa.requests.map((r) => r.url)).toEqual(["http://timestamp.digicert.com"]);
  });

  it.each<[string, AnswerOptions]>([
    ["tampered", { tamper: true }],
    ["from a root nobody trusts", { chain: "untrusted" }],
    ["from a certificate without the time-stamping purpose", { chain: "noEku" }],
    ["from an expired certificate", { chain: "expired" }],
    ["through an intermediate that is no CA", { chain: "intermediateNotCa" }],
    ["over the wrong hash", { wrongHash: true }],
    ["with the wrong nonce", { wrongNonce: true }],
    ["refused", { status: 2 }],
    ["with a content type that is no TSTInfo", { wrongContentType: true }],
    ["with a message digest that is not the TSTInfo's", { wrongMessageDigest: true }],
    ["without signed attributes", { noSignedAttributes: true }],
  ])("a token counts only when it checks out: %s leaves the record without a token and queued", async (_name, how) => {
    const { local, tsa } = withTsa();
    tsa.options = how;

    const signed = await sign(local);

    expect(signed.timestamp).toBeNull();
    expect(tsa.requests).toHaveLength(1);
    expect(await local.keptRecords()).toMatchObject([{ timeSource: DEVICE_CLOCK_TIME, queued: true }]);
  });

  it.each<[string, AnswerOptions]>([
    ["issuer and serial number", {}],
    ["subject key identifier", { subjectKeyIdentifier: true }],
    ["an intermediate CA between", { chain: "intermediate" }],
  ])("a good token counts: signer named by %s", async (_name, how) => {
    const { local, tsa } = withTsa();
    tsa.options = how;
    expect((await sign(local)).timestamp).not.toBeNull();
  });

  it("a good token is kept next to its record", async () => {
    const { local } = withTsa();

    const signed = await sign(local);

    const kept = await local.keptRecords();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ timeSource: AUTHORITY_TIME, queued: false });
    expect(kept[0]!.signed.timestamp).toBe(signed.timestamp);
    expect(kept[0]!.signed.record.id).toBe(signed.record.id);
    expect(kept[0]!.stampedLaterAt).toBeUndefined();
  });

  it("without IndexedDB the kept records live in memory", async () => {
    const { local } = withTsa({ indexedDB: undefined });
    await sign(local);
    expect(await local.keptRecords()).toMatchObject([{ timeSource: AUTHORITY_TIME, queued: false }]);
  });

  it("a slow authority costs the record its token, not the record", async () => {
    const local = backend({
      timestampAuthority: "https://tsa.example.test/", timestampTimeoutMs: 20,
      fetch: ((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
      })) as typeof fetch,
    });
    const signed = await sign(local);
    expect(signed.timestamp).toBeNull();
    expect(await DeviceSigner.verify(signed.signature)).not.toBeNull();
  });

  it("an authority that answers with an error status, or with junk, gives no token", async () => {
    const junk = backend({ timestampAuthority: "https://tsa.example.test/", fetch: (async () => new Response(Uint8Array.of(1, 2, 3))) as typeof fetch });
    const failing = backend({ timestampAuthority: "https://tsa.example.test/", fetch: (async () => new Response("no", { status: 500 })) as typeof fetch });
    expect((await sign(junk)).timestamp).toBeNull();
    expect((await sign(failing)).timestamp).toBeNull();
  });

  it("time-stamping switched off sends nothing", async () => {
    const { local, tsa } = withTsa({ timestamping: false });
    await sign(local);
    expect(tsa.requests).toHaveLength(0);
    expect(await local.keptRecords()).toMatchObject([{ queued: false }]);
  });

  it("the policy is the local default", async () => {
    const policy = await backend().policy();
    expect(policy).toMatchObject({ on_missing: "record", short_text_tokens: 200 });
    expect([...policy.exempt_edit_kinds].sort()).toEqual(["corrected", "extracted", "formatted", "translated"]);
  });
});

describe("the RFC 3161 messages", () => {
  const hash = new Uint8Array(32).fill(7);
  const nonce = Uint8Array.of(0x41, 1, 2, 3, 4, 5, 6, 7);

  it("a request is version 1, the SHA-256 imprint, the nonce and certReq", () => {
    const req = new DerReader(Rfc3161.request(hash, nonce)).open(Tag.sequence);
    expect([...req.expect(Tag.integer).content]).toEqual([1]);
    const imprint = req.open(Tag.sequence);
    expect(imprint.open(Tag.sequence).expect(Tag.objectIdentifier).content).toEqual(Uint8Array.of(0x60, 0x86, 0x48, 1, 0x65, 3, 4, 2, 1));
    expect(imprint.expect(Tag.octetString).content).toEqual(hash);
    expect(req.expect(Tag.integer).content).toEqual(nonce);
    expect([...req.expect(Tag.boolean).content]).toEqual([0xff]);
    expect(req.hasData).toBe(false);
  });

  const answer = (options: AnswerOptions = {}) => authority.answer(Rfc3161.request(hash, nonce), options);

  it("grants only a signed token, over our hash with our nonce, from a chain to a root we trust", async () => {
    const roots = [authority.root];
    expect(await Rfc3161.grants(await answer(), hash, nonce, roots)).toBe(true);
    expect(await Rfc3161.grants(await answer({ status: 1 }), hash, nonce, roots)).toBe(true); // granted with modifications
    expect(await Rfc3161.grants(await answer({ wrongNonce: true }), hash, nonce, roots)).toBe(false);
    expect(await Rfc3161.grants(await answer({ wrongHash: true }), hash, nonce, roots)).toBe(false);
    expect(await Rfc3161.grants(await answer({ status: 2 }), hash, nonce, roots)).toBe(false); // rejection
    expect(await Rfc3161.grants(await answer(), new Uint8Array(32).fill(8), nonce, roots)).toBe(false);
    expect(await Rfc3161.grants(Uint8Array.of(0x30, 0x80, 0, 0), hash, nonce, roots)).toBe(false); // indefinite length: not read
    expect(await Rfc3161.grants(new Uint8Array(), hash, nonce, roots)).toBe(false);
  });

  it("the roots decide: none, another root, or the right one", async () => {
    expect(await Rfc3161.grants(await answer(), hash, nonce, [])).toBe(false);
    expect(await Rfc3161.grants(await answer(), hash, nonce, [authority.otherRoot])).toBe(false);
    expect(await Rfc3161.grants(await answer(), hash, nonce, [Uint8Array.of(1, 2, 3), authority.root])).toBe(true); // a bad root is left out
    expect(await Rfc3161.grants(await answer({ chain: "untrusted" }), hash, nonce, [authority.otherRoot])).toBe(true); // its own root
  });

  it("every certificate on the path must be valid at the time asked about", async () => {
    const good = await answer();
    const later = new Date(Date.now() + 2 * 365 * 86_400_000);
    expect(await Rfc3161.grants(good, hash, nonce, [authority.root], globalThis.crypto, later)).toBe(false);
    expect(await Rfc3161.grants(good, hash, nonce, [authority.root], globalThis.crypto, new Date(Date.now() - 365 * 86_400_000))).toBe(false);
  });

  it("a time-stamp request's own answer from nobody is never a token", async () => {
    expect(await Rfc3161.grants(Rfc3161.request(hash, nonce), hash, nonce, [authority.root])).toBe(false);
  });
});

/** Mulberry32, so a failing mutation repeats. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the authority's answer is input from outside", () => {
  it("1,200 random mutations of a good answer each give true or false and never throw, and almost none still verify", async () => {
    const hash = new Uint8Array(32).fill(7);
    const nonce = Uint8Array.of(0x41, 1, 2, 3, 4, 5, 6, 7);
    const good = await authority.answer(Rfc3161.request(hash, nonce), { chain: "intermediate" });
    expect(await Rfc3161.grants(good, hash, nonce, [authority.root])).toBe(true);
    const next = random(20261114);
    const pick = (n: number) => Math.floor(next() * n);
    let verified = 0;

    for (let i = 0; i < 1200; i++) {
      let bytes = Uint8Array.from(good);
      const kind = i % 4;
      if (kind === 0) bytes[pick(bytes.length)]! ^= 1 + pick(255); // flip
      else if (kind === 1) bytes = bytes.slice(0, pick(bytes.length)); // truncate
      else if (kind === 2) { // insert
        const at = pick(bytes.length);
        bytes = Uint8Array.of(...bytes.slice(0, at), pick(256), ...bytes.slice(at));
      } else { // change a length byte: the byte after a tag, set to a short, a long, an indefinite or an oversized form
        const at = pick(bytes.length - 1) + 1;
        bytes[at] = [0x00, 0x7f, 0x80, 0x81, 0x82, 0x84, 0x85, 0xff][pick(8)]!;
      }

      const result = await Rfc3161.grants(bytes, hash, nonce, [authority.root]); // a throw fails the test here
      expect(typeof result).toBe("boolean");
      if (result) verified++;
    }

    expect(verified).toBeLessThan(30); // only bytes nothing signed or checked (a version, a parameter) can change and still verify
  }, 120_000);
});

describe("the DigiCert roots", () => {
  it("the embedded root is DigiCert Trusted Root G4, and its bytes hash to the fingerprint named in the source", () => {
    expect(DIGICERT_TIMESTAMP_ROOTS).toHaveLength(1);
    const der = DIGICERT_TIMESTAMP_ROOTS[0]!;
    expect(createHash("sha256").update(der).digest("hex")).toBe(DIGICERT_TRUSTED_ROOT_G4_SHA256);
    expect(DIGICERT_TRUSTED_ROOT_G4_SHA256).toBe("552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988");
    const certificate = new X509Certificate(der);
    expect(certificate.subject).toContain("CN=DigiCert Trusted Root G4");
    expect(createHash("sha1").update(der).digest("hex").toUpperCase()).toBe("DDFB16CD4931C973A2037D3FC83A4D7D775D05E4");
    expect(certificate.verify(certificate.publicKey)).toBe(true); // self-signed
  });
});

describe("the local backup (F10)", () => {
  /** A clock that moves a minute each time it is asked. */
  const ticking = (): (() => Date) => {
    let at = Date.UTC(2026, 10, 14, 9, 0, 0);
    return () => new Date((at += 60_000));
  };

  it("offline, the record has the labelled clock and waits; after a restart the queue is stamped", async () => {
    const factory = new IDBFactory();
    const tsa = new TsaFake(authority);
    const options = { indexedDB: factory, timestampAuthority: "https://tsa.example.test/", timestampRoots: [authority.root], fetch: tsa.fetch as typeof fetch, now: ticking() };
    tsa.down = true;
    const first = new LocalProvenanceBackend(options);
    const signed = await sign(first);
    expect(signed.timestamp).toBeNull();
    expect(await first.keptRecords()).toMatchObject([{ timeSource: DEVICE_CLOCK_TIME, queued: true }]);

    // A restart: a new backend on the same database. The authority answers again.
    tsa.down = false;
    const second = new LocalProvenanceBackend(options);
    expect(await second.keptRecords()).toMatchObject([{ queued: true }]);
    expect(await second.flushTimestampQueue()).toBe(1);

    const [kept] = await second.keptRecords();
    expect(kept!.queued).toBe(false);
    expect(kept!.signed.timestamp).not.toBeNull();
    expect(kept!.timeSource).toBe(DEVICE_CLOCK_TIME); // the record's own created_at is still the device's clock
    expect(kept!.stampedLaterAt).toBeDefined();
    expect(Date.parse(kept!.stampedLaterAt!)).toBeGreaterThan(Date.parse(kept!.signed.record.created_at));
    expect(await second.flushTimestampQueue()).toBe(0); // nothing left
  });

  it("signing a record once the authority answers again also stamps what waited, oldest first", async () => {
    const { local, tsa } = withTsa({ now: ticking() });
    tsa.down = true;
    const one = await sign(local);
    const two = await sign(local);
    tsa.down = false;
    tsa.requests.length = 0;

    const three = await sign(local);

    expect(three.timestamp).not.toBeNull();
    const kept = await local.keptRecords();
    expect(kept.map((k) => k.signed.record.id)).toEqual([one.record.id, two.record.id, three.record.id]);
    expect(kept.map((k) => k.queued)).toEqual([false, false, false]);
    expect(kept.map((k) => k.timeSource)).toEqual([DEVICE_CLOCK_TIME, DEVICE_CLOCK_TIME, AUTHORITY_TIME]);
    // Its own token first, then the waiting ones, the oldest first.
    expect(tsa.requests.map((r) => Buffer.from(r.hash).toString("hex"))).toEqual([three, one, two].map((s) => createHash("sha256").update(DeviceSigner.signatureBytes(s.signature)).digest("hex")));
  });

  it("stamps at most queueBatch records in a round, and stops at the first failure", async () => {
    const { local, tsa } = withTsa({ queueBatch: 2, now: ticking() });
    tsa.down = true;
    for (let i = 0; i < 5; i++) await sign(local);
    tsa.down = false;

    expect(await local.flushTimestampQueue()).toBe(2);
    expect((await local.keptRecords()).filter((k) => k.queued)).toHaveLength(3);

    tsa.options = { tamper: true }; // the authority answers, but with no token that counts
    expect(await local.flushTimestampQueue()).toBe(0);
    expect((await local.keptRecords()).filter((k) => k.queued)).toHaveLength(3);
  });

  it("a second flush while one runs returns 0 at once", async () => {
    const { local, tsa } = withTsa({ now: ticking() });
    tsa.down = true;
    await sign(local);
    await sign(local);
    tsa.down = false;
    let release!: () => void;
    tsa.gate = new Promise<void>((resolve) => { release = resolve; });

    const first = local.flushTimestampQueue();
    await new Promise((resolve) => setTimeout(resolve, 20)); // the first round is waiting on the authority
    expect(await local.flushTimestampQueue()).toBe(0);
    release();

    expect(await first).toBe(2);
  });

  it("with no authority a flush does nothing", async () => {
    const { local } = withTsa({ timestampAuthority: null });
    expect(await local.flushTimestampQueue()).toBe(0);
  });

  it("the records go with the database when the principal's data is deleted", async () => {
    const factory = new IDBFactory();
    const { local } = withTsa({ indexedDB: factory });
    await sign(local);
    await new Promise<void>((resolve, reject) => {
      const del = factory.deleteDatabase("fadenstack-provenance:standalone:standalone");
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
      del.onblocked = () => reject(new Error("blocked"));
    });

    expect(await local.keptRecords()).toEqual([]);
  });

  it("a database from before the records store keeps its key and its log", async () => {
    const factory = new IDBFactory();
    const name = "fadenstack-provenance:standalone:standalone";
    await new Promise<void>((resolve, reject) => { // version 1, as the first release made it
      const open = factory.open(name, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("keys");
        open.result.createObjectStore("placements", { autoIncrement: true });
      };
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });
    const old = await DeviceSigner.forInstallation({ name, indexedDB: factory }); // upgrades it, and stores a key
    const { local } = withTsa({ indexedDB: factory, timestampAuthority: null });
    await local.reportPlacement({ record_id: "before" } as PlacementReport);

    await sign(local);

    expect((await local.signer()).keyId).toBe(old.keyId);
    expect((await local.placements()).map((r) => r.record_id)).toEqual(["before"]);
    expect(await local.keptRecords()).toHaveLength(1);
  });
});

describe("the machine policy decides the authority (F09)", () => {
  const context = (timestamping: TimestampingPolicy): LocalProvenanceContext => ({
    system: () => ({ name: "x", version: "1" }), timestamping: () => timestamping, principal: () => undefined,
  });
  const make = (timestamping: TimestampingPolicy, options: LocalProvenanceOptions = {}) => {
    const tsa = new TsaFake(authority);
    const local = new LocalProvenanceBackend(
      { indexedDB: new IDBFactory(), timestampRoots: [authority.root], fetch: tsa.fetch as typeof fetch, ...options }, context(timestamping));
    return { local, tsa };
  };

  it("an own server gets the hash, and DigiCert does not", async () => {
    const own = MachinePolicy.from({ timestamping: "https://tsa.example.internal/rfc3161" }).timestamping;
    const { local, tsa } = make(own);

    expect((await sign(local)).timestamp).not.toBeNull();

    expect(tsa.requests.map((r) => r.url)).toEqual(["https://tsa.example.internal/rfc3161"]);
  });

  it("off sends nothing and queues nothing", async () => {
    const { local, tsa } = make(TimestampingPolicy.off, { timestampAuthority: "https://tsa.example.test/" });

    const signed = await sign(local);

    expect(signed.timestamp).toBeNull();
    expect(tsa.requests).toHaveLength(0);
    expect(await local.keptRecords()).toMatchObject([{ timeSource: DEVICE_CLOCK_TIME, queued: false }]);
    expect(await local.flushTimestampQueue()).toBe(0);
  });

  it("on takes the app's authority, and the app's own switch still turns it off", async () => {
    const on = make(TimestampingPolicy.on, { timestampAuthority: "https://tsa.example.test/" });
    await sign(on.local);
    expect(on.tsa.requests.map((r) => r.url)).toEqual(["https://tsa.example.test/"]);

    const off = make(TimestampingPolicy.on, { timestamping: false });
    await sign(off.local);
    expect(off.tsa.requests).toHaveLength(0);

    const own = make(MachinePolicy.from({ timestamping: "https://tsa.example.internal/" }).timestamping, { timestamping: false });
    await sign(own.local);
    expect(own.tsa.requests).toHaveLength(0);
  });

  it("with no policy at all the default is DigiCert's address", async () => {
    const tsa = new TsaFake(authority);
    const local = new LocalProvenanceBackend({ indexedDB: new IDBFactory(), fetch: tsa.fetch as typeof fetch });
    await sign(local);
    expect(tsa.requests.map((r) => r.url)).toEqual([DEFAULT_TIMESTAMP_AUTHORITY]);
  });
});

// Opt in with FADEN_LIVE_TSA=1: DigiCert's public service (needs the network, no key). .NET uses the same variable.
describe.skipIf(!process.env["FADEN_LIVE_TSA"])("the real DigiCert service (live)", () => {
  it("answers with a token that checks out against the embedded root", async () => {
    const local = new LocalProvenanceBackend({ indexedDB: new IDBFactory(), timestampTimeoutMs: 15_000 });

    const signed = await sign(local);

    expect(signed.timestamp).not.toBeNull();
    expect(await local.keptRecords()).toMatchObject([{ timeSource: AUTHORITY_TIME, queued: false }]);
  }, 30_000);
});

describe("the log", () => {
  it("rotates by entries: the newest stay, the oldest go", async () => {
    const local = backend({ maxLogEntries: 5 });
    for (let i = 0; i < 12; i++) await local.reportPlacement({ record_id: `rec-${String(i).padStart(2, "0")}` } as PlacementReport);

    const kept = (await local.placements()).map((r) => r.record_id);
    expect(kept).toEqual(["rec-07", "rec-08", "rec-09", "rec-10", "rec-11"]);
  });

  it("is kept per principal, and survives a new backend on the same database", async () => {
    const factory = new IDBFactory();
    const mine = new LocalProvenanceBackend({ indexedDB: factory, principal: { tenantId: "t", userId: "alice" } });
    const theirs = new LocalProvenanceBackend({ indexedDB: factory, principal: { tenantId: "t", userId: "bob" } });
    await mine.reportPlacement({ record_id: "a-1" } as PlacementReport);
    await theirs.reportPlacement({ record_id: "b-1" } as PlacementReport);

    const again = new LocalProvenanceBackend({ indexedDB: factory, principal: { tenantId: "t", userId: "alice" } });
    expect((await again.placements()).map((r) => r.record_id)).toEqual(["a-1"]);
    expect((await theirs.placements()).map((r) => r.record_id)).toEqual(["b-1"]);
  });

  it("without IndexedDB it is kept in memory, with the same cap", async () => {
    const local = new LocalProvenanceBackend({ indexedDB: undefined, maxLogEntries: 2 });
    for (let i = 0; i < 4; i++) await local.reportPlacement({ record_id: `r${i}` } as PlacementReport);
    expect((await local.placements()).map((r) => r.record_id)).toEqual(["r2", "r3"]);
  });

  it("a database deleted under it (deleteMyData) is opened again on the next write", async () => {
    const factory = new IDBFactory();
    const local = new LocalProvenanceBackend({ indexedDB: factory });
    await local.reportPlacement({ record_id: "one" } as PlacementReport);
    await new Promise<void>((resolve, reject) => {
      const del = factory.deleteDatabase("fadenstack-provenance:standalone:standalone");
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
      del.onblocked = () => reject(new Error("blocked"));
    });

    await local.reportPlacement({ record_id: "two" } as PlacementReport);

    expect((await local.placements()).map((r) => r.record_id)).toEqual(["two"]);
  });
});

describe("which backend", () => {
  const fillField = (editor: Editor, seen: Placement<string>[] = []) => defineTool<{ text: string }>({
    name: "fill_field",
    toolClass: "write",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output: { argument: "text", mediaType: "text/html", edit: "generated" },
    run: async ({ text }, context) => {
      const placement = await provenanceOf(context).place({ content: text, mediaType: "text/html", sink: editor.sink }, (m) => editor.insert(String(m.content)));
      seen.push(placement);
      return "Inserted.";
    },
  });

  async function standaloneRun(options: { backend?: ProvenanceBackend; local?: LocalProvenanceOptions; app?: { name: string; version: string }; policy?: MachinePolicy } = {}) {
    const fake = new OpenAiFake();
    fake.answers.push(OpenAiFake.calls(["call-1", "fill_field", JSON.stringify({ text: `<p>${LONG}</p>` })]), OpenAiFake.text("Done."));
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    let builder = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch })
      .useLocalProfile(AgentDefinition.fromJson({ slug: "docs-assistant", version: { host_tool_contract: [{ name: "fill_field", risk: "write" }] } }))
      .useSessionStore(new MemorySessionStore())
      .useApprovalStore(new MemoryApprovalStore())
      .useApprovals(async () => ({ approved: true }))
      .addTools(fillField(editor, seen))
      .use(provenanceModule({ ...(options.backend ? { backend: options.backend } : {}), localBackend: { indexedDB: new IDBFactory(), timestampAuthority: null, ...options.local } }));
    if (options.app) builder = builder.describeApp(options.app);
    if (options.policy) builder = builder.useMachinePolicy(options.policy);
    const agent = builder.build();
    const session = await agent.startSession("auto");
    await session.send("Tell the customer.");
    return { agent, fake, editor, seen, session };
  }

  it("a standalone placement is signed on the device and never server-unavailable", async () => {
    const run = await standaloneRun({ app: { name: "Word add-in", version: "0.3.0" } });

    const placed = run.seen[0]!;
    expect(placed.recordId).toBeTruthy();
    expect(placed.layers).toContainEqual({ layer: "metadata", method: "signed-record", applied: true });
    expect(placed.layers.some((l) => l.reason === "server-unavailable")).toBe(false);
    // The record the mark names was signed here: its signature is in the transcript's entry? The mark names the id; the
    // device's own record carries the app as its system.
    expect(run.editor.html).toContain(placed.recordId!);
    // Nothing but the endpoint was contacted.
    expect(run.fake.requests.every((r) => r.url.pathname.endsWith("/chat/completions"))).toBe(true);
  });

  it("the record names the app the agent runs in as its system", async () => {
    const local = new LocalProvenanceBackend({ indexedDB: new IDBFactory() }, {
      system: () => ({ name: "Word add-in", version: "0.3.0" }), timestamping: () => TimestampingPolicy.on, principal: () => undefined,
    });
    expect((await sign(local)).record.system).toEqual({ name: "Word add-in", version: "0.3.0" });
    // And through an agent: the app's description reaches the module's own backend without error.
    expect((await standaloneRun({ app: { name: "Word add-in", version: "0.3.0" } })).seen[0]!.recordId).toBeTruthy();
  });

  it("the machine's time-stamp switch, when it says no, sends nothing", async () => {
    const tsa = new TsaFake(authority);
    const local = new LocalProvenanceBackend({ indexedDB: new IDBFactory(), timestampAuthority: "https://tsa.example.test/", timestampRoots: [authority.root], fetch: tsa.fetch as typeof fetch }, {
      system: () => ({ name: "x", version: "1" }), timestamping: () => TimestampingPolicy.off, principal: () => undefined,
    });
    const signed = await sign(local);
    expect(signed.timestamp).toBeNull();
    expect(tsa.requests).toHaveLength(0);
    expect(await DeviceSigner.verify(signed.signature)).not.toBeNull(); // still signed
  });
  it("the machine policy switches the time-stamp off through the agent, and nothing leaves", async () => {
    const tsa = new TsaFake(authority);
    const local = { timestampAuthority: "https://tsa.example.test/", timestampRoots: [authority.root], fetch: tsa.fetch as typeof fetch };

    await standaloneRun({ local, policy: MachinePolicy.fromJson('{"timestamping":"off"}') });
    expect(tsa.requests).toHaveLength(0);

    await standaloneRun({ local, policy: MachinePolicy.fromJson("{}") });
    expect(tsa.requests).toHaveLength(1); // with no policy word, the authority is asked
  });

  it("an app's own backend is used instead of the device's", async () => {
    const memory = new MemoryBackend();
    const run = await standaloneRun({ backend: memory });
    expect(memory.records).toHaveLength(1);
    expect(run.seen[0]!.recordId).toBe(memory.records[0]!.signed.record.id);
  });

  it("the device's log holds the placement, hashes and outcomes only", async () => {
    const factory = new IDBFactory();
    const run = await standaloneRun({ local: { indexedDB: factory } });
    const log = await new LocalProvenanceBackend({ indexedDB: factory, principal: { tenantId: "standalone", userId: "standalone" } }).placements();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ record_id: run.seen[0]!.recordId, tool: "fill_field", sink_kind: "html.editor" });
    expect(JSON.stringify(log)).not.toContain("delivery");
    expect(await textSha256(LONG)).toHaveLength(64);
  });
});

describe("the watermark layer for a standalone agent (F10)", () => {
  const write = (editor: Editor, seen: Placement<string>[]) => defineTool<{ text: string }>({
    name: "fill_field", toolClass: "write",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output: { argument: "text", mediaType: "text/html", edit: "generated" },
    run: async ({ text }, context) => {
      seen.push(await provenanceOf(context).place({ content: text, mediaType: "text/html", sink: editor.sink }, (m) => editor.insert(String(m.content))));
      return "Inserted.";
    },
  });

  // .NET: The_watermark_layer_relies_on_the_endpoint_and_never_claims_more
  it.each<[string, string, string | undefined, boolean, string, boolean, string | undefined]>([
    ["http://localhost:11434/v1", "ollama", undefined, false, "endpoint-ollama", false, "runtime-without-watermark"],
    ["https://api.anthropic.com/v1", "openai-compatible", undefined, false, "endpoint-anthropic", true, undefined],
    ["https://api.x.ai/v1", "openai-compatible", "true", false, "endpoint-xai", true, undefined],
    ["https://api.x.ai/v1", "openai-compatible", "false", false, "endpoint-xai", false, "no-watermark-remote-model"],
    ["https://api.openai.com/v1", "openai", undefined, false, "endpoint-openai", false, undefined],
    ["http://localhost:8000/v1", "vllm", undefined, false, "endpoint-vllm", false, undefined],
    ["https://api.anthropic.com/v1", "openai-compatible", undefined, true, "endpoint-anthropic", false, "no-watermark-greedy"],
  ])("%s (%s, x-watermark %s, greedy %s) relies on the endpoint and never claims more", async (baseUrl, dialect, header, greedy, method, applied, reason) => {
    const fake = new OpenAiFake();
    if (header !== undefined) fake.chatHeaders["x-watermark"] = header;
    fake.answers.push(OpenAiFake.calls(["call-1", "fill_field", JSON.stringify({ text: `<p>${LONG}</p>` })]), OpenAiFake.text("Done."));
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    let builder = FadenstackAgent.createBuilder()
      .useEndpoint({
        baseUrl, model: "m", dialect: EndpointDialect.named(dialect), fetch: fake.fetch,
        ...(baseUrl.startsWith("https") ? { key: new StaticTokenProvider("k") } : {}),
      })
      .useLocalProfile(AgentDefinition.fromJson({ slug: "docs-assistant", version: { host_tool_contract: [{ name: "fill_field", risk: "write" }] } }))
      .useSessionStore(new MemorySessionStore())
      .useApprovalStore(new MemoryApprovalStore())
      .useApprovals(async () => ({ approved: true }))
      .addTools(write(editor, seen))
      .use(provenanceModule({ localBackend: { indexedDB: new IDBFactory(), timestampAuthority: null } }));
    if (greedy) builder = builder.addChatStage(StageOrder.custom, (inner) => ({ stream: (messages, options) => inner.stream(messages, { ...options, temperature: 0 }) }));
    const agent = builder.build();

    await (await agent.startSession("auto")).send("Tell the customer.");

    const layers = seen[0]!.layers.filter((l) => l.layer === "watermark");
    expect(layers).toHaveLength(1);
    expect(layers[0]!.method).toBe(method);
    expect(layers[0]!.applied).toBe(applied);
    expect(layers[0]!.reason).toBe(reason);
  });

  it("a short text has the endpoint's own method and the short-text reason", async () => {
    const fake = new OpenAiFake();
    fake.answers.push(OpenAiFake.calls(["call-1", "fill_field", JSON.stringify({ text: "<p>Short.</p>" })]), OpenAiFake.text("Done."));
    const editor = new Editor();
    const seen: Placement<string>[] = [];
    const agent = FadenstackAgent.createBuilder()
      .useEndpoint({ baseUrl: "http://localhost:11434/v1", model: "m", dialect: EndpointDialect.ollama, fetch: fake.fetch })
      .useLocalProfile(AgentDefinition.fromJson({ slug: "docs-assistant", version: { host_tool_contract: [{ name: "fill_field", risk: "write" }] } }))
      .useSessionStore(new MemorySessionStore()).useApprovalStore(new MemoryApprovalStore()).useApprovals(async () => ({ approved: true }))
      .addTools(write(editor, seen)).use(provenanceModule({ localBackend: { indexedDB: new IDBFactory(), timestampAuthority: null } })).build();
    await (await agent.startSession("auto")).send("Hi.");
    expect(seen[0]!.layers.find((l) => l.layer === "watermark")).toMatchObject({ method: "endpoint", applied: false, reason: "short-text" });
  });
});
// ---- raw IndexedDB, to see what is stored ----

function openRaw(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function storedKey(factory: IDBFactory, name: string): Promise<{ privateKey: CryptoKey; certificate: Uint8Array }> {
  const db = await openRaw(factory, name);
  try {
    return await new Promise((resolve, reject) => {
      const get = db.transaction(["keys"], "readonly").objectStore("keys").get("signing");
      get.onsuccess = () => resolve(get.result as { privateKey: CryptoKey; certificate: Uint8Array });
      get.onerror = () => reject(get.error);
    });
  } finally {
    db.close();
  }
}

async function putKey(factory: IDBFactory, name: string, row: unknown): Promise<void> {
  const db = await openRaw(factory, name);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["keys"], "readwrite");
      tx.objectStore("keys").put(row, "signing");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
