import { X509Certificate } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { EndpointDialect, StaticTokenProvider, textSha256, type PlacementReport, type RecordRequest } from "@fadenstack/client";
import { AgentDefinition, FadenstackAgent, MachinePolicy, MemoryApprovalStore, MemorySessionStore, StageOrder, defineTool } from "@fadenstack/agents";
import {
  DeviceSigner, LocalProvenanceBackend, MemoryBackend, Rfc3161, canonicalJson, provenanceModule, provenanceOf, type LocalProvenanceOptions,
  type Placement, type ProvenanceBackend,
} from "@fadenstack/provenance";
import { OpenAiFake } from "@fadenstack/testing";

import {
  DerReader, Tag, explicit0, generalizedTime, integerBytes, minimal, objectIdentifier, octetString, sequence, set, smallInteger, unsignedInteger,
} from "../src/der.js";
import { Editor, LONG } from "./helpers.js";

/**
 * sdk/51 F10: the device's own provenance backend, records signed on the device, the time-stamp, the local log. Port of the
 * .NET LocalProvenanceTests (ac6d9ac and 53f6b6f). Not ported, because a browser has none of it: the key file, the OS key
 * store's protector and a file the user cannot read (the key lives in IndexedDB as a non-extractable CryptoKey instead:
 * tested as such below), and the file log's byte size rotation (the log rotates by entries).
 */
const request = (): RecordRequest => ({ content_sha256: "a".repeat(64), media_type: "text/plain", edit_kind: "generated", model: "qwen3:14b" });

const signal = () => new AbortController().signal;
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function bigintBytes(value: bigint): Uint8Array {
  const hex = value.toString(16);
  return Uint8Array.from(Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex"));
}

/** A time-stamp authority: reads the request, answers a granted token over its hash and nonce (or not). */
class TsaFake {
  readonly requests: { contentType: string | null; body: Uint8Array; hash: Uint8Array; url: string }[] = [];
  down = false;
  wrongNonce = false;
  status = 0;

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError("offline");
    const body = init!.body as Uint8Array;
    const req = new DerReader(body).open(Tag.sequence);
    req.expect(Tag.integer);
    const imprint = req.open(Tag.sequence);
    imprint.expect(Tag.sequence);
    const hash = imprint.expect(Tag.octetString).content.slice();
    const nonce = BigInt(`0x${Buffer.from(integerBytes(req.expect(Tag.integer))).toString("hex")}`);
    this.requests.push({ contentType: new Headers(init!.headers).get("content-type"), body, hash, url: String(input) });
    return new Response(this.response(hash, this.wrongNonce ? nonce + 1n : nonce) as BodyInit, { status: 200 });
  };

  response(hash: Uint8Array, nonce: bigint): Uint8Array {
    const info = sequence(
      smallInteger(1), objectIdentifier("1.2.3.4"),
      sequence(sequence(objectIdentifier("2.16.840.1.101.3.4.2.1")), octetString(hash)),
      smallInteger(42), generalizedTime(new Date()), unsignedInteger(minimal(bigintBytes(nonce))),
    );
    return sequence(
      sequence(smallInteger(this.status)),
      sequence(
        objectIdentifier("1.2.840.113549.1.7.2"),
        explicit0(sequence(
          smallInteger(3), set(),
          sequence(objectIdentifier("1.2.840.113549.1.9.16.1.4"), explicit0(octetString(info))),
        )),
      ),
    );
  }
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
    const tsa = new TsaFake();
    const local = backend({ timestampAuthority: "https://tsa.example.test/", fetch: tsa.fetch as typeof fetch });
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
    const tsa = new TsaFake();
    const local = backend({ timestampAuthority: "https://tsa.example.test/", fetch: tsa.fetch as typeof fetch });

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

  it("with no authority named (the browser default) nothing is sent at all", async () => {
    const tsa = new TsaFake();
    const local = backend({ fetch: tsa.fetch as typeof fetch });
    expect((await sign(local)).timestamp).toBeNull();
    expect(tsa.requests).toHaveLength(0);
  });

  it.each([
    ["offline", { down: true }],
    ["with a wrong nonce", { wrongNonce: true }],
    ["refused", { status: 2 }],
  ])("%s the record goes without a token", async (_name, how) => {
    const tsa = Object.assign(new TsaFake(), how);
    const local = backend({ timestampAuthority: "https://tsa.example.test/", fetch: tsa.fetch as typeof fetch });
    expect((await sign(local)).timestamp).toBeNull();
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
    const tsa = new TsaFake();
    const local = backend({ timestamping: false, timestampAuthority: "https://tsa.example.test/", fetch: tsa.fetch as typeof fetch });
    await sign(local);
    expect(tsa.requests).toHaveLength(0);
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

  it("grants only over our hash with our nonce", () => {
    const tsa = new TsaFake();
    const n = BigInt(`0x${Buffer.from(nonce).toString("hex")}`);
    expect(Rfc3161.grants(tsa.response(hash, n), hash, nonce)).toBe(true);
    expect(Rfc3161.grants(tsa.response(hash, n + 1n), hash, nonce)).toBe(false);
    expect(Rfc3161.grants(tsa.response(new Uint8Array(32).fill(8), n), hash, nonce)).toBe(false);
    tsa.status = 1; // granted with modifications
    expect(Rfc3161.grants(tsa.response(hash, n), hash, nonce)).toBe(true);
    tsa.status = 2; // rejection
    expect(Rfc3161.grants(tsa.response(hash, n), hash, nonce)).toBe(false);
    expect(Rfc3161.grants(Uint8Array.of(0x30, 0x80, 0, 0), hash, nonce)).toBe(false); // indefinite length: not read
    expect(Rfc3161.grants(new Uint8Array(), hash, nonce)).toBe(false);
  });
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
      .use(provenanceModule({ ...(options.backend ? { backend: options.backend } : {}), localBackend: { indexedDB: new IDBFactory(), ...options.local } }));
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
      system: () => ({ name: "Word add-in", version: "0.3.0" }), timestampingAllowed: () => true, principal: () => undefined,
    });
    expect((await sign(local)).record.system).toEqual({ name: "Word add-in", version: "0.3.0" });
    // And through an agent: the app's description reaches the module's own backend without error.
    expect((await standaloneRun({ app: { name: "Word add-in", version: "0.3.0" } })).seen[0]!.recordId).toBeTruthy();
  });

  it("the machine's time-stamp switch, when it says no, sends nothing", async () => {
    const tsa = new TsaFake();
    const local = new LocalProvenanceBackend({ indexedDB: new IDBFactory(), timestampAuthority: "https://tsa.example.test/", fetch: tsa.fetch as typeof fetch }, {
      system: () => ({ name: "x", version: "1" }), timestampingAllowed: () => false, principal: () => undefined,
    });
    const signed = await sign(local);
    expect(signed.timestamp).toBeNull();
    expect(tsa.requests).toHaveLength(0);
    expect(await DeviceSigner.verify(signed.signature)).not.toBeNull(); // still signed
  });
  it("the machine policy switches the time-stamp off through the agent, and nothing leaves", async () => {
    const tsa = new TsaFake();
    const local = { timestampAuthority: "https://tsa.example.test/", fetch: tsa.fetch as typeof fetch };

    await standaloneRun({ local, policy: MachinePolicy.fromJson('{"timestamping":"forbidden"}') });
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
      .use(provenanceModule({ localBackend: { indexedDB: new IDBFactory() } }));
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
      .addTools(write(editor, seen)).use(provenanceModule({ localBackend: { indexedDB: new IDBFactory() } })).build();
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
