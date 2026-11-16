/**
 * The person's preferences database (`fadenstack-preferences`, one per signed-in user: `userStoreName`). Two things live in it: the
 * thinking level each agent was given (`reasoning`, keyed by agent) and the person's choice for old chats (`retention`, one row). Each
 * is kept by its own class, which opens the database the same way, so whichever writes first creates both stores, and a database an
 * earlier SDK made (version 1, `reasoning` only) gets `retention` added.
 */
export const PREFERENCES_VERSION = 2;
export const REASONING_STORE = "reasoning";
export const RETENTION_STORE = "retention";

/** Opens the database, creating the stores that are missing. `onGone` runs when another tab or agent deletes or upgrades it (the connection is closed first). */
export function openPreferences(factory: IDBFactory, name: string, onGone: () => void): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, PREFERENCES_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(REASONING_STORE)) db.createObjectStore(REASONING_STORE, { keyPath: "agent" });
      if (!db.objectStoreNames.contains(RETENTION_STORE)) db.createObjectStore(RETENTION_STORE, { keyPath: "id" });
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => {
        db.close();
        onGone();
      };
      resolve(db);
    };
    open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
    open.onblocked = () => reject(new Error("IndexedDB is blocked by another open version."));
  });
}

/** Whether the browser says the database exists; true where it cannot say (then opening it is the way to find out). */
export async function preferencesExist(factory: IDBFactory, name: string): Promise<boolean> {
  const list = (factory as { databases?: () => Promise<{ name?: string }[]> }).databases;
  if (typeof list !== "function") return true;
  try {
    return (await list.call(factory)).some((d) => d.name === name);
  } catch {
    return true;
  }
}
