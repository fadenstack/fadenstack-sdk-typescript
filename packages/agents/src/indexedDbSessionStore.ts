import { DEFAULT_RETENTION, type SessionRetention, type SessionStore } from "./sessionStore.js";
import { titleOf, type SessionInfo, type TranscriptEntry } from "./transcript.js";

const ENTRIES = "entries";
const SESSIONS = "sessions";

interface StoredEntry {
  agent: string;
  session: string;
  seq: number;
  entry: TranscriptEntry;
}

interface StoredSession extends SessionInfo {
  /** Entries so far: the next one's sequence number. */
  count: number;
}

export interface IndexedDbSessionStoreOptions {
  /** The database's name (default `fadenstack-sessions`). */
  name?: string;
  retention?: SessionRetention;
  /** The IndexedDB factory (default `globalThis.indexedDB`; tests pass a fake). */
  indexedDB?: IDBFactory;
  /** The factory's key ranges (default `globalThis.IDBKeyRange`). */
  keyRange?: typeof IDBKeyRange;
}

/**
 * Sessions in the browser's IndexedDB, per agent: the transcript entry by entry, and a small list entry per
 * session (title, times) so the history opens without reading every transcript. Only this origin (the
 * extension or the web page) can read them; they are not encrypted beyond what the browser does for its
 * profile. The newest `maxSessions` are kept, none older than `maxAgeDays`.
 */
export class IndexedDbSessionStore implements SessionStore {
  readonly #name: string;
  readonly #retention: SessionRetention;
  readonly #factory: IDBFactory;
  readonly #range: typeof IDBKeyRange;
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbSessionStoreOptions = {}) {
    this.#name = options.name ?? "fadenstack-sessions";
    this.#retention = options.retention ?? DEFAULT_RETENTION;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here; use MemorySessionStore or your own store.");
    this.#factory = factory;
    const range = options.keyRange ?? globalThis.IDBKeyRange;
    if (!range) throw new Error("IDBKeyRange is not available; pass keyRange with the factory.");
    this.#range = range;
  }

  async append(agent: string, sessionId: string, entry: TranscriptEntry): Promise<void> {
    const db = await this.#open();
    let created = false;
    await transact(db, [ENTRIES, SESSIONS], "readwrite", async (tx) => {
      const sessions = tx.objectStore(SESSIONS);
      const existing = await request<StoredSession | undefined>(sessions.get([agent, sessionId]));
      created = existing === undefined;
      const info: StoredSession = existing ?? {
        id: sessionId, agent, started: entry.timestamp, lastActivity: entry.timestamp, title: null, count: 0,
      };
      tx.objectStore(ENTRIES).put({ agent, session: sessionId, seq: info.count, entry } satisfies StoredEntry);
      info.count += 1;
      info.lastActivity = entry.timestamp;
      if (info.title === null && entry.type === "user.message") info.title = titleOf(entry.data["text"] as string | undefined);
      sessions.put(info);
    });
    if (created) await this.#prune(agent, sessionId);
  }

  async read(agent: string, sessionId: string): Promise<TranscriptEntry[]> {
    const db = await this.#open();
    let rows: StoredEntry[] = [];
    await transact(db, [ENTRIES], "readonly", async (tx) => {
      const range = this.#range.bound([agent, sessionId, 0], [agent, sessionId, Number.MAX_SAFE_INTEGER]);
      rows = await request<StoredEntry[]>(tx.objectStore(ENTRIES).getAll(range));
    });
    return rows.map((r) => r.entry);
  }

  async list(agent: string): Promise<SessionInfo[]> {
    const db = await this.#open();
    let rows: StoredSession[] = [];
    await transact(db, [SESSIONS], "readonly", async (tx) => {
      rows = await request<StoredSession[]>(tx.objectStore(SESSIONS).index("agent").getAll(agent));
    });
    return rows
      .map(({ id, agent: a, started, lastActivity, title }) => ({ id, agent: a, started, lastActivity, title }))
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  async delete(agent: string, sessionId: string): Promise<void> {
    const db = await this.#open();
    await transact(db, [ENTRIES, SESSIONS], "readwrite", (tx) => {
      tx.objectStore(ENTRIES).delete(this.#range.bound([agent, sessionId, 0], [agent, sessionId, Number.MAX_SAFE_INTEGER]));
      tx.objectStore(SESSIONS).delete([agent, sessionId]);
      return Promise.resolve();
    });
  }

  /** Closes the database (a later call opens it again). */
  close(): void {
    void this.#db?.then((db) => db.close());
    this.#db = undefined;
  }

  /** Keeps the newest `maxSessions` (the new one among them) not older than the age limit. */
  async #prune(agent: string, keep: string): Promise<void> {
    const cutoff = new Date(Date.now() - this.#retention.maxAgeDays * 86_400_000).toISOString();
    const others = (await this.list(agent)).filter((s) => s.id !== keep);
    const doomed = others.filter((s, i) => i >= this.#retention.maxSessions - 1 || s.lastActivity < cutoff);
    for (const s of doomed) await this.delete(agent, s.id);
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.#factory.open(this.#name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore(ENTRIES, { keyPath: ["agent", "session", "seq"] });
        const sessions = db.createObjectStore(SESSIONS, { keyPath: ["agent", "id"] });
        sessions.createIndex("agent", "agent");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onblocked = () => reject(new Error("IndexedDB is blocked by another open version."));
    });
    return this.#db;
  }
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed."));
  });
}

/** Runs `work` in a transaction and settles once the transaction is done (committed or failed). */
function transact(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    work(tx).catch((error: unknown) => {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      reject(error);
    });
  });
}
