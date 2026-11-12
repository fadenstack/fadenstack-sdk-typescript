import type { SecretProtector } from "./secretProtection.js";

/** Which of the SDK's stores a problem is about. */
export type StoreName = "sessions" | "approvals";

/**
 * Something wrong with a stored record, told to the host (`AgentBuilder.useStoreProblemHandler`) so that it can show the
 * person a notice or count it. It names the store and the kind only: never a record's contents, a title or a tool's
 * arguments, and no error text from the platform.
 */
export interface StoreProblem {
  store: StoreName;
  /**
   * `undecryptable`: the record is not this device key's (another key, or changed) and is treated as absent.
   * `unreadable`: the record has a shape the store does not know. `migration`: an unencrypted record from an earlier SDK
   * could not be rewritten encrypted (it stays readable as it was).
   */
  kind: "undecryptable" | "unreadable" | "migration";
  agent?: string;
}

export type StoreProblemHandler = (problem: StoreProblem) => void;

/** A store that can name the agents it holds data for, which the export walks (as .NET's `IListsAgents`). */
export interface ListsAgents {
  agents(): Promise<string[]>;
}

export function listsAgents(store: unknown): store is ListsAgents {
  return typeof (store as Partial<ListsAgents> | null)?.agents === "function";
}

const META = "meta";
const ENCRYPTED = "encrypted";

/** The `meta` object store of version 2 databases: whether the unencrypted records of an earlier SDK were already rewritten. */
export const META_STORE = META;
export const ENCRYPTED_FLAG = ENCRYPTED;

export function toBytes(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sealJson(protector: SecretProtector, value: unknown, context: string): Promise<Uint8Array> {
  return protector.protect(encoder.encode(JSON.stringify(value)), context);
}

export async function openJson<T>(protector: SecretProtector, data: Uint8Array, context: string): Promise<T> {
  return JSON.parse(decoder.decode(await protector.unprotect(data, context))) as T;
}

export function request<T>(req: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed."));
  });
}

/** Runs `work` in a transaction and settles once the transaction is done (committed or failed). */
export function transact(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<void>): Promise<void> {
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

/** Deletes a database; resolves with whether it existed. Reject when another open connection (another tab) keeps it. */
export function deleteDatabase(factory: IDBFactory, name: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = (event) => resolve(((event as IDBVersionChangeEvent).oldVersion ?? 0) > 0);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB could not delete the database."));
    req.onblocked = () => reject(new Error("The database is open in another tab or window; close it and try again."));
  });
}

/** Serialises async work, so two writes of one store never interleave around their encryption. */
export class WorkQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
