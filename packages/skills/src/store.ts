import { userStoreName } from "@fadenstack/agents";

import { SkillRuleError, checkSkill, type SkillDefinition } from "./skillRules.js";

/** Whose skills they are: the tenant and the user of an agent profile's principal. */
export interface StorePrincipal {
  tenantId: string;
  userId: string;
}

/**
 * Where the person's own skills are kept: a small API to add, list and remove a skill (the editor comes later). Every change
 * tells the listeners, and the module reads the skills again at the start of the agent's next turn.
 */
export interface SkillStore {
  /** The skills kept, as they were stored (a skill that breaks the rule is still listed: the module skips it when it reads), by name. */
  list(): Promise<SkillDefinition[]>;
  get(name: string): Promise<SkillDefinition | undefined>;
  /** Keeps the skill, replacing one of the same name. Throws `SkillRuleError` for a skill that breaks the six-field rule. */
  add(skill: SkillDefinition): Promise<void>;
  /**
   * Keeps the skill and, when it was renamed (`previousName`, another name), removes the skill it came from, in one step: both or
   * neither. A store without it is written with `add` and then `remove`. Throws `SkillRuleError` for a skill that breaks the rule.
   */
  save?(skill: SkillDefinition, previousName?: string): Promise<void>;
  /** Removes the skill; whether there was one. */
  remove(name: string): Promise<boolean>;
  /** Calls `listener` after a change; returns the unsubscribe. */
  onChanged(listener: () => void): () => void;
  /** Releases what the store holds open (an IndexedDB connection). */
  close(): void;
}

function checked(skill: SkillDefinition): SkillDefinition {
  const problem = checkSkill(skill, skill?.name);
  if (problem !== undefined) throw new SkillRuleError(`The skill is not kept: ${problem}.`);
  return structuredClone(skill);
}

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

/** The skills in memory: for a host without IndexedDB, and for tests. */
export class MemorySkillStore extends ObservableStore implements SkillStore {
  readonly #skills = new Map<string, SkillDefinition>();

  async list(): Promise<SkillDefinition[]> {
    return [...this.#skills.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, skill]) => structuredClone(skill));
  }

  async get(name: string): Promise<SkillDefinition | undefined> {
    const skill = this.#skills.get(name);
    return skill ? structuredClone(skill) : undefined;
  }

  async add(skill: SkillDefinition): Promise<void> {
    const kept = checked(skill);
    this.#skills.set(kept.name, kept);
    this.changed();
  }

  async save(skill: SkillDefinition, previousName?: string): Promise<void> {
    const kept = checked(skill);
    if (previousName !== undefined && previousName !== kept.name) this.#skills.delete(previousName);
    this.#skills.set(kept.name, kept);
    this.changed();
  }

  async remove(name: string): Promise<boolean> {
    const had = this.#skills.delete(name);
    if (had) this.changed();
    return had;
  }

  close(): void {
    // nothing is held open
  }
}

const VERSION = 1;
const SKILLS = "skills";

export interface IndexedDbSkillStoreOptions {
  /** Whose database it is (`userStoreName("fadenstack-skills", principal)`); a function is asked on every use. Without one: the standalone principal's. */
  principal?: StorePrincipal | undefined | (() => StorePrincipal | undefined);
  /** The database's own name, instead of the principal's. */
  name?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`). */
  indexedDB?: IDBFactory;
}

/** The standalone principal's tenant and user, as the agent's local profile names them: its data lives in stores of its own. */
const STANDALONE: StorePrincipal = Object.freeze({ tenantId: "standalone", userId: "standalone" });

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

/**
 * The person's own skills in IndexedDB, one database per principal (`fadenstack-skills`, then the tenant and the user as
 * `userStoreName` writes them; standalone is its own principal), so deleting a person's data removes them and two people in one
 * browser profile never see each other's. There is no folder in a browser: the skills are records, and import and export go
 * through zip. Without IndexedDB use `MemorySkillStore` (`openSkillStore` picks).
 */
export class IndexedDbSkillStore extends ObservableStore implements SkillStore {
  readonly #options: IndexedDbSkillStoreOptions;
  readonly #factory: IDBFactory;
  #open: { name: string; db: Promise<IDBDatabase> } | undefined;

  constructor(options: IndexedDbSkillStoreOptions = {}) {
    super();
    this.#options = options;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("There is no IndexedDB here: use MemorySkillStore.");
    this.#factory = factory;
  }

  /** The database this store reads and writes now. */
  get databaseName(): string {
    if (this.#options.name) return this.#options.name;
    const principal = this.#options.principal;
    return userStoreName("fadenstack-skills", typeof principal === "function" ? principal() : principal ?? STANDALONE);
  }

  async list(): Promise<SkillDefinition[]> {
    const db = await this.#db();
    return request<SkillDefinition[]>(db.transaction([SKILLS], "readonly").objectStore(SKILLS).getAll());
  }

  async get(name: string): Promise<SkillDefinition | undefined> {
    const db = await this.#db();
    return request<SkillDefinition | undefined>(db.transaction([SKILLS], "readonly").objectStore(SKILLS).get(name));
  }

  async add(skill: SkillDefinition): Promise<void> {
    const kept = checked(skill);
    const db = await this.#db();
    const tx = db.transaction([SKILLS], "readwrite");
    const done = finished(tx);
    tx.objectStore(SKILLS).put(kept, kept.name);
    await done;
    this.changed();
  }

  async save(skill: SkillDefinition, previousName?: string): Promise<void> {
    const kept = checked(skill);
    const db = await this.#db();
    const tx = db.transaction([SKILLS], "readwrite");
    const done = finished(tx);
    if (previousName !== undefined && previousName !== kept.name) tx.objectStore(SKILLS).delete(previousName);
    tx.objectStore(SKILLS).put(kept, kept.name);
    await done;
    this.changed();
  }

  async remove(name: string): Promise<boolean> {
    const db = await this.#db();
    const tx = db.transaction([SKILLS], "readwrite");
    const done = finished(tx);
    const store = tx.objectStore(SKILLS);
    const had = (await request<number>(store.count(name))) > 0;
    if (had) store.delete(name);
    await done;
    if (had) this.changed();
    return had;
  }

  close(): void {
    const open = this.#open;
    this.#open = undefined;
    void open?.db.then((db) => db.close(), () => undefined);
  }

  /** The connection to the database of the principal now: a new one when the principal changed. */
  #db(): Promise<IDBDatabase> {
    const name = this.databaseName;
    if (this.#open?.name !== name) {
      this.close();
      const db = new Promise<IDBDatabase>((resolve, reject) => {
        const opening = this.#factory.open(name, VERSION);
        opening.onupgradeneeded = () => {
          if (!opening.result.objectStoreNames.contains(SKILLS)) opening.result.createObjectStore(SKILLS);
        };
        opening.onsuccess = () => {
          const connection = opening.result;
          connection.onversionchange = () => {
            connection.close(); // a deletion of the person's data must not be held up by this connection
            if (this.#open?.db === db) this.#open = undefined; // and the next use opens it again, instead of a closed one
          };
          resolve(connection);
        };
        opening.onerror = () => reject(opening.error ?? new Error("The skills database could not be opened."));
        opening.onblocked = () => reject(new Error("The skills database is blocked by another open version."));
      });
      this.#open = { name, db };
      db.catch(() => {
        if (this.#open?.db === db) this.#open = undefined; // try again next time
      });
    }
    return this.#open!.db;
  }
}

/** The person's skills in IndexedDB where there is one, in memory where there is not. */
export function openSkillStore(options: IndexedDbSkillStoreOptions = {}): SkillStore {
  return options.indexedDB ?? globalThis.indexedDB ? new IndexedDbSkillStore(options) : new MemorySkillStore();
}
