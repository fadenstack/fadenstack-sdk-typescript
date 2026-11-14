import type { PlacementReport } from "@fadenstack/client";

import type { KeptRecord } from "./localBackend.js";

/**
 * The database a principal's device signing key, kept records and placement log live in (one per principal, `userStoreName`),
 * so deleting the principal's data (`deleteMyData`) removes all three (OWASP ASVS 5.0 V14). Version 2 added the `records` store;
 * an upgrade makes only the stores that are missing, so an existing database keeps its key and its log.
 */
const VERSION = 2;
const KEYS = "keys";
const PLACEMENTS = "placements";
const RECORDS = "records";
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

/** Opens the database, making the object stores that are missing (`keys`, `placements`, `records`). */
export function openProvenanceDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS);
      if (!db.objectStoreNames.contains(PLACEMENTS)) db.createObjectStore(PLACEMENTS, { autoIncrement: true });
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS); // keyed by the record's id
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

/** Keeps a record (replacing the one with the same id): the record, its signature, its token or none, and where its time came from. */
export async function putRecord(db: IDBDatabase, kept: KeptRecord): Promise<void> {
  const tx = db.transaction([RECORDS], "readwrite");
  const done = finished(tx);
  tx.objectStore(RECORDS).put(structuredClone(kept), kept.signed.record.id);
  await done;
}

/** Every kept record, in no particular order. */
export async function readRecords(db: IDBDatabase): Promise<KeptRecord[]> {
  return request<KeptRecord[]>(db.transaction([RECORDS], "readonly").objectStore(RECORDS).getAll());
}