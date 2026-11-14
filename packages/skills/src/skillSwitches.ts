import { userStoreName } from "@fadenstack/agents";

import type { StorePrincipal } from "./store.js";

/**
 * The person's on/off switch per skill, kept on this device. A skill is on until it is switched off. The module does not list an off
 * skill for the model (`SkillsOptions.switches`), and the editor shows and sets it. .NET: `ISkillSwitches` (skills.json there).
 */
export interface SkillSwitches {
  /** The names switched off. */
  disabled(): Promise<ReadonlySet<string>>;
  isEnabled(name: string): Promise<boolean>;
  /** Switches a skill on or off; whether that changed anything. */
  set(name: string, enabled: boolean): Promise<boolean>;
}

/** Switches kept for as long as the page lives (tests, a host without IndexedDB). */
export class MemorySkillSwitches implements SkillSwitches {
  readonly #off = new Set<string>();

  async disabled(): Promise<ReadonlySet<string>> {
    return new Set(this.#off);
  }

  async isEnabled(name: string): Promise<boolean> {
    return !this.#off.has(name);
  }

  async set(name: string, enabled: boolean): Promise<boolean> {
    return enabled ? this.#off.delete(name) : !this.#off.has(name) && (this.#off.add(name), true);
  }
}

export interface IndexedDbSkillSwitchesOptions {
  /** Whose database it is (`userStoreName("fadenstack-skill-switches", principal)`); a function is asked on every use. Without one: the standalone principal's. */
  principal?: StorePrincipal | undefined | (() => StorePrincipal | undefined);
  /** The database's own name, instead of the principal's. */
  name?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`). */
  indexedDB?: IDBFactory;
}

const STANDALONE: StorePrincipal = Object.freeze({ tenantId: "standalone", userId: "standalone" });
const OFF = "off";

function result<T>(req: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed."));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

/**
 * The switches in the person's own IndexedDB database (`fadenstack-skill-switches`, then the tenant and the user as `userStoreName`
 * writes them), one record per switched-off skill, so deleting a person's data removes them and two people in one browser profile
 * never see each other's. A change another tab made is seen: every read goes to the database.
 */
export class IndexedDbSkillSwitches implements SkillSwitches {
  readonly #options: IndexedDbSkillSwitchesOptions;
  readonly #factory: IDBFactory;
  #open: { name: string; db: Promise<IDBDatabase> } | undefined;

  constructor(options: IndexedDbSkillSwitchesOptions = {}) {
    this.#options = options;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("There is no IndexedDB here: use MemorySkillSwitches.");
    this.#factory = factory;
  }

  get databaseName(): string {
    if (this.#options.name) return this.#options.name;
    const principal = this.#options.principal;
    return userStoreName("fadenstack-skill-switches", typeof principal === "function" ? principal() : principal ?? STANDALONE);
  }

  async disabled(): Promise<ReadonlySet<string>> {
    const db = await this.#db();
    const keys = await result<IDBValidKey[]>(db.transaction([OFF], "readonly").objectStore(OFF).getAllKeys());
    return new Set(keys.filter((k): k is string => typeof k === "string"));
  }

  async isEnabled(name: string): Promise<boolean> {
    const db = await this.#db();
    return (await result<number>(db.transaction([OFF], "readonly").objectStore(OFF).count(name))) === 0;
  }

  async set(name: string, enabled: boolean): Promise<boolean> {
    const db = await this.#db();
    const tx = db.transaction([OFF], "readwrite");
    const finished = done(tx);
    const store = tx.objectStore(OFF);
    const off = (await result<number>(store.count(name))) > 0;
    const changed = enabled ? off : !off;
    if (changed) {
      if (enabled) store.delete(name);
      else store.put(true, name);
    }
    await finished;
    return changed;
  }

  close(): void {
    const open = this.#open;
    this.#open = undefined;
    void open?.db.then((db) => db.close(), () => undefined);
  }

  #db(): Promise<IDBDatabase> {
    const name = this.databaseName;
    if (this.#open?.name !== name) {
      this.close();
      const db = new Promise<IDBDatabase>((resolve, reject) => {
        const opening = this.#factory.open(name, 1);
        opening.onupgradeneeded = () => {
          if (!opening.result.objectStoreNames.contains(OFF)) opening.result.createObjectStore(OFF);
        };
        opening.onsuccess = () => {
          const connection = opening.result;
          connection.onversionchange = () => connection.close(); // a deletion of the person's data must not be held up by this connection
          resolve(connection);
        };
        opening.onerror = () => reject(opening.error ?? new Error("The skill switches could not be opened."));
        opening.onblocked = () => reject(new Error("The skill switches are blocked by another open version."));
      });
      this.#open = { name, db };
      db.catch(() => {
        if (this.#open?.db === db) this.#open = undefined; // try again next time
      });
    }
    return this.#open!.db;
  }
}

/** The switches in IndexedDB where there is one, in memory where there is not. */
export function openSkillSwitches(options: IndexedDbSkillSwitchesOptions = {}): SkillSwitches {
  return options.indexedDB ?? globalThis.indexedDB ? new IndexedDbSkillSwitches(options) : new MemorySkillSwitches();
}
