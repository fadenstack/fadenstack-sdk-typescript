import type { ReasoningEffort } from "@fadenstack/client";

import { userStoreName } from "./userData.js";
import type { AgentPrincipal } from "@fadenstack/client";

/**
 * How long a model thinks before it answers: what the person picks in the agent's UI. `auto` is the agent's own (nothing is
 * sent, or the server's maximum), `off` answers at once. .NET: `ReasoningLevel`.
 */
export type ReasoningLevel = "auto" | "off" | "low" | "medium" | "high";

/** All levels, in the order a menu lists them. */
export const REASONING_LEVELS: readonly ReasoningLevel[] = Object.freeze(["auto", "off", "low", "medium", "high"] as const);

/** The level's name on the wire and in the profile: `auto`, `none`, `low`, `medium` or `high`. */
export function reasoningWire(level: ReasoningLevel): string {
  return level === "off" ? "none" : level;
}

/** The level a name stands for (`off` too, any case); undefined for anything else. */
export function parseReasoningLevel(name: unknown): ReasoningLevel | undefined {
  if (typeof name !== "string") return undefined;
  switch (name.trim().toLowerCase()) {
    case "auto": return "auto";
    case "none":
    case "off": return "off";
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    default: return undefined;
  }
}

/** What a request carries for the level: undefined for `auto`, which sends no field. */
export function reasoningEffort(level: ReasoningLevel): ReasoningEffort | undefined {
  switch (level) {
    case "off": return "none";
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    default: return undefined;
  }
}

/** The level an app's `useReasoning` comes closest to (`minimal` shows as Low, since it does think; extra high is High). */
export function reasoningLevelOf(effort: ReasoningEffort | undefined): ReasoningLevel {
  switch (effort) {
    case "none": return "off";
    case "minimal":
    case "low": return "low";
    case "medium": return "medium";
    case "high":
    case "xhigh": return "high";
    default: return "auto";
  }
}

/** The wire value a turn's record carries for `effort`, or `auto` when it carries none. */
export function reasoningRecord(effort: ReasoningEffort | undefined): string {
  return effort ?? "auto";
}

const RANK: Record<ReasoningEffort, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5 };

/**
 * The levels an agent offers: always Auto and Off, and Low, Medium and High up to the maximum the server may set in the
 * agent's profile, `ui.reasoning` (`{"max": "low"}`; the gateway's scale none, minimal, low, medium, high, xhigh or max:
 * `minimal` caps at none, the nearest level the SDK can pick, and `max` sets no cap). Without a maximum, or with one that is
 * not readable, all five are offered and Auto sends no field. With one, Auto means the maximum. .NET: `ReasoningChoices`.
 */
export class ReasoningChoices {
  /** All five levels and no maximum: what an agent offers when its profile says nothing usable. */
  static readonly everything: ReasoningChoices = new ReasoningChoices(REASONING_LEVELS, undefined);

  /** The levels offered, in menu order. */
  readonly levels: readonly ReasoningLevel[];
  /** The most the server lets the agent think; undefined when it sets none. */
  readonly max: ReasoningEffort | undefined;

  private constructor(levels: readonly ReasoningLevel[], max: ReasoningEffort | undefined) {
    this.levels = levels;
    this.max = max;
  }

  offers(level: ReasoningLevel): boolean {
    return this.levels.includes(level);
  }

  /** The effort a request carries for `effort`: lowered to the maximum when above it. */
  cap(effort: ReasoningEffort | undefined): ReasoningEffort | undefined {
    return effort !== undefined && this.max !== undefined && RANK[effort] > RANK[this.max] ? this.max : effort;
  }

  /** Reads `ui.reasoning.max` out of a profile's `ui`; never throws on what a server wrote there. */
  static fromUi(ui: unknown): ReasoningChoices {
    const node = ui && typeof ui === "object" ? (ui as Record<string, unknown>)["reasoning"] : undefined;
    const raw = node && typeof node === "object" ? (node as Record<string, unknown>)["max"] : undefined;
    if (typeof raw !== "string") return ReasoningChoices.everything;
    const name = raw.trim().toLowerCase();
    // "max" is the top of the gateway's scale: the server lets the agent think as long as it likes.
    // "minimal" lies between none and low; the SDK's levels have no such step, so the cap is the level below it.
    const cap: ReasoningEffort | undefined = name === "none" || name === "minimal" ? "none"
      : name === "low" || name === "medium" || name === "high" || name === "xhigh" ? name : undefined;
    if (cap === undefined) return ReasoningChoices.everything;
    return new ReasoningChoices(REASONING_LEVELS.filter((l) => { const e = reasoningEffort(l); return e === undefined || RANK[e] <= RANK[cap]; }), cap);
  }
}

/**
 * The level each person picked for each agent, kept by the browser (or the host): a preference, not content. Anything
 * unreadable counts as no pick. .NET: `ReasoningChoiceStore`.
 */
export interface ReasoningStore {
  get(agent: string): Promise<ReasoningLevel | undefined>;
  /** Keeps the pick; undefined forgets it. */
  set(agent: string, level: ReasoningLevel | undefined): Promise<void>;
}

/** The pick in memory only: gone with the page or process. */
export class MemoryReasoningStore implements ReasoningStore {
  readonly #picks = new Map<string, ReasoningLevel>();

  get(agent: string): Promise<ReasoningLevel | undefined> {
    return Promise.resolve(this.#picks.get(agent));
  }

  set(agent: string, level: ReasoningLevel | undefined): Promise<void> {
    if (level === undefined) this.#picks.delete(agent);
    else this.#picks.set(agent, level);
    return Promise.resolve();
  }
}

const PICKS = "reasoning";

export interface IndexedDbReasoningStoreOptions {
  /** The database's name (default `fadenstack-preferences`; the agent uses one per signed-in user). */
  name?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`; tests pass a fake). */
  indexedDB?: IDBFactory;
}

/** The pick in the browser's IndexedDB, in the signed-in user's own database: only this origin reads it. */
export class IndexedDbReasoningStore implements ReasoningStore {
  readonly #name: string;
  readonly #factory: IDBFactory;
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbReasoningStoreOptions = {}) {
    this.#name = options.name ?? "fadenstack-preferences";
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here; use MemoryReasoningStore or your own store.");
    this.#factory = factory;
  }

  async get(agent: string): Promise<ReasoningLevel | undefined> {
    try {
      // Reading must not create a database for a person who never picked: where the browser can list them, look first.
      if (!this.#db && !(await this.#exists())) return undefined;
      const row = await this.#run<{ level?: unknown } | undefined>("readonly", (store) => store.get(agent));
      return parseReasoningLevel(row?.level);
    } catch {
      return undefined; // unreadable: no pick
    }
  }

  async set(agent: string, level: ReasoningLevel | undefined): Promise<void> {
    await this.#run("readwrite", (store) => (level === undefined ? store.delete(agent) : store.put({ agent, level: reasoningWire(level) })));
  }

  /** Closes the database (a later call opens it again). */
  close(): void {
    void this.#db?.then((db) => db.close());
    this.#db = undefined;
  }

  async #exists(): Promise<boolean> {
    const list = (this.#factory as { databases?: () => Promise<{ name?: string }[]> }).databases;
    if (typeof list !== "function") return true; // cannot look: open it
    try {
      return (await list.call(this.#factory)).some((d) => d.name === this.#name);
    } catch {
      return true;
    }
  }

  async #run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([PICKS], mode);
      const request = work(tx.objectStore(PICKS));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.#factory.open(this.#name, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(PICKS, { keyPath: "agent" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onblocked = () => reject(new Error("IndexedDB is blocked by another open version."));
    });
    return this.#db;
  }
}

/** The database a signed-in user keeps their picks in (see `userStoreName`). */
export function reasoningStoreName(principal: Pick<AgentPrincipal, "tenantId" | "userId"> | undefined): string {
  return userStoreName("fadenstack-preferences", principal);
}
