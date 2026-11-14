import {
  DEFAULT_PROVENANCE_POLICY,
  PROVENANCE_CONTRACT,
  SDK_VERSION,
  digitalSourceType,
  toProvenancePolicy,
  type PlacementReport,
  type ProvenancePolicy,
  type ProvenanceRecordPayload,
  type RecordRequest,
  type SignedRecord,
} from "@fadenstack/client";
import { TimestampingMode, TimestampingPolicy, userStoreName } from "@fadenstack/agents";

import { DeviceSigner, toBase64 } from "./deviceSigner.js";
import { appendPlacement, openProvenanceDatabase, putRecord, readPlacements, readRecords } from "./deviceStore.js";
import { Rfc3161 } from "./rfc3161.js";
import { DIGICERT_TIMESTAMP_ROOTS } from "./timestampRoots.js";
import type { ProvenanceBackend } from "./types.js";

/** DigiCert's public time-stamp service (owner, 14 Nov). Plain http is fine: the token is signed, and only a hash leaves. */
export const DEFAULT_TIMESTAMP_AUTHORITY = "http://timestamp.digicert.com";

/** What dated a record: the authority's token. */
export const AUTHORITY_TIME = "authority";
/** What dated a record: the device's clock, labelled as such, until a token comes. */
export const DEVICE_CLOCK_TIME = "device-clock";

/** A record kept on the device with its token (sdk/51 F10, the local backup). .NET: `KeptRecord`. */
export interface KeptRecord {
  /** The record, its signature and its token (null while it waits). */
  signed: SignedRecord;
  /** `authority`: the token dates it; `device-clock`: the device's clock does, labelled as such. */
  timeSource: typeof AUTHORITY_TIME | typeof DEVICE_CLOCK_TIME;
  /** Waiting for a token, because the authority could not be reached when it was signed. */
  queued: boolean;
  /** When a waiting record got its token (an ISO time): it then proves it existed no later than that. */
  stampedLaterAt?: string;
}

/** What the device's own provenance backend does beyond its defaults. .NET: `LocalProvenanceOptions`. */
export interface LocalProvenanceOptions {
  /**
   * The RFC 3161 time-stamp authority a record's signature is sent to when the machine policy says `on` (only the signature's
   * SHA-256 leaves the device); DigiCert's (`DEFAULT_TIMESTAMP_AUTHORITY`) when omitted, `null` for none. A policy address
   * replaces it; `off` sends nothing. DigiCert answers over plain http, which is fine: the token is signed and only a hash
   * leaves. In Chrome the extension needs a host permission for that origin (F12), and an https page cannot reach it (mixed
   * content, CORS): there the app names an authority it can reach, or the records wait in the queue until one answers.
   */
  timestampAuthority?: string | URL | null;
  /** Whether records are time-stamped at all (default true; the app's own switch, the machine policy has its own, F09). */
  timestamping?: boolean;
  /** How long the authority may take, in milliseconds, before the record goes without a token and waits in the queue (default 5000). */
  timestampTimeoutMs?: number;
  /**
   * Roots trusted for the authority's certificate besides DigiCert's (`DIGICERT_TIMESTAMP_ROOTS`): DER certificates, the roots
   * an organisation's own time-stamp server chains to. A token whose signer chains to none of them does not count.
   */
  timestampRoots?: readonly Uint8Array[];
  /** How many queued records are stamped in one round, once the authority answers again (default 20, at least 1). */
  queueBatch?: number;
  /** The time, for a record's `created_at` and when a waiting record was stamped; tests set it. */
  now?: () => Date;
  /** The `fetch` the time-stamp request goes through (tests, a proxy); the platform's when omitted. */
  fetch?: typeof fetch;
  /** Who provides the AI system, as the record names it (a server names its organisation); default `standalone`. */
  provider?: string;
  /** The signer; the principal's own (a key per principal, kept in IndexedDB) when omitted. */
  signer?: DeviceSigner;
  /** Whose database the key and the log go in (`userStoreName`); the agent's principal when omitted. */
  principal?: { tenantId: string; userId: string };
  /** The IndexedDB factory (default `globalThis.indexedDB`); without one the key and the log live in memory only. */
  indexedDB?: IDBFactory;
  /** WebCrypto (default `globalThis.crypto`). */
  crypto?: Crypto;
  /** The most placements the log keeps; beyond it the oldest go (default 2000). .NET rotates its file by size instead. */
  maxLogEntries?: number;
}

/** What the module tells the local backend about the agent it serves (the TypeScript backend has no agent argument). */
export interface LocalProvenanceContext {
  /** The app's name and version for the record's `system`; the SDK's when it described none. */
  system(): { name: string; version: string };
  /** The machine policy's `timestamping`: on, off, or the organisation's own server (F09). */
  timestamping(): TimestampingPolicy;
  /** Whose database the key and the log go in. */
  principal(): { tenantId: string; userId: string } | undefined;
}

const SOURCE_TYPES = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const DEFAULT_LOG_ENTRIES = 2000;
const DEFAULT_QUEUE_BATCH = 20;
const STANDALONE = { tenantId: "standalone", userId: "standalone" };

/**
 * Provenance with no server (sdk/51 F10): the device's own policy defaults, records signed on the device in the server's
 * format (`DeviceSigner`) with an RFC 3161 time-stamp from DigiCert, and placements in a local log that rotates. Nothing
 * leaves the device but the signature's hash to the time-stamp authority, and that only when the machine policy allows.
 * .NET: `LocalProvenanceBackend`.
 *
 * The local backup (owner, 14 Nov): every signed record is kept on the device with its token, in the principal's database
 * (ASVS 5.0 V14). When the authority cannot be reached, the record keeps the device's clock, labelled as such
 * (`timeSource: "device-clock"`), and waits in the queue (the kept records still waiting, so it survives a restart); it is
 * stamped when the authority answers again, so it then also proves it existed no later than that time.
 *
 * The record's `content_hash` is the plain SHA-256 of the content (`hash_key_version` 0): a server's is a keyed HMAC under
 * its own key version, which a device does not have.
 */
export class LocalProvenanceBackend implements ProvenanceBackend {
  /** The `hash_key_version` of a device's record: the content's plain SHA-256. */
  static readonly plainHashKeyVersion = 0;

  readonly options: LocalProvenanceOptions;
  readonly #context: LocalProvenanceContext | undefined;
  #signer: Promise<DeviceSigner> | undefined;
  #db: Promise<IDBDatabase | undefined> | undefined;
  #memoryLog: PlacementReport[] = [];
  readonly #memoryRecords = new Map<string, KeptRecord>();
  /** One stamping round at a time (.NET: `SemaphoreSlim.WaitAsync(0)`). */
  #stamping = false;

  constructor(options: LocalProvenanceOptions = {}, context?: LocalProvenanceContext) {
    this.options = options;
    this.#context = context;
  }

  /** The device's signer (made, or read from the principal's database, on first use). */
  signer(): Promise<DeviceSigner> {
    this.#signer ??= (this.options.signer ? Promise.resolve(this.options.signer) : this.#makeSigner()).catch((error: unknown) => {
      this.#signer = undefined; // try again next time
      throw error;
    });
    return this.#signer;
  }

  #principal(): { tenantId: string; userId: string } {
    return this.options.principal ?? this.#context?.principal() ?? STANDALONE;
  }

  #databaseName(): string {
    return userStoreName("fadenstack-provenance", this.#principal());
  }

  #makeSigner(): Promise<DeviceSigner> {
    return DeviceSigner.forInstallation({
      name: this.#databaseName(),
      indexedDB: this.options.indexedDB,
      crypto: this.options.crypto,
    });
  }

  /** The local defaults: mark everything but standard editing (the default exempt kinds), record what is missing. */
  async policy(): Promise<Required<ProvenancePolicy>> {
    return toProvenancePolicy({ ...DEFAULT_PROVENANCE_POLICY, exempt_edit_kinds: [...DEFAULT_PROVENANCE_POLICY.exempt_edit_kinds] });
  }

  async signRecord(request: RecordRequest, signal: AbortSignal): Promise<SignedRecord> {
    const system = this.#context?.system() ?? { name: "Fadenstack SDK", version: SDK_VERSION };
    // Left out when empty, as .NET's JSON leaves out nulls: what is signed is exactly what the record says.
    const record: ProvenanceRecordPayload = {
      contract: PROVENANCE_CONTRACT,
      id: globalThis.crypto.randomUUID(),
      digital_source_type: SOURCE_TYPES + (request.edit_kind === "generated" ? "trainedAlgorithmicMedia" : "compositeWithTrainedAlgorithmicMedia"),
      edit_kind: request.edit_kind,
      system,
      provider: this.options.provider ?? "standalone",
      created_at: this.#now().toISOString(),
      media_type: request.media_type,
      content_hash: request.content_sha256,
      hash_key_version: LocalProvenanceBackend.plainHashKeyVersion,
      ...(request.text_sha256 ? { text_hash: request.text_sha256 } : {}),
      ...(request.model ? { model: { id: request.model } } : {}),
      ...(request.receipt_id ? { receipt_id: request.receipt_id } : {}),
    };
    const signature = await (await this.signer()).sign(record);
    // The machine policy may name its own server, or switch time-stamps off (F09): then nothing leaves the device at all.
    const authority = this.#authority();
    const timestamp = authority === undefined ? null : await this.#timestamp(signature, authority, signal);
    const signed: SignedRecord = { record, signature, timestamp };
    await this.#keep({ signed, timeSource: timestamp === null ? DEVICE_CLOCK_TIME : AUTHORITY_TIME, queued: timestamp === null && authority !== undefined });
    // The authority answers: what waited while it did not is stamped now.
    if (timestamp !== null) await this.#stampQueued(authority!, signal);
    return signed;
  }

  /**
   * Stamps the records that wait in the queue, when the authority the policy names answers (an app may call it at start;
   * signing a record does it too, once the authority answers). The number stamped; 0 when there is no authority, or another
   * round is on its way.
   */
  async flushTimestampQueue(signal?: AbortSignal): Promise<number> {
    const authority = this.#authority();
    return authority === undefined ? 0 : this.#stampQueued(authority, signal ?? new AbortController().signal);
  }

  /** The records kept on the device, oldest first: each with its token, or labelled with the device's clock. */
  async keptRecords(): Promise<KeptRecord[]> {
    const db = await this.#database();
    const all = db ? await readRecords(db) : [...this.#memoryRecords.values()].map((r) => structuredClone(r));
    return all.sort((a, b) => (a.signed.record.created_at < b.signed.record.created_at ? -1 : a.signed.record.created_at > b.signed.record.created_at ? 1 : 0));
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** The authority for the policy: its own server, the app's (DigiCert's by default) for `on`, none for `off`. .NET: `AuthorityFor`. */
  #authority(): string | undefined {
    if (this.options.timestamping === false) return undefined;
    const policy = this.#context?.timestamping() ?? TimestampingPolicy.on;
    if (policy.mode === TimestampingMode.Off) return undefined;
    if (policy.mode === TimestampingMode.OwnServer) return policy.server === undefined ? undefined : policy.server.href;
    const own = this.options.timestampAuthority;
    return own === null ? undefined : String(own ?? DEFAULT_TIMESTAMP_AUTHORITY);
  }

  async #stampQueued(authority: string, signal: AbortSignal): Promise<number> {
    if (this.#stamping) return 0; // another stamping round is on its way
    this.#stamping = true;
    try {
      let stamped = 0;
      const waiting = (await this.keptRecords()).filter((r) => r.queued).slice(0, Math.max(1, this.options.queueBatch ?? DEFAULT_QUEUE_BATCH));
      for (const kept of waiting) {
        const token = await this.#timestamp(kept.signed.signature, authority, signal);
        if (token === null) break; // the authority stopped answering: the rest waits on
        // The record's own `created_at` is the device's clock, so its time source stays; the token proves it existed by now.
        await this.#keep({ ...kept, signed: { ...kept.signed, timestamp: token }, queued: false, stampedLaterAt: this.#now().toISOString() });
        stamped++;
      }
      return stamped;
    } finally {
      this.#stamping = false;
    }
  }

  async #keep(kept: KeptRecord): Promise<void> {
    const db = await this.#database();
    if (db) await putRecord(db, kept);
    else this.#memoryRecords.set(kept.signed.record.id, structuredClone(kept));
  }

  /** Appends the report to the principal's local log; nothing leaves the device. */
  async reportPlacement(report: PlacementReport): Promise<void> {
    const max = Math.max(1, this.options.maxLogEntries ?? DEFAULT_LOG_ENTRIES);
    const db = await this.#database();
    if (!db) {
      this.#memoryLog.push(structuredClone(report));
      if (this.#memoryLog.length > max) this.#memoryLog.splice(0, this.#memoryLog.length - max);
      return;
    }
    await appendPlacement(db, report, max);
  }

  /** The placement log, oldest first (what the host shows or exports; the log holds hashes and outcomes, never content). */
  async placements(): Promise<PlacementReport[]> {
    const db = await this.#database();
    return db ? readPlacements(db) : this.#memoryLog.map((r) => structuredClone(r));
  }

  async #database(): Promise<IDBDatabase | undefined> {
    const factory = this.options.indexedDB ?? globalThis.indexedDB;
    if (!factory) return undefined;
    this.#db ??= openProvenanceDatabase(factory, this.#databaseName()).then((db) => {
      const previous = db.onversionchange;
      db.onversionchange = (event) => {
        this.#db = undefined; // closed for a deletion; the next write opens it again
        previous?.call(db, event);
      };
      return db;
    }).catch((error: unknown) => {
      this.#db = undefined;
      throw error;
    });
    return this.#db;
  }

  /**
   * An RFC 3161 token over the signature's bytes (as the engine's), base64 of the authority's whole answer; null when the
   * authority does not answer, or answers with a token whose signature, certificate or nonce does not check out.
   */
  async #timestamp(signature: string, authority: string, signal: AbortSignal): Promise<string | null> {
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(8));
    nonce[0] = (nonce[0]! & 0x7f) | 0x40; // positive, and never a leading zero
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", DeviceSigner.signatureBytes(signature) as BufferSource));
    // A controller and a timer of our own, not AbortSignal.any with AbortSignal.timeout: Node holds those weakly, and a
    // collected one never fires.
    const limit = new AbortController();
    const timer = setTimeout(() => { limit.abort(new DOMException("The time-stamp authority took too long.", "TimeoutError")); }, this.options.timestampTimeoutMs ?? 5000);
    const stop = () => { limit.abort(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(authority, {
        method: "POST",
        headers: { "Content-Type": "application/timestamp-query" },
        body: Rfc3161.request(hash, nonce) as BufferSource,
        redirect: "error",
        credentials: "omit",
        signal: limit.signal,
      });
      if (!response.ok) return null;
      const answer = new Uint8Array(await response.arrayBuffer());
      // The token must be signed by the authority's certificate, which chains to a root we trust, over our hash with our nonce;
      // anything else is no token.
      const roots = [...DIGICERT_TIMESTAMP_ROOTS, ...(this.options.timestampRoots ?? [])];
      return (await Rfc3161.grants(answer, hash, nonce, roots, this.options.crypto ?? globalThis.crypto, this.#now())) ? toBase64(answer) : null;
    } catch (error) {
      if (signal.aborted) throw error;
      return null; // offline, slow or a bad answer: the device's clock, as without an authority
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  }
}
