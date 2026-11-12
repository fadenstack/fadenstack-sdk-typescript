import { recordContext, type SecretProtector } from "./secretProtection.js";
import { DEFAULT_RETENTION, type SessionRetention, type SessionStore } from "./sessionStore.js";
import {
  ENCRYPTED_FLAG, META_STORE, WorkQueue, openJson, request, sealJson, transact,
  type ListsAgents, type StoreProblemHandler,
} from "./storeSupport.js";
import { titleOf, type SessionInfo, type TranscriptEntry } from "./transcript.js";

const ENTRIES = "entries";
const SESSIONS = "sessions";

/** An entry row. Encrypted: `data` holds the entry; a row an earlier SDK wrote holds it as `entry`. */
interface EntryRow {
  agent: string;
  session: string;
  seq: number;
  data?: Uint8Array;
  entry?: TranscriptEntry;
}

/** What a session row says about the session. */
interface SessionFacts extends SessionInfo {
  /** Entries so far: the next one's sequence number. */
  count: number;
}

/** A session row: encrypted, only the keys are in the clear; a row an earlier SDK wrote holds the facts itself. */
type SessionRow = { agent: string; id: string; data?: Uint8Array } & Partial<SessionFacts>;

export interface IndexedDbSessionStoreOptions {
  /** The database's name (default `fadenstack-sessions`). */
  name?: string;
  retention?: SessionRetention;
  /** The IndexedDB factory (default `globalThis.indexedDB`; tests pass a fake). */
  indexedDB?: IDBFactory;
  /** The factory's key ranges (default `globalThis.IDBKeyRange`). */
  keyRange?: typeof IDBKeyRange;
  /**
   * Encrypts what is written (the agent passes a WebCrypto key per signed-in user). Without one the store keeps plain
   * records as an earlier SDK did. With one, the records an earlier SDK wrote are read once and written back encrypted.
   */
  protector?: SecretProtector;
  /** Told of a record that does not decrypt (never its contents). */
  onProblem?: StoreProblemHandler;
}

/**
 * Sessions in the browser's IndexedDB, per agent: the transcript entry by entry, and a small list entry per
 * session (title, times) so the history opens without reading every transcript. Only this origin (the
 * extension or the web page) can read them; with a `protector` every record is also encrypted, bound to this database
 * and its own key. The newest `maxSessions` are kept, none older than `maxAgeDays`.
 */
export class IndexedDbSessionStore implements SessionStore, ListsAgents {
  readonly #name: string;
  #retention: SessionRetention;
  readonly #factory: IDBFactory;
  readonly #range: typeof IDBKeyRange;
  readonly #protector: SecretProtector | undefined;
  readonly #onProblem: StoreProblemHandler | undefined;
  readonly #writes = new WorkQueue();
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbSessionStoreOptions = {}) {
    this.#name = options.name ?? "fadenstack-sessions";
    this.#retention = options.retention ?? DEFAULT_RETENTION;
    this.#protector = options.protector;
    this.#onProblem = options.onProblem;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here; use MemorySessionStore or your own store.");
    this.#factory = factory;
    const range = options.keyRange ?? globalThis.IDBKeyRange;
    if (!range) throw new Error("IDBKeyRange is not available; pass keyRange with the factory.");
    this.#range = range;
  }

  /** The limits the store prunes by; the agent sets the stricter of the app's and the server's (`withinServerRetention`). */
  setRetention(retention: SessionRetention): void {
    this.#retention = retention;
  }

  append(agent: string, sessionId: string, entry: TranscriptEntry): Promise<void> {
    return this.#writes.run(async () => {
      const db = await this.#open();
      let row: SessionRow | undefined;
      await transact(db, [SESSIONS], "readonly", async (tx) => {
        row = await request<SessionRow | undefined>(tx.objectStore(SESSIONS).get([agent, sessionId]));
      });
      const existing = await this.#facts(row);
      const created = existing === undefined;
      const info: SessionFacts = existing ?? { id: sessionId, agent, started: entry.timestamp, lastActivity: entry.timestamp, title: null, count: 0 };
      const seq = info.count;
      info.count += 1;
      info.lastActivity = entry.timestamp;
      if (info.title === null && entry.type === "user.message") info.title = titleOf(entry.data["text"] as string | undefined);
      // Encrypted before the transaction opens: a transaction does not wait for the platform's crypto.
      const entryRow = await this.#entryRow(agent, sessionId, seq, entry);
      const sessionRow = await this.#sessionRow(agent, info);
      await transact(db, [ENTRIES, SESSIONS], "readwrite", (tx) => {
        tx.objectStore(ENTRIES).put(entryRow);
        tx.objectStore(SESSIONS).put(sessionRow);
        return Promise.resolve();
      });
      if (created) await this.#prune(agent, sessionId);
    });
  }

  async read(agent: string, sessionId: string): Promise<TranscriptEntry[]> {
    const db = await this.#open();
    let rows: EntryRow[] = [];
    await transact(db, [ENTRIES], "readonly", async (tx) => {
      const range = this.#range.bound([agent, sessionId, 0], [agent, sessionId, Number.MAX_SAFE_INTEGER]);
      rows = await request<EntryRow[]>(tx.objectStore(ENTRIES).getAll(range));
    });
    const entries: TranscriptEntry[] = [];
    for (const row of rows) {
      const entry = await this.#entryOf(row);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async list(agent: string): Promise<SessionInfo[]> {
    const db = await this.#open();
    let rows: SessionRow[] = [];
    await transact(db, [SESSIONS], "readonly", async (tx) => {
      rows = await request<SessionRow[]>(tx.objectStore(SESSIONS).index("agent").getAll(agent));
    });
    const infos: SessionInfo[] = [];
    for (const row of rows) {
      const facts = await this.#facts(row);
      if (facts) infos.push({ id: facts.id, agent: facts.agent, started: facts.started, lastActivity: facts.lastActivity, title: facts.title });
    }
    return infos.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  /** The agents this database holds sessions for (the export walks them). */
  async agents(): Promise<string[]> {
    const db = await this.#open();
    let keys: IDBValidKey[] = [];
    await transact(db, [SESSIONS], "readonly", async (tx) => {
      keys = await request<IDBValidKey[]>(tx.objectStore(SESSIONS).getAllKeys());
    });
    return [...new Set(keys.map((k) => (Array.isArray(k) ? String(k[0]) : String(k))))];
  }

  delete(agent: string, sessionId: string): Promise<void> {
    return this.#writes.run(() => this.#delete(agent, sessionId));
  }

  async #delete(agent: string, sessionId: string): Promise<void> {
    const db = await this.#open();
    await transact(db, [ENTRIES, SESSIONS], "readwrite", (tx) => {
      tx.objectStore(ENTRIES).delete(this.#range.bound([agent, sessionId, 0], [agent, sessionId, Number.MAX_SAFE_INTEGER]));
      tx.objectStore(SESSIONS).delete([agent, sessionId]);
      return Promise.resolve();
    });
  }

  /** Closes the database (a later call opens it again). */
  close(): void {
    void this.#db?.then((db) => db.close(), () => undefined);
    this.#db = undefined;
  }

  /** Closes the database and waits until it is closed, so that it can be deleted. */
  async closeAsync(): Promise<void> {
    const db = this.#db;
    this.#db = undefined;
    if (db) (await db.catch(() => undefined))?.close();
  }

  /** Keeps the newest `maxSessions` (the new one among them) not older than the age limit. */
  async #prune(agent: string, keep: string): Promise<void> {
    const cutoff = new Date(Date.now() - this.#retention.maxAgeDays * 86_400_000).toISOString();
    const others = (await this.list(agent)).filter((s) => s.id !== keep);
    const doomed = others.filter((s, i) => i >= this.#retention.maxSessions - 1 || s.lastActivity < cutoff);
    for (const s of doomed) await this.#delete(agent, s.id);
  }

  async #entryRow(agent: string, session: string, seq: number, entry: TranscriptEntry): Promise<EntryRow> {
    if (!this.#protector) return { agent, session, seq, entry };
    return { agent, session, seq, data: await sealJson(this.#protector, entry, recordContext(this.#name, ENTRIES, agent, session, seq)) };
  }

  async #sessionRow(agent: string, facts: SessionFacts): Promise<SessionRow> {
    if (!this.#protector) return { ...facts };
    return { agent, id: facts.id, data: await sealJson(this.#protector, facts, recordContext(this.#name, SESSIONS, agent, facts.id)) };
  }

  /** The entry of a row, or undefined (reported) when it does not decrypt: a record like that is treated as absent. */
  async #entryOf(row: EntryRow): Promise<TranscriptEntry | undefined> {
    if (row.data === undefined) return row.entry;
    return this.#unseal<TranscriptEntry>(row.data, recordContext(this.#name, ENTRIES, row.agent, row.session, row.seq), row.agent);
  }

  async #facts(row: SessionRow | undefined): Promise<SessionFacts | undefined> {
    if (!row) return undefined;
    if (row.data === undefined) return row as SessionFacts;
    return this.#unseal<SessionFacts>(row.data, recordContext(this.#name, SESSIONS, row.agent, row.id), row.agent);
  }

  async #unseal<T>(data: Uint8Array, context: string, agent: string): Promise<T | undefined> {
    if (!this.#protector || !(data instanceof Uint8Array)) {
      this.#onProblem?.({ store: "sessions", kind: "unreadable", agent }); // encrypted, and no way to read it here
      return undefined;
    }
    try {
      return await openJson<T>(this.#protector, data, context);
    } catch {
      this.#onProblem?.({ store: "sessions", kind: "undecryptable", agent });
      return undefined;
    }
  }

  /** Writes the plain records of an earlier SDK back encrypted, once per database (the `meta` flag). */
  async #migrate(db: IDBDatabase): Promise<void> {
    if (!this.#protector) return;
    try {
      let done = false;
      let entries: EntryRow[] = [];
      let sessions: SessionRow[] = [];
      await transact(db, [META_STORE, ENTRIES, SESSIONS], "readonly", async (tx) => {
        done = (await request<unknown>(tx.objectStore(META_STORE).get(ENCRYPTED_FLAG))) === true;
        if (done) return;
        entries = await request<EntryRow[]>(tx.objectStore(ENTRIES).getAll());
        sessions = await request<SessionRow[]>(tx.objectStore(SESSIONS).getAll());
      });
      if (done) return;
      const entryRows = await Promise.all(entries.filter((r) => r.data === undefined && r.entry !== undefined)
        .map((r) => this.#entryRow(r.agent, r.session, r.seq, r.entry!)));
      const sessionRows = await Promise.all(sessions.filter((r) => r.data === undefined)
        .map((r) => this.#sessionRow(r.agent, r as SessionFacts)));
      await transact(db, [META_STORE, ENTRIES, SESSIONS], "readwrite", (tx) => {
        for (const row of entryRows) tx.objectStore(ENTRIES).put(row);
        for (const row of sessionRows) tx.objectStore(SESSIONS).put(row);
        tx.objectStore(META_STORE).put(true, ENCRYPTED_FLAG);
        return Promise.resolve();
      });
    } catch {
      this.#onProblem?.({ store: "sessions", kind: "migration" }); // the plain records stay, readable as they were
    }
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.#factory.open(this.#name, 2);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: ["agent", "session", "seq"] });
        if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: ["agent", "id"] }).createIndex("agent", "agent");
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      };
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => { // another tab or agent deletes the database (deleteMyData): let it, and open again at next use
          db.close();
          this.#db = undefined;
        };
        this.#migrate(db).then(() => resolve(db), () => resolve(db));
      };
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onblocked = () => reject(new Error("IndexedDB is blocked by another open version."));
    });
    return this.#db;
  }
}
