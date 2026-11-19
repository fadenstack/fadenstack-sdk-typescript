import type { FadenstackLogger, LogEvent, LogLevel } from "@fadenstack/client";

import { request, transact } from "./storeSupport.js";
import { userStoreName, type StorePrincipal } from "./userData.js";

/** The base name of the log's IndexedDB database; the signed-in person's has their tenant and user after it (`userStoreName`). */
export const BROWSER_LOG_DATABASE = "fadenstack-log";

const ENTRIES = "entries";

/** One stored entry: the SDK's `LogEvent` as it is, plus the time it was written (ISO 8601, UTC). Nothing else. */
export interface StoredLogEntry extends LogEvent {
  readonly at: string;
}

/** How the browser log keeps its entries (`AgentBuilder.useBrowserLog`). */
export interface BrowserLogOptions {
  /** The most entries kept; the oldest go first. Default 500. */
  maxEntries?: number;
  /** The most days an entry is kept; older ones go. Default 7. */
  maxAgeDays?: number;
  /** The lowest level kept. Default `information`. */
  minLevel?: LogLevel;
  /** Entries queued before they are written at once. Default 50. */
  batchSize?: number;
  /** The longest an entry waits in the queue before a write, in milliseconds. Default 1000. */
  flushMs?: number;
  /** The IndexedDB to use; default the page's. Where there is none the entries are kept in memory only, with the same limits. */
  factory?: IDBFactory | undefined;
  /** The time, for tests. */
  now?: () => number;
}

const ORDER: Record<LogLevel, number> = { debug: 0, information: 1, warning: 2, error: 3 };
const DAY_MS = 86_400_000;

/**
 * A small log of the SDK's own entries on the device (.NET: `FadenstackFileLoggerProvider`): the `LogEvent`s as they are, with the time,
 * in the signed-in person's own IndexedDB database (`fadenstack-log`, per principal like the other stores), at most `maxEntries` of them
 * and none older than `maxAgeDays`, the oldest dropped first; checked and pruned as it writes. The SDK's events carry names, ids, counts
 * and outcomes, never a prompt, an answer, an argument or a result, and this logger adds nothing to them.
 *
 * Writes are queued and made in batches (a timer or a count), never one transaction per entry, and never block or fail the caller: where
 * IndexedDB fails the entries are dropped and counted (`dropped`, as .NET's `Dropped`). Entries logged before the person is known go to the
 * database without a person and stay there. Without IndexedDB (Node) the entries are kept in memory. "Remove my data" deletes the database.
 */
export class BrowserLog implements FadenstackLogger {
  readonly maxEntries: number;
  readonly maxAgeDays: number;
  readonly minLevel: LogLevel;
  readonly #batchSize: number;
  readonly #flushMs: number;
  readonly #factory: IDBFactory | undefined;
  readonly #now: () => number;
  #principal: StorePrincipal | undefined;
  #queue: StoredLogEntry[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();
  #db: IDBDatabase | undefined;
  #dbName: string | undefined;
  readonly #memory = new Map<string, StoredLogEntry[]>();
  #dropped = 0;

  constructor(options: BrowserLogOptions = {}) {
    this.maxEntries = positive(options.maxEntries, 500);
    this.maxAgeDays = positive(options.maxAgeDays, 7);
    this.minLevel = options.minLevel && options.minLevel in ORDER ? options.minLevel : "information";
    this.#batchSize = positive(options.batchSize, 50);
    this.#flushMs = positive(options.flushMs, 1000);
    this.#factory = "factory" in options ? options.factory : globalThis.indexedDB;
    this.#now = options.now ?? Date.now;
  }

  /** How many entries were dropped: the database failed, or the queue was full. */
  get dropped(): number {
    return this.#dropped;
  }

  /** The name of the database entries go to now. */
  get databaseName(): string {
    return userStoreName(BROWSER_LOG_DATABASE, this.#principal);
  }

  /**
   * Says whose database the entries go to from now on (the agent does this once it knows the signed-in person). What was queued before
   * is written to the database it was logged for; nothing is moved between databases.
   */
  usePrincipal(principal: StorePrincipal | undefined): void {
    this.#hand();
    this.#principal = principal;
  }

  /** Queues one entry. Never throws and never waits. */
  log(event: LogEvent): void {
    try {
      if (!(event.level in ORDER) || ORDER[event.level] < ORDER[this.minLevel]) return;
      const entry: StoredLogEntry = { ...event, at: new Date(this.#now()).toISOString() };
      if (this.#queue.length >= this.maxEntries) {
        this.#queue.shift(); // a stalled database never grows the queue without bound
        this.#dropped++;
      }
      this.#queue.push(entry);
      if (this.#queue.length >= this.#batchSize) this.#hand();
      else this.#arm();
    } catch {
      this.#dropped++;
    }
  }

  /** Writes what is queued; resolves when it is done (a failure is counted, not thrown). */
  flush(): Promise<void> {
    this.#hand();
    return this.#chain;
  }

  /** The kept entries of the current database, the oldest first. Where the database cannot be read: none. */
  async entries(): Promise<readonly StoredLogEntry[]> {
    await this.flush();
    const name = this.databaseName;
    if (!this.#factory) return [...(this.#memory.get(name) ?? [])];
    const job = this.#chain.then(async () => {
      const db = await this.#open(name);
      const tx = db.transaction([ENTRIES], "readonly");
      return request<StoredLogEntry[]>(tx.objectStore(ENTRIES).getAll());
    });
    this.#chain = job.then(() => undefined, () => undefined);
    try {
      return await job;
    } catch {
      return [];
    }
  }

  /** Removes every entry of the current database (and what is queued). */
  async clear(): Promise<void> {
    this.#queue = [];
    this.#disarm();
    const name = this.databaseName;
    if (!this.#factory) {
      this.#memory.delete(name);
      return;
    }
    const job = this.#chain.then(async () => {
      const db = await this.#open(name);
      await transact(db, [ENTRIES], "readwrite", async (tx) => {
        await request(tx.objectStore(ENTRIES).clear());
      });
    });
    this.#chain = job.then(() => undefined, () => undefined);
    try {
      await job;
    } catch {
      // nothing could be cleared; the database stays as it was
    }
  }

  /** Closes the connection (what is queued is written first), so the database can be deleted. A later entry opens it again. */
  async closeAsync(): Promise<void> {
    this.#hand();
    await this.#chain;
    this.#closeDb();
  }

  /**
   * For "Remove my data": drops what is queued without writing it, closes the connection and empties the memory, so that nothing
   * written before the removal comes back after it. The SDK then deletes the databases.
   */
  async release(): Promise<void> {
    this.#queue = [];
    this.#disarm();
    await this.#chain;
    this.#closeDb();
    this.#memory.clear();
  }

  /** Moves the queue into one write job, for the database it was logged for. */
  #hand(): void {
    this.#disarm();
    if (this.#queue.length === 0) return;
    const batch = this.#queue;
    this.#queue = [];
    const name = this.databaseName;
    this.#chain = this.#chain.then(() => this.#write(name, batch)).catch(() => undefined);
  }

  #arm(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#hand();
    }, this.#flushMs);
    (this.#timer as { unref?: () => void }).unref?.(); // a pending write never keeps a Node process alive
  }

  #disarm(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #write(name: string, batch: StoredLogEntry[]): Promise<void> {
    try {
      if (!this.#factory) {
        this.#keepInMemory(name, batch);
        return;
      }
      const db = await this.#open(name);
      const cutoff = new Date(this.#now() - this.maxAgeDays * DAY_MS).toISOString();
      await transact(db, [ENTRIES], "readwrite", async (tx) => {
        const store = tx.objectStore(ENTRIES);
        for (const entry of batch) store.add(entry);
        // Pruned in the same transaction: the entries older than the age first, then the oldest beyond the count.
        let excess = (await request<number>(store.count())) - this.maxEntries;
        await new Promise<void>((resolve, reject) => {
          const cursor = store.openCursor();
          cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB cursor failed."));
          cursor.onsuccess = () => {
            const at = cursor.result;
            if (!at) return resolve();
            const old = typeof (at.value as StoredLogEntry).at === "string" && (at.value as StoredLogEntry).at < cutoff;
            if (!old && excess <= 0) return resolve();
            at.delete();
            excess--;
            at.continue();
          };
        });
      });
    } catch {
      this.#dropped += batch.length;
      this.#closeDb(); // a broken connection is made again at the next write
    }
  }

  #keepInMemory(name: string, batch: StoredLogEntry[]): void {
    const list = this.#memory.get(name) ?? [];
    list.push(...batch);
    const cutoff = new Date(this.#now() - this.maxAgeDays * DAY_MS).toISOString();
    const kept = list.filter((e) => e.at >= cutoff);
    this.#memory.set(name, kept.length > this.maxEntries ? kept.slice(kept.length - this.maxEntries) : kept);
  }

  async #open(name: string): Promise<IDBDatabase> {
    if (this.#db && this.#dbName === name) return this.#db;
    this.#closeDb();
    const factory = this.#factory!;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(name, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(ENTRIES)) open.result.createObjectStore(ENTRIES, { autoIncrement: true });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not open the log."));
      open.onblocked = () => reject(new Error("The log database is blocked."));
    });
    db.onversionchange = () => {
      db.close(); // another tab deletes it ("Remove my data"): let it
      if (this.#db === db) this.#db = undefined;
    };
    db.onclose = () => {
      if (this.#db === db) this.#db = undefined;
    };
    this.#db = db;
    this.#dbName = name;
    return db;
  }

  #closeDb(): void {
    try {
      this.#db?.close();
    } catch {
      // already closed
    }
    this.#db = undefined;
    this.#dbName = undefined;
  }
}

/** Two loggers as one: both get every entry; a broken one never stops the other. */
export function teeLoggers(first: FadenstackLogger | undefined, second: FadenstackLogger): FadenstackLogger {
  if (!first) return second;
  return {
    log(event) {
      try {
        first.log(event);
      } catch {
        // the host's logger broke: the other still gets the entry
      }
      second.log(event);
    },
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
