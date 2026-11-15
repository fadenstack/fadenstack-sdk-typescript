import { browserSecretProtector, userStoreName, recordContext, type SecretProtector } from "@fadenstack/agents";

import { McpStoreError } from "./errors.js";
import { recordOf, type McpServerRecord } from "./servers.js";

/** Whose servers they are: the tenant and the user of an agent profile's principal. */
export interface StorePrincipal {
  tenantId: string;
  userId: string;
}

/**
 * Where the person's own MCP servers are kept (sdk/51 F05; .NET: the desktop's `McpServerStore`, which is a file). Every change
 * tells the listeners, and the module reads the servers again at the start of the agent's next turn. The header values are
 * secrets: the stores that persist them seal them under the person's key.
 */
export interface McpServerStore {
  /** The servers kept, by label, headers in the clear. A record whose headers cannot be decrypted comes with `headersUnreadable` and no headers. */
  list(): Promise<StoredMcpServer[]>;
  get(label: string): Promise<StoredMcpServer | undefined>;
  /**
   * Keeps the server, replacing one of the same label; when it was renamed (`previousLabel`) the record it came from is removed in
   * the same step. Throws `McpConfigError` for a record that breaks a rule, `McpStoreError` when its headers cannot be sealed or
   * its label is taken by another server (labels are unique without regard to case).
   */
  save(server: McpServerRecord, previousLabel?: string): Promise<void>;
  /** Removes the server; whether there was one. */
  remove(label: string): Promise<boolean>;
  /**
   * Calls `listener` after a change; returns the unsubscribe. The IndexedDB store also calls it after a change another context
   * made to the same database (a side panel and a service worker, two tabs): the module and a Tools view follow it.
   */
  onChanged(listener: () => void): () => void;
  /**
   * Adds a line to the device's audit log of the person's switches (sdk/51 F05), kept with the servers (deleted with the person's
   * data); beyond `MCP_AUDIT_MAX` lines the oldest go. Nothing in it leaves the device. .NET: `McpAuditLog`.
   */
  appendAudit(entry: McpAuditEntry): Promise<void>;
  /** The audit log, oldest first. */
  audit(): Promise<McpAuditEntry[]>;
  /** Releases what the store holds open (an IndexedDB connection). */
  close(): void;
}

/**
 * One change the person made that the device keeps for audit: when, what, the server's source (its origin, never a path, query
 * or token), on or off, the version of the warning confirmed before turning it on, and who. .NET: `McpAuditEntry`.
 */
export interface McpAuditEntry {
  /** `local_mcp.plain_http`: the switch "Allow plain http on the local network". */
  event: "local_mcp.plain_http";
  /** ISO 8601, UTC. */
  at: string;
  /** The server's origin, `http://host[:port]`. */
  source: string;
  state: "on" | "off";
  /** The warning's version, when turning it on; null when turning it off. */
  warning_version: string | null;
  /** `<tenant>/<user>`, or `standalone`. */
  person: string;
}

/** How many lines the audit log keeps (it rotates by count, where .NET's file rotates by size, as the placement log does). */
export const MCP_AUDIT_MAX = 500;

/** A record as the store hands it back. */
export type StoredMcpServer = McpServerRecord & { headersUnreadable?: boolean };

abstract class ObservableStore {
  readonly #listeners = new Set<() => void>();

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  protected changed(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // a listener that fails never fails the change
      }
    }
  }
}

function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function byLabel(a: { label: string }, b: { label: string }): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** The servers in memory: for a host without IndexedDB, and for tests. Nothing is written anywhere, so nothing is sealed. */
export class MemoryMcpServerStore extends ObservableStore implements McpServerStore {
  readonly #servers = new Map<string, McpServerRecord>();
  readonly #audit: McpAuditEntry[] = [];

  async appendAudit(entry: McpAuditEntry): Promise<void> {
    this.#audit.push(structuredClone(entry));
    if (this.#audit.length > MCP_AUDIT_MAX) this.#audit.splice(0, this.#audit.length - MCP_AUDIT_MAX);
  }

  async audit(): Promise<McpAuditEntry[]> {
    return this.#audit.map((e) => structuredClone(e));
  }

  async list(): Promise<StoredMcpServer[]> {
    return [...this.#servers.values()].sort(byLabel).map((s) => structuredClone(s));
  }

  async get(label: string): Promise<StoredMcpServer | undefined> {
    const found = this.#servers.get(label);
    return found ? structuredClone(found) : undefined;
  }

  async save(server: McpServerRecord, previousLabel?: string): Promise<void> {
    const kept = recordOf(server);
    for (const other of this.#servers.keys()) {
      if (other !== kept.label && other !== previousLabel && sameLabel(other, kept.label)) throw new McpStoreError(`The label '${kept.label}' is taken.`);
    }
    if (previousLabel !== undefined && previousLabel !== kept.label) this.#servers.delete(previousLabel);
    this.#servers.set(kept.label, structuredClone(kept));
    this.changed();
  }

  async remove(label: string): Promise<boolean> {
    const had = this.#servers.delete(label);
    if (had) this.changed();
    return had;
  }

  close(): void {
    // nothing is held open
  }
}

// Version 2 added the `audit` store (sdk/51 F05); an upgrade makes only the stores that are missing, so the servers stay.
const VERSION = 2;
const SERVERS = "servers";
const AUDIT = "audit";

/** What IndexedDB holds for one server: everything but the headers' values in the clear, the values sealed. */
interface Stored {
  label: string;
  url: string;
  enabled: boolean;
  trusted: boolean;
  toolClasses: Record<string, "read" | "write">;
  callTimeoutS?: number;
  importedFrom?: string;
  reviewed: boolean;
  plainHttpInLan?: boolean;
  /** The header names, readable so a list can show them. */
  headerNames: string[];
  /** The headers as JSON, sealed (`SecretProtector`); absent for a server without headers. */
  sealed?: Uint8Array;
}

export interface IndexedDbMcpServerStoreOptions {
  /** Whose database it is (`userStoreName("fadenstack-mcp", principal)`); a function is asked on every use. Without one: the standalone principal's. */
  principal?: StorePrincipal | undefined | (() => StorePrincipal | undefined);
  /** The database's own name, instead of the principal's. */
  name?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`). */
  indexedDB?: IDBFactory;
  /**
   * Tell the other contexts of this origin about a change, and hear theirs (a `BroadcastChannel`, where there is one); default
   * true. The message carries the database's name only.
   */
  broadcast?: boolean;
  /**
   * What seals the header values. By default the person's WebCrypto key (`fadenstack-keys`, the one the agent's sessions use, per
   * principal); where there is none, a server with headers is refused (`McpStoreError`) rather than kept in the clear.
   */
  protector?: SecretProtector;
}

/** The standalone principal's tenant and user, as the agent's local profile names them: its data lives in stores of its own. */
const STANDALONE: StorePrincipal = Object.freeze({ tenantId: "standalone", userId: "standalone" });

/** The channel on which the stores of one origin say that a database changed (its name, nothing else). */
export const MCP_STORE_CHANNEL = "fadenstack-mcp-changes";

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed."));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The person's own MCP servers in IndexedDB, one database per principal (`fadenstack-mcp`, then the tenant and the user as
 * `userStoreName` writes them; standalone is its own principal), so deleting a person's data removes them and two people in one
 * browser profile never see each other's. The header values (a token) are sealed with the principal's WebCrypto key, bound to
 * the database, the store and the label, so a record cannot be moved and still decrypt; deleting the data deletes the key.
 * Without IndexedDB use `MemoryMcpServerStore` (`openMcpServerStore` picks).
 */
export class IndexedDbMcpServerStore extends ObservableStore implements McpServerStore {
  readonly #options: IndexedDbMcpServerStoreOptions;
  readonly #factory: IDBFactory;
  readonly #protectors = new Map<string, SecretProtector | undefined>();
  #open: { name: string; db: Promise<IDBDatabase> } | undefined;
  #channel: BroadcastChannel | undefined;

  constructor(options: IndexedDbMcpServerStoreOptions = {}) {
    super();
    this.#options = options;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("There is no IndexedDB here: use MemoryMcpServerStore.");
    this.#factory = factory;
  }

  override onChanged(listener: () => void): () => void {
    const unsubscribe = super.onChanged(listener);
    this.#listen();
    return unsubscribe;
  }

  /** The database this store reads and writes now. */
  get databaseName(): string {
    if (this.#options.name) return this.#options.name;
    return userStoreName("fadenstack-mcp", this.#principal());
  }

  #principal(): StorePrincipal | undefined {
    const principal = this.#options.principal;
    return typeof principal === "function" ? principal() : principal ?? STANDALONE;
  }

  /** The protector for the database named now: the host's, or the person's own key (made once per principal). */
  #protector(): SecretProtector | undefined {
    if (this.#options.protector) return this.#options.protector;
    const keys = userStoreName("fadenstack-keys", this.#principal());
    if (!this.#protectors.has(keys)) this.#protectors.set(keys, browserSecretProtector(keys, this.#factory)?.protector);
    return this.#protectors.get(keys);
  }

  async list(): Promise<StoredMcpServer[]> {
    const db = await this.#db();
    const rows = await request<Stored[]>(db.transaction([SERVERS], "readonly").objectStore(SERVERS).getAll());
    const opened = await Promise.all(rows.map((row) => this.#unseal(row)));
    return opened.sort(byLabel);
  }

  async get(label: string): Promise<StoredMcpServer | undefined> {
    const db = await this.#db();
    const row = await request<Stored | undefined>(db.transaction([SERVERS], "readonly").objectStore(SERVERS).get(label));
    return row ? this.#unseal(row) : undefined;
  }

  async save(server: McpServerRecord, previousLabel?: string): Promise<void> {
    const kept = recordOf(server);
    const db = await this.#db();
    const name = this.databaseName;
    const headerNames = Object.keys(kept.headers);
    const row: Stored = {
      label: kept.label,
      url: kept.url,
      enabled: kept.enabled,
      trusted: kept.trusted,
      toolClasses: { ...kept.toolClasses },
      ...(kept.callTimeoutS !== undefined ? { callTimeoutS: kept.callTimeoutS } : {}),
      ...(kept.importedFrom !== undefined ? { importedFrom: kept.importedFrom } : {}),
      reviewed: kept.reviewed,
      ...(kept.plainHttpInLan === true ? { plainHttpInLan: true } : {}),
      headerNames,
    };
    if (headerNames.length > 0) {
      const protector = this.#protector();
      if (!protector) throw new McpStoreError("There is no key here to seal the headers with: they are not kept in the clear.");
      row.sealed = await protector.protect(encoder.encode(JSON.stringify(kept.headers)), recordContext(name, SERVERS, kept.label));
    }
    // Sealed first (WebCrypto would end the transaction); then the label check and the write in one transaction, so another
    // context cannot take the label between them.
    const tx = db.transaction([SERVERS], "readwrite");
    const done = finished(tx);
    const store = tx.objectStore(SERVERS);
    const taken = (await request<IDBValidKey[]>(store.getAllKeys())).map(String);
    if (taken.some((other) => other !== kept.label && other !== previousLabel && sameLabel(other, kept.label))) {
      tx.abort();
      await done.catch(() => undefined);
      throw new McpStoreError(`The label '${kept.label}' is taken.`);
    }
    if (previousLabel !== undefined && previousLabel !== kept.label) store.delete(previousLabel);
    store.put(row, kept.label);
    await done;
    this.changed();
    this.#tellOthers(name);
  }

  async remove(label: string): Promise<boolean> {
    const db = await this.#db();
    const tx = db.transaction([SERVERS], "readwrite");
    const done = finished(tx);
    const store = tx.objectStore(SERVERS);
    const had = (await request<number>(store.count(label))) > 0;
    if (had) store.delete(label);
    await done;
    if (had) {
      this.changed();
      this.#tellOthers(db.name);
    }
    return had;
  }

  async appendAudit(entry: McpAuditEntry): Promise<void> {
    const db = await this.#db();
    const tx = db.transaction([AUDIT], "readwrite");
    const done = finished(tx);
    const store = tx.objectStore(AUDIT);
    store.add(structuredClone(entry));
    const count = await request<number>(store.count());
    if (count > MCP_AUDIT_MAX) {
      for (const key of await request<IDBValidKey[]>(store.getAllKeys(undefined, count - MCP_AUDIT_MAX))) store.delete(key);
    }
    await done;
  }

  async audit(): Promise<McpAuditEntry[]> {
    const db = await this.#db();
    return request<McpAuditEntry[]>(db.transaction([AUDIT], "readonly").objectStore(AUDIT).getAll());
  }

  close(): void {
    this.#closeDb();
    this.#channel?.close();
    this.#channel = undefined;
  }

  /** Lets the database connection go (another principal's is opened next); the channel stays for the listeners. */
  #closeDb(): void {
    const open = this.#open;
    this.#open = undefined;
    void open?.db.then((db) => db.close(), () => undefined);
  }

  /** The channel to the other contexts, opened when someone listens or something changed; none where there is no BroadcastChannel. */
  #listen(): BroadcastChannel | undefined {
    if (this.#channel || this.#options.broadcast === false || typeof BroadcastChannel === "undefined") return this.#channel;
    const channel = new BroadcastChannel(MCP_STORE_CHANNEL);
    (channel as { unref?: () => void }).unref?.(); // Node: an open channel does not keep the process running
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const said = event.data as { database?: unknown } | null;
      // Another context changed a database of this origin; only this store's own counts, and listeners only read again.
      if (said && typeof said === "object" && said.database === this.databaseName) this.changed();
    };
    this.#channel = channel;
    return channel;
  }

  #tellOthers(database: string): void {
    try {
      this.#listen()?.postMessage({ database });
    } catch {
      // the channel was closed meanwhile: the others read the list at their next turn anyway
    }
  }

  async #unseal(row: Stored): Promise<StoredMcpServer> {
    const { sealed, ...rest } = row;
    const record: StoredMcpServer = recordOf({ ...rest, headers: {} });
    if (sealed === undefined) return record;
    try {
      const protector = this.#protector();
      if (!protector) throw new McpStoreError("no key");
      const text = decoder.decode(await protector.unprotect(sealed, recordContext(this.databaseName, SERVERS, row.label)));
      record.headers = JSON.parse(text) as Record<string, string>;
    } catch {
      // the key is gone or the record was changed: the server is listed, its headers are not, and the module leaves it off
      record.headersUnreadable = true;
      record.enabled = false;
    }
    return record;
  }

  /** The connection to the database of the principal now: a new one when the principal changed. */
  #db(): Promise<IDBDatabase> {
    const name = this.databaseName;
    if (this.#open?.name !== name) {
      this.#closeDb();
      const db = new Promise<IDBDatabase>((resolve, reject) => {
        const opening = this.#factory.open(name, VERSION);
        opening.onupgradeneeded = () => {
          if (!opening.result.objectStoreNames.contains(SERVERS)) opening.result.createObjectStore(SERVERS);
          if (!opening.result.objectStoreNames.contains(AUDIT)) opening.result.createObjectStore(AUDIT, { autoIncrement: true });
        };
        opening.onsuccess = () => {
          const connection = opening.result;
          connection.onversionchange = () => {
            // a deletion of the person's data must not be held up by this connection; the next use opens a new one
            connection.close();
            if (this.#open?.db === db) this.#open = undefined;
          };
          resolve(connection);
        };
        opening.onerror = () => reject(opening.error ?? new Error("The MCP database could not be opened."));
        opening.onblocked = () => reject(new Error("The MCP database is blocked by another open version."));
      });
      this.#open = { name, db };
      db.catch(() => {
        if (this.#open?.db === db) this.#open = undefined; // try again next time
      });
    }
    return this.#open!.db;
  }
}

/** The person's servers in IndexedDB where there is one, in memory where there is not. */
export function openMcpServerStore(options: IndexedDbMcpServerStoreOptions = {}): McpServerStore {
  return options.indexedDB ?? globalThis.indexedDB ? new IndexedDbMcpServerStore(options) : new MemoryMcpServerStore();
}
