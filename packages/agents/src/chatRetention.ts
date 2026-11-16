import { RETENTION_STORE, openPreferences, preferencesExist } from "./preferencesDb.js";
import type { SessionRetention } from "./sessionStore.js";

/** The bounds of the limits: whole numbers, days 1 to 3650, chats 1 to 10000. .NET: `ChatRetentionChoice.MinDays` and the others. */
export const CHAT_RETENTION_LIMITS = Object.freeze({ minDays: 1, maxDays: 3650, minChats: 1, maxChats: 10000 });

export function isValidRetentionDays(days: unknown): days is number {
  return typeof days === "number" && Number.isInteger(days) && days >= CHAT_RETENTION_LIMITS.minDays && days <= CHAT_RETENTION_LIMITS.maxDays;
}

export function isValidRetentionChats(chats: unknown): chats is number {
  return typeof chats === "number" && Number.isInteger(chats) && chats >= CHAT_RETENTION_LIMITS.minChats && chats <= CHAT_RETENTION_LIMITS.maxChats;
}

/**
 * What a person chose, in a standalone agent, for the old chats on their device: whether they are deleted automatically, and the
 * limits (how old, how many) when they are. Off keeps every chat until the person deletes it. .NET: `ChatRetentionChoice`.
 */
export interface ChatRetentionChoice {
  /** Delete old chats automatically; false keeps every chat. */
  readonly autoDelete: boolean;
  /** Chats older than this many days go. */
  readonly maxAgeDays: number;
  /** Only the newest this many chats are kept. */
  readonly maxSessions: number;
}

/** On, 90 days, 50 chats. */
export const DEFAULT_CHAT_RETENTION: ChatRetentionChoice = Object.freeze({ autoDelete: true, maxAgeDays: 90, maxSessions: 50 });

/**
 * A choice, checked: the limits must be whole numbers within their bounds (also when automatic deletion is off: they are kept for
 * later). A missing `autoDelete` is true.
 * @throws RangeError a limit is outside its bounds.
 */
export function chatRetentionChoice(init: { autoDelete?: boolean; maxAgeDays?: number; maxSessions?: number } = {}): ChatRetentionChoice {
  const maxAgeDays = init.maxAgeDays ?? DEFAULT_CHAT_RETENTION.maxAgeDays;
  const maxSessions = init.maxSessions ?? DEFAULT_CHAT_RETENTION.maxSessions;
  if (!isValidRetentionDays(maxAgeDays)) {
    throw new RangeError(`The days must be whole numbers from ${CHAT_RETENTION_LIMITS.minDays} to ${CHAT_RETENTION_LIMITS.maxDays}.`);
  }
  if (!isValidRetentionChats(maxSessions)) {
    throw new RangeError(`The chats must be whole numbers from ${CHAT_RETENTION_LIMITS.minChats} to ${CHAT_RETENTION_LIMITS.maxChats}.`);
  }
  return Object.freeze({ autoDelete: init.autoDelete ?? true, maxAgeDays, maxSessions });
}

/** The app's own limits as a choice that is on, brought within the bounds. */
export function chatRetentionFromApp(app: SessionRetention): ChatRetentionChoice {
  const within = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high);
  return chatRetentionChoice({
    autoDelete: true,
    maxAgeDays: within(app.maxAgeDays, CHAT_RETENTION_LIMITS.minDays, CHAT_RETENTION_LIMITS.maxDays),
    maxSessions: within(app.maxSessions, CHAT_RETENTION_LIMITS.minChats, CHAT_RETENTION_LIMITS.maxChats),
  });
}

/**
 * Who decides how long chats are kept on this device: the `person` (a standalone agent), the `organisation` (a governed agent: the
 * server's `local_retention`, within the app's limits) or the `machinePolicy` (`chatRetention` on a standalone agent's computer).
 */
export type ChatRetentionControl = "person" | "organisation" | "machinePolicy";

/** What keeps old chats off a device now (`FadenstackAgent.chatRetention`). .NET: `ChatRetentionState`. */
export interface ChatRetentionState {
  readonly control: ChatRetentionControl;
  /** Whether old chats are deleted automatically. Always true in governed mode, where the limits are the server's and the app's. */
  readonly autoDelete: boolean;
  readonly maxAgeDays: number;
  readonly maxSessions: number;
  /** Governed mode only: whether the server set a limit (`local_retention`) at all. */
  readonly organisationSetsLimit: boolean;
  /** The person may change it: standalone, and the machine policy leaves it to them. */
  readonly canChange: boolean;
}

/** The state of a given control; `canChange` follows from it. */
export function chatRetentionState(control: ChatRetentionControl, autoDelete: boolean, maxAgeDays: number, maxSessions: number, organisationSetsLimit = false): ChatRetentionState {
  return Object.freeze({ control, autoDelete, maxAgeDays, maxSessions, organisationSetsLimit, canChange: control === "person" });
}

/** The state as a choice, for a settings form to start from (limits brought within the bounds). */
export function chatRetentionChoiceOf(state: ChatRetentionState): ChatRetentionChoice {
  const within = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high);
  return chatRetentionChoice({
    autoDelete: state.autoDelete,
    maxAgeDays: within(state.maxAgeDays, CHAT_RETENTION_LIMITS.minDays, CHAT_RETENTION_LIMITS.maxDays),
    maxSessions: within(state.maxSessions, CHAT_RETENTION_LIMITS.minChats, CHAT_RETENTION_LIMITS.maxChats),
  });
}

/** The limits to apply, or undefined when automatic deletion is off. */
export function retentionLimits(state: Pick<ChatRetentionState, "autoDelete" | "maxAgeDays" | "maxSessions">): SessionRetention | undefined {
  return state.autoDelete ? { maxSessions: state.maxSessions, maxAgeDays: state.maxAgeDays } : undefined;
}

/**
 * The choice each person made, kept by the browser (or the host): a preference, not content. Anything unreadable or out of bounds
 * counts as no choice. .NET: `ChatRetentionStore` (`preferences/retention.json`).
 */
export interface ChatRetentionStore {
  get(): Promise<ChatRetentionChoice | undefined>;
  set(choice: ChatRetentionChoice): Promise<void>;
}

/** The choice in memory only: gone with the page or process. */
export class MemoryChatRetentionStore implements ChatRetentionStore {
  #choice: ChatRetentionChoice | undefined;

  get(): Promise<ChatRetentionChoice | undefined> {
    return Promise.resolve(this.#choice);
  }

  set(choice: ChatRetentionChoice): Promise<void> {
    this.#choice = choice;
    return Promise.resolve();
  }
}

const ROW = "chat";

export interface IndexedDbChatRetentionStoreOptions {
  /** The database's name (default `fadenstack-preferences`; the agent uses one per signed-in user). */
  name?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`; tests pass a fake). */
  indexedDB?: IDBFactory;
}

/** The choice in the browser's IndexedDB, in the person's own preferences database (the `retention` store), beside the thinking level. */
export class IndexedDbChatRetentionStore implements ChatRetentionStore {
  readonly #name: string;
  readonly #factory: IDBFactory;
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbChatRetentionStoreOptions = {}) {
    this.#name = options.name ?? "fadenstack-preferences";
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here; use MemoryChatRetentionStore or your own store.");
    this.#factory = factory;
  }

  async get(): Promise<ChatRetentionChoice | undefined> {
    try {
      if (!this.#db && !(await preferencesExist(this.#factory, this.#name))) return undefined;
      const row = await this.#run<Record<string, unknown> | undefined>("readonly", (store) => store.get(ROW));
      if (!row || typeof row["autoDelete"] !== "boolean" || !isValidRetentionDays(row["maxAgeDays"]) || !isValidRetentionChats(row["maxSessions"])) return undefined;
      return chatRetentionChoice({ autoDelete: row["autoDelete"], maxAgeDays: row["maxAgeDays"], maxSessions: row["maxSessions"] });
    } catch {
      return undefined; // unreadable: no choice
    }
  }

  async set(choice: ChatRetentionChoice): Promise<void> {
    await this.#run("readwrite", (store) => store.put({ id: ROW, autoDelete: choice.autoDelete, maxAgeDays: choice.maxAgeDays, maxSessions: choice.maxSessions }));
  }

  /** Closes the database (a later call opens it again). */
  close(): void {
    void this.#db?.then((db) => db.close());
    this.#db = undefined;
  }

  async #run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([RETENTION_STORE], mode);
      const request = work(tx.objectStore(RETENTION_STORE));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= openPreferences(this.#factory, this.#name, () => { this.#db = undefined; });
    return this.#db;
  }
}
