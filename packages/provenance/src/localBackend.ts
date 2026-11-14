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
import { userStoreName } from "@fadenstack/agents";

import { DeviceSigner, toBase64 } from "./deviceSigner.js";
import { appendPlacement, openProvenanceDatabase, readPlacements } from "./deviceStore.js";
import { Rfc3161 } from "./rfc3161.js";
import type { ProvenanceBackend } from "./types.js";

/** What the device's own provenance backend does beyond its defaults. .NET: `LocalProvenanceOptions`. */
export interface LocalProvenanceOptions {
  /**
   * The RFC 3161 time-stamp authority a record's signature is sent to (only the signature's SHA-256 leaves the device); none
   * by default, and the record's time is the device's clock. .NET defaults to DigiCert's free service, which answers over
   * http only: a browser's `fetch` cannot reach it from an https page, so here the app names an authority it can reach
   * (an https one, or its own relay) or leaves it out.
   */
  timestampAuthority?: string | URL | null;
  /** Whether records are time-stamped at all (default true; with no authority named, nothing is sent either way). The machine policy can switch it off (F09). */
  timestamping?: boolean;
  /** How long the authority may take, in milliseconds, before the record goes without a token (default 5000). */
  timestampTimeoutMs?: number;
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
  /** Whether the machine policy lets records be time-stamped (F09). */
  timestampingAllowed(): boolean;
  /** Whose database the key and the log go in. */
  principal(): { tenantId: string; userId: string } | undefined;
}

const SOURCE_TYPES = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const DEFAULT_LOG_ENTRIES = 2000;
const STANDALONE = { tenantId: "standalone", userId: "standalone" };

/**
 * Provenance with no server (sdk/51 F10): the device's own policy defaults, records signed on the device in the server's
 * format (`DeviceSigner`) with an RFC 3161 time-stamp when an authority is named and answers, and placements in a local log
 * that rotates. Nothing leaves the device but the signature's hash to the time-stamp authority, and that only when allowed.
 * .NET: `LocalProvenanceBackend`.
 *
 * The record's `content_hash` is the plain SHA-256 of the content (`hash_key_version` 0): a server's is a keyed HMAC under
 * its own key version, which a device does not have. Without a token, the signed `created_at` is the device's clock, as on
 * a server without an authority.
 */
export class LocalProvenanceBackend implements ProvenanceBackend {
  /** The `hash_key_version` of a device's record: the content's plain SHA-256. */
  static readonly plainHashKeyVersion = 0;

  readonly options: LocalProvenanceOptions;
  readonly #context: LocalProvenanceContext | undefined;
  #signer: Promise<DeviceSigner> | undefined;
  #db: Promise<IDBDatabase | undefined> | undefined;
  #memoryLog: PlacementReport[] = [];

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
      created_at: new Date().toISOString(),
      media_type: request.media_type,
      content_hash: request.content_sha256,
      hash_key_version: LocalProvenanceBackend.plainHashKeyVersion,
      ...(request.text_sha256 ? { text_hash: request.text_sha256 } : {}),
      ...(request.model ? { model: { id: request.model } } : {}),
      ...(request.receipt_id ? { receipt_id: request.receipt_id } : {}),
    };
    const signature = await (await this.signer()).sign(record);
    // The machine policy may switch time-stamps off (F09): then nothing leaves the device at all.
    const timestamp = (this.#context?.timestampingAllowed() ?? true) ? await this.#timestamp(signature, signal) : null;
    return { record, signature, timestamp };
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
   * An RFC 3161 token over the signature's bytes (as the engine's), base64 of the authority's whole answer; null when no
   * authority is named, when switched off, offline, or when the authority does not answer usably.
   */
  async #timestamp(signature: string, signal: AbortSignal): Promise<string | null> {
    const authority = this.options.timestampAuthority;
    if (this.options.timestamping === false || !authority) return null;
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
      const response = await (this.options.fetch ?? globalThis.fetch)(String(authority), {
        method: "POST",
        headers: { "Content-Type": "application/timestamp-query" },
        body: Rfc3161.request(hash, nonce) as BufferSource,
        redirect: "error",
        credentials: "omit",
        signal: limit.signal,
      });
      if (!response.ok) return null;
      const answer = new Uint8Array(await response.arrayBuffer());
      // The token must be granted over our hash with our nonce; anything else is no token.
      return Rfc3161.grants(answer, hash, nonce) ? toBase64(answer) : null;
    } catch (error) {
      if (signal.aborted) throw error;
      return null; // offline, slow or a bad answer: the device's clock, as without an authority
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  }
}
