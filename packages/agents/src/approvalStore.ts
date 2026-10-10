import type { ToolClass } from "@fadenstack/client";

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

interface StoredRow extends StoredApproval {
  agent: string;
}

export interface IndexedDbApprovalStoreOptions {
  /** The database's name (default `fadenstack-approvals`). */
  name?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`; tests pass a fake). */
  indexedDB?: IDBFactory;
}

/** "Allow always" in the browser's IndexedDB: only this origin (the extension or the web page) reads it. */
export class IndexedDbApprovalStore implements ApprovalStore {
  readonly #name: string;
  readonly #factory: IDBFactory;
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbApprovalStoreOptions = {}) {
    this.#name = options.name ?? "fadenstack-approvals";
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here; use MemoryApprovalStore or your own store.");
    this.#factory = factory;
  }

  async list(agent: string): Promise<StoredApproval[]> {
    const rows = await this.#run<StoredRow[]>("readonly", (store) => store.index("agent").getAll(agent));
    return rows.map(({ tool, toolClass, approvedAt }) => ({ tool, toolClass, approvedAt }));
  }

  async add(agent: string, approval: StoredApproval): Promise<void> {
    const row: StoredRow = { agent, tool: approval.tool, toolClass: approval.toolClass, approvedAt: approval.approvedAt };
    await this.#run("readwrite", (store) => store.put(row));
  }

  async remove(agent: string, tool?: string): Promise<void> {
    if (tool !== undefined) {
      await this.#run("readwrite", (store) => store.delete([agent, tool]));
      return;
    }
    for (const approval of await this.list(agent)) await this.#run("readwrite", (store) => store.delete([agent, approval.tool]));
  }

  /** Closes the database (a later call opens it again). */
  close(): void {
    void this.#db?.then((db) => db.close());
    this.#db = undefined;
  }

  async #run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([APPROVALS], mode);
      const request = work(tx.objectStore(APPROVALS));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.#factory.open(this.#name, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(APPROVALS, { keyPath: ["agent", "tool"] }).createIndex("agent", "agent");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onblocked = () => reject(new Error("IndexedDB is blocked by another open version."));
    });
    return this.#db;
  }
}
