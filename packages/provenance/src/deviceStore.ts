import type { PlacementReport } from "@fadenstack/client";

/** The database a principal's device signing key and placement log live in (one per principal, `userStoreName`). */
const VERSION = 1;
const KEYS = "keys";
const PLACEMENTS = "placements";
const KEY_NAME = "signing";

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

/** Opens the database, making its two object stores (`keys`, `placements`) on first use. */
export function openProvenanceDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS);
      if (!db.objectStoreNames.contains(PLACEMENTS)) db.createObjectStore(PLACEMENTS, { autoIncrement: true });
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close(); // a deletion (`deleteMyData`) must not be held up by this connection
      resolve(db);
    };
    open.onerror = () => reject(open.error ?? new Error("The provenance database could not be opened."));
    open.onblocked = () => reject(new Error("The provenance database is blocked by another open version."));
  });
}

/** The stored key row, or undefined. */
export async function readKey(db: IDBDatabase): Promise<unknown> {
  return request<unknown>(db.transaction([KEYS], "readonly").objectStore(KEYS).get(KEY_NAME));
}

/**
 * Stores `row` unless a usable one is there already (another tab made its key a moment ago): the row now stored. An unusable
 * row (damaged, not a P-256 signing key) is replaced.
 */
export async function writeKeyIfAbsent(db: IDBDatabase, row: unknown, usable: (stored: unknown) => boolean): Promise<unknown> {
  const tx = db.transaction([KEYS], "readwrite");
  const done = finished(tx);
  const store = tx.objectStore(KEYS);
  const existing = await request<unknown>(store.get(KEY_NAME));
  let chosen = row;
  if (usable(existing)) chosen = existing;
  else store.put(row, KEY_NAME);
  await done;
  return chosen;
}

/** Appends a report; beyond `max` entries the oldest go (the log rotates by count, where .NET's file rotates by size). */
export async function appendPlacement(db: IDBDatabase, report: PlacementReport, max: number): Promise<void> {
  const tx = db.transaction([PLACEMENTS], "readwrite");
  const done = finished(tx);
  const store = tx.objectStore(PLACEMENTS);
  store.add(structuredClone(report));
  const count = await request<number>(store.count());
  if (count > max) {
    const oldest = await request<IDBValidKey[]>(store.getAllKeys(undefined, count - max));
    for (const key of oldest) store.delete(key);
  }
  await done;
}

/** Every report in the log, oldest first. */
export async function readPlacements(db: IDBDatabase): Promise<PlacementReport[]> {
  return request<PlacementReport[]>(db.transaction([PLACEMENTS], "readonly").objectStore(PLACEMENTS).getAll());
}
