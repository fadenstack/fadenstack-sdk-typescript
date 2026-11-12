import type { ToolClass } from "@fadenstack/client";
import { recordContext, type SecretProtector } from "./secretProtection.js";
import {
  ENCRYPTED_FLAG, META_STORE, openJson, request, sealJson, transact,
  type ListsAgents, type StoreProblemHandler,
} from "./storeSupport.js";

/** A tool the user allowed always, for one agent on this device. */
export interface StoredApproval {
  tool: string;
  /** The class it had then: the approval holds only while the tool still has it. */
  toolClass: ToolClass;
  /** ISO 8601. */
  approvedAt: string;
}

/**
 * Where "Allow always" is kept, per agent, on this device. Like the session store, integrators may plug their own.
 * The SDK checks a stored approval at every call: a tool that became destructive or unclassified, or that an
 * admin's rule covers, asks again.
 */
export interface ApprovalStore {
  list(agent: string): Promise<StoredApproval[]>;
  /** Adds one, replacing the tool's earlier approval. */
  add(agent: string, approval: StoredApproval): Promise<void>;
  /** Forgets one tool's approval, or all of the agent's when `tool` is not given. */
  remove(agent: string, tool?: string): Promise<void>;
}

/** Approvals in memory only: gone with the page or process. */
export class MemoryApprovalStore implements ApprovalStore {
  readonly #approvals = new Map<string, StoredApproval[]>();

  list(agent: string): Promise<StoredApproval[]> {
    return Promise.resolve((this.#approvals.get(agent) ?? []).map((a) => ({ ...a })));
  }

  add(agent: string, approval: StoredApproval): Promise<void> {
    const kept = (this.#approvals.get(agent) ?? []).filter((a) => a.tool !== approval.tool);
    this.#approvals.set(agent, [...kept, { ...approval }]);
    return Promise.resolve();
  }

  remove(agent: string, tool?: string): Promise<void> {
    if (tool === undefined) this.#approvals.delete(agent);
    else this.#approvals.set(agent, (this.#approvals.get(agent) ?? []).filter((a) => a.tool !== tool));
    return Promise.resolve();
  }
}

const APPROVALS = "approvals";

/** A row: encrypted, `data` holds the class and time; a row an earlier SDK wrote holds them itself. */
interface StoredRow {
  agent: string;
  tool: string;
  data?: Uint8Array;
  toolClass?: ToolClass;
  approvedAt?: string;
}

interface Sealed {
  toolClass: ToolClass;
  approvedAt: string;
}

export interface IndexedDbApprovalStoreOptions {
  /** The database's name (default `fadenstack-approvals`). */
  name?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`; tests pass a fake). */
  indexedDB?: IDBFactory;
  /**
   * Encrypts what is written. Without one the store keeps plain records as an earlier SDK did. With one, the records an
   * earlier SDK wrote are read once and written back encrypted. (The tool's name stays in the clear: it is the key.)
   */
  protector?: SecretProtector;
  /** Told of a record that does not decrypt (never its contents). */
  onProblem?: StoreProblemHandler;
}

/**
 * "Allow always" in the browser's IndexedDB: only this origin (the extension or the web page) reads it; with a `protector`
 * each record is also encrypted, bound to this database and to its agent and tool.
 */
export class IndexedDbApprovalStore implements ApprovalStore, ListsAgents {
  readonly #name: string;
  readonly #factory: IDBFactory;
  readonly #protector: SecretProtector | undefined;
  readonly #onProblem: StoreProblemHandler | undefined;
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbApprovalStoreOptions = {}) {
    this.#name = options.name ?? "fadenstack-approvals";
    this.#protector = options.protector;
    this.#onProblem = options.onProblem;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here; use MemoryApprovalStore or your own store.");
    this.#factory = factory;
  }

  async list(agent: string): Promise<StoredApproval[]> {
    const rows = await this.#run<StoredRow[]>("readonly", (store) => store.index("agent").getAll(agent));
    const approvals: StoredApproval[] = [];
    for (const row of rows) {
      const approval = await this.#approvalOf(row);
      if (approval) approvals.push(approval);
    }
    return approvals;
  }

  async add(agent: string, approval: StoredApproval): Promise<void> {
    const row = await this.#row(agent, approval);
    await this.#run("readwrite", (store) => store.put(row));
  }

  async remove(agent: string, tool?: string): Promise<void> {
    if (tool !== undefined) {
      await this.#run("readwrite", (store) => store.delete([agent, tool]));
      return;
    }
    // By key, not by what lists: a record that does not decrypt is the person's to be rid of as well.
    const rows = await this.#run<StoredRow[]>("readonly", (store) => store.index("agent").getAll(agent));
    for (const row of rows) await this.#run("readwrite", (store) => store.delete([agent, row.tool]));
  }

  /** The agents this database holds approvals for (the export walks them). */
  async agents(): Promise<string[]> {
    const keys = await this.#run<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
    return [...new Set(keys.map((k) => (Array.isArray(k) ? String(k[0]) : String(k))))];
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

  async #row(agent: string, approval: StoredApproval): Promise<StoredRow> {
    if (!this.#protector) return { agent, tool: approval.tool, toolClass: approval.toolClass, approvedAt: approval.approvedAt };
    const sealed: Sealed = { toolClass: approval.toolClass, approvedAt: approval.approvedAt };
    return { agent, tool: approval.tool, data: await sealJson(this.#protector, sealed, recordContext(this.#name, APPROVALS, agent, approval.tool)) };
  }

  /** The approval of a row, or undefined (reported) when it does not decrypt: a record like that is treated as absent. */
  async #approvalOf(row: StoredRow): Promise<StoredApproval | undefined> {
    if (row.data === undefined) return { tool: row.tool, toolClass: row.toolClass!, approvedAt: row.approvedAt! };
    if (!this.#protector || !(row.data instanceof Uint8Array)) {
      this.#onProblem?.({ store: "approvals", kind: "unreadable", agent: row.agent });
      return undefined;
    }
    try {
      const sealed = await openJson<Sealed>(this.#protector, row.data, recordContext(this.#name, APPROVALS, row.agent, row.tool));
      return { tool: row.tool, toolClass: sealed.toolClass, approvedAt: sealed.approvedAt };
    } catch {
      this.#onProblem?.({ store: "approvals", kind: "undecryptable", agent: row.agent });
      return undefined;
    }
  }

  /** Writes the plain records of an earlier SDK back encrypted, once per database (the `meta` flag). */
  async #migrate(db: IDBDatabase): Promise<void> {
    if (!this.#protector) return;
    try {
      let done = false;
      let rows: StoredRow[] = [];
      await transact(db, [META_STORE, APPROVALS], "readonly", async (tx) => {
        done = (await request<unknown>(tx.objectStore(META_STORE).get(ENCRYPTED_FLAG))) === true;
        if (!done) rows = await request<StoredRow[]>(tx.objectStore(APPROVALS).getAll());
      });
      if (done) return;
      const sealed = await Promise.all(rows.filter((r) => r.data === undefined)
        .map((r) => this.#row(r.agent, { tool: r.tool, toolClass: r.toolClass!, approvedAt: r.approvedAt! })));
      await transact(db, [META_STORE, APPROVALS], "readwrite", (tx) => {
        for (const row of sealed) tx.objectStore(APPROVALS).put(row);
        tx.objectStore(META_STORE).put(true, ENCRYPTED_FLAG);
        return Promise.resolve();
      });
    } catch {
      this.#onProblem?.({ store: "approvals", kind: "migration" }); // the plain records stay, readable as they were
    }
  }

  async #run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([APPROVALS], mode);
      const req = work(tx.objectStore(APPROVALS));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.#factory.open(this.#name, 2);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(APPROVALS)) db.createObjectStore(APPROVALS, { keyPath: ["agent", "tool"] }).createIndex("agent", "agent");
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
