import { request, transact } from "./storeSupport.js";

/**
 * Which of the person's data an export or a removal covers (owner, 16 Nov: "Remove my data…" removes only the calling app's data;
 * a separate "Remove all" removes everything; the export follows the same scope). .NET: `DataScope`.
 *
 * - `thisApp`: this app's own data: the chats and "Allow always" of its agents and their thinking levels, and its record. The
 *   person's shared data (skills, the MCP list, keys, provenance records, the person's other preferences, the data key) only when no
 *   other Fadenstack app in this browser uses the person's data.
 * - `allApps`: all of the person's Fadenstack data in this browser: every app's.
 */
export type DataScope = "thisApp" | "allApps";

/** The options of `exportMyData` and `deleteMyData`. */
export interface MyDataOptions {
  /** What the call covers. Default `thisApp` (since 0.3.0; before, the calls took everything: pass `allApps` for that). */
  scope?: DataScope;
  signal?: AbortSignal;
}

/**
 * An app that uses the person's data in this browser (`FadenstackAgent.myDataApps`): its name (what the host described, else the
 * agent's slug), its agents, when it last started, whether it is the calling app, and whether it recorded itself (`recorded` false:
 * an app on an older SDK, known only by an agent's data, named by that agent). .NET: `MyDataApp`.
 */
export interface MyDataApp {
  name: string;
  agents: string[];
  /** ISO 8601, UTC; absent for an app that never recorded itself. */
  lastSeen?: string;
  isThisApp: boolean;
  recorded: boolean;
}

/** What a removal of `thisApp` takes and leaves, worked out before anything is deleted. .NET: `MyDataPlan`. */
export interface MyDataPlan {
  /** This app's agents that no other app uses: their data goes. */
  ownAgents: string[];
  /** This app's agents another app also uses: their data stays. */
  keptAgents: string[];
  otherApps: MyDataApp[];
  /** No other app uses the person's data: the shared data goes too (and, in a browser, the person's data key with it). */
  sharedGoes: boolean;
}

/** The small record each agent start keeps per person and app: names and times, no content. .NET: `apps/<app>.json`. */
export interface AppRecord {
  app: string;
  agents: string[];
  firstSeen: string;
  lastSeen: string;
}

/** Where the app records live. */
export interface AppRecords {
  /** Records that `app` ran `agent` for the person (a new record, or the agent added and the time moved). */
  record(app: string, agent: string, now: string): Promise<void>;
  list(): Promise<AppRecord[]>;
  /** Forgets the app's record; whether there was one. */
  remove(app: string): Promise<boolean>;
}

/** The records in memory only (where there is no IndexedDB). */
export class MemoryAppRecords implements AppRecords {
  readonly #records = new Map<string, AppRecord>();

  record(app: string, agent: string, now: string): Promise<void> {
    const old = this.#records.get(app);
    this.#records.set(app, merged(old, app, agent, now));
    return Promise.resolve();
  }

  list(): Promise<AppRecord[]> {
    return Promise.resolve([...this.#records.values()].map((r) => ({ ...r, agents: [...r.agents] })));
  }

  remove(app: string): Promise<boolean> {
    return Promise.resolve(this.#records.delete(app));
  }
}

function merged(old: AppRecord | undefined, app: string, agent: string, now: string): AppRecord {
  const agents = old && Array.isArray(old.agents) ? old.agents.filter((a): a is string => typeof a === "string") : [];
  if (!agents.includes(agent)) agents.push(agent);
  return { app, agents, firstSeen: typeof old?.firstSeen === "string" ? old.firstSeen : now, lastSeen: now };
}

const APPS = "apps";

export interface IndexedDbAppRecordsOptions {
  /** The database's name (the agent uses one per signed-in person). */
  name: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`; tests pass a fake). */
  indexedDB?: IDBFactory;
}

/**
 * The records in the person's own small IndexedDB database (`fadenstack-apps`, one per signed-in person; one object store, `apps`,
 * keyed by the app's name). Every app of this origin that signs the same person in writes to it, which is how one app knows
 * that another uses the person's data. Names, agent slugs and times only.
 */
export class IndexedDbAppRecords implements AppRecords {
  readonly #name: string;
  readonly #factory: IDBFactory;
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbAppRecordsOptions) {
    this.#name = options.name;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here; use MemoryAppRecords.");
    this.#factory = factory;
  }

  async record(app: string, agent: string, now: string): Promise<void> {
    const db = await this.#open();
    // Read and write in one transaction, so two apps starting together never lose each other's agent.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([APPS], "readwrite");
      const store = tx.objectStore(APPS);
      const read = store.get(app);
      read.onsuccess = () => { store.put(merged(read.result as AppRecord | undefined, app, agent, now)); };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  }

  async list(): Promise<AppRecord[]> {
    // Reading must not create the database: where the browser can list them, look first.
    if (!this.#db && !(await exists(this.#factory, this.#name))) return [];
    const db = await this.#open();
    let rows: unknown[] = [];
    await transact(db, [APPS], "readonly", async (tx) => {
      rows = await request<unknown[]>(tx.objectStore(APPS).getAll());
    });
    const records: AppRecord[] = [];
    for (const row of rows) {
      const r = (row ?? {}) as Partial<AppRecord>;
      if (typeof r.app !== "string") continue;
      // A damaged record still names its app, with no agents.
      records.push({
        app: r.app,
        agents: Array.isArray(r.agents) ? r.agents.filter((a): a is string => typeof a === "string") : [],
        firstSeen: typeof r.firstSeen === "string" ? r.firstSeen : "",
        lastSeen: typeof r.lastSeen === "string" ? r.lastSeen : "",
      });
    }
    return records;
  }

  async remove(app: string): Promise<boolean> {
    if (!this.#db && !(await exists(this.#factory, this.#name))) return false;
    const db = await this.#open();
    let had = false;
    await transact(db, [APPS], "readwrite", async (tx) => {
      const store = tx.objectStore(APPS);
      had = (await request<unknown>(store.get(app))) !== undefined;
      store.delete(app);
    });
    return had;
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

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.#factory.open(this.#name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(APPS)) db.createObjectStore(APPS, { keyPath: "app" });
      };
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => { // another tab or agent deletes the database (deleteMyData): let it, and open again at next use
          db.close();
          this.#db = undefined;
        };
        resolve(db);
      };
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onblocked = () => reject(new Error("IndexedDB is blocked by another open version."));
    });
    return this.#db;
  }
}

async function exists(factory: IDBFactory, name: string): Promise<boolean> {
  const list = (factory as { databases?: () => Promise<{ name?: string }[]> }).databases;
  if (typeof list !== "function") return true;
  try {
    return (await list.call(factory)).some((d) => d.name === name);
  } catch {
    return true;
  }
}

/** The app's name as the records and the removal use it: what the host described, else the agent's slug. .NET: `MyDataApps.NameOf`. */
export function appNameOf(describedName: string | undefined, slug: string): string {
  const name = describedName?.trim();
  return name ? name : slug;
}

/**
 * The apps that use the person's data, this app first: the records, then each agent with data that no record names (an app on an
 * older SDK writes no record: it is known by an agent's data, named by that agent). .NET: `MyDataApps.List`.
 */
export function listMyDataApps(records: readonly AppRecord[], agentsWithData: readonly string[], thisApp: string, thisAgent: string): MyDataApp[] {
  const apps: MyDataApp[] = [];
  const named = new Set<string>();
  const ordered = [...records].sort((a, b) => (a.app === thisApp ? 0 : 1) - (b.app === thisApp ? 0 : 1) || (a.app < b.app ? -1 : a.app > b.app ? 1 : 0));
  for (const record of ordered) {
    const isThis = record.app === thisApp;
    const agents = isThis && !record.agents.includes(thisAgent) ? [...record.agents, thisAgent] : [...record.agents];
    for (const agent of agents) named.add(agent);
    apps.push({ name: record.app, agents, ...(record.lastSeen ? { lastSeen: record.lastSeen } : {}), isThisApp: isThis, recorded: true });
  }
  if (!records.some((r) => r.app === thisApp)) {
    named.add(thisAgent);
    apps.unshift({ name: thisApp, agents: [thisAgent], isThisApp: true, recorded: false });
  }
  for (const agent of [...new Set(agentsWithData)].filter((a) => !named.has(a)).sort()) {
    apps.push({ name: agent, agents: [agent], isThisApp: false, recorded: false });
  }
  return apps;
}

/**
 * What a removal of this app's data takes: its agents' data, except an agent another app's record also names (that one stays); the
 * shared data only when no other app -- recorded, or inferred from an agent's data -- uses the person's data. .NET: `MyDataApps.Plan`.
 */
export function planMyData(apps: readonly MyDataApp[]): MyDataPlan {
  const mine = [...new Set(apps.filter((a) => a.isThisApp).flatMap((a) => a.agents))];
  const others = apps.filter((a) => !a.isThisApp);
  const theirs = new Set(others.flatMap((a) => a.agents));
  return {
    ownAgents: mine.filter((a) => !theirs.has(a)),
    keptAgents: mine.filter((a) => theirs.has(a)),
    otherApps: others,
    sharedGoes: others.length === 0,
  };
}
