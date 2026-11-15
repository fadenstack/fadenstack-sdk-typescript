/** A prompt the user saved to use again. */
export interface SavedPrompt {
  id: string;
  /** The first non-empty line of the text, trimmed to 60 characters with an ellipsis. */
  title: string;
  text: string;
  /** When it was saved: an ISO 8601 date and time. */
  savedAt: string;
}

/**
 * Where the user's own prompts are kept: a host passes its own (an extension's storage, a server) or the browser's
 * localStorage (`browserPromptStore()` in `@fadenstack/ui-web`); without one the feature is absent. Newest first. `save`
 * refuses what is empty, longer than `MAX_PROMPT_LENGTH` or beyond `MAX_PROMPTS` with a `PromptStoreError`.
 */
export interface PromptStore {
  list(): Promise<SavedPrompt[]>;
  save(text: string): Promise<SavedPrompt>;
  remove(id: string): Promise<void>;
}

/** The most prompts a store keeps. */
export const MAX_PROMPTS = 100;
/** The longest prompt, in characters. */
export const MAX_PROMPT_LENGTH = 4000;
/** The longest title, in characters, the ellipsis included. */
const MAX_TITLE_LENGTH = 60;

/** Why a store refused a prompt: nothing to save (`empty`), `too_long`, or `too_many` (the limits above). */
export type PromptStoreErrorCode = "empty" | "too_long" | "too_many";

/** What `PromptStore.save` throws for a prompt it refuses; a skin shows `chat.savePrompt`'s translated message. */
export class PromptStoreError extends Error {
  readonly code: PromptStoreErrorCode;

  constructor(code: PromptStoreErrorCode) {
    super(code === "empty" ? "A prompt needs some text."
      : code === "too_long" ? `A prompt can have at most ${MAX_PROMPT_LENGTH} characters.`
      : `At most ${MAX_PROMPTS} prompts can be kept.`);
    this.name = "PromptStoreError";
    this.code = code;
  }
}

/** The title of a prompt: its first non-empty line, trimmed, and cut to 60 characters with an ellipsis. */
export function promptTitle(text: string): string {
  const line = (text.split(/\r\n|\r|\n/).find((l) => l.trim() !== "") ?? "").trim().replace(/\s+/g, " ");
  const characters = Array.from(line);
  return characters.length <= MAX_TITLE_LENGTH ? line : `${characters.slice(0, MAX_TITLE_LENGTH - 1).join("").trimEnd()}…`;
}

let counter = 0;

function newId(): string {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  return typeof random === "function" ? random.call(globalThis.crypto) : `p${Date.now().toString(36)}${(++counter).toString(36)}`;
}

/** What a saved list in storage is allowed to look like: other entries are dropped when it is read. */
function sanitize(value: unknown): SavedPrompt[] {
  if (!Array.isArray(value)) return [];
  const out: SavedPrompt[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e["id"] !== "string" || typeof e["text"] !== "string" || !e["text"].trim() || e["text"].length > MAX_PROMPT_LENGTH) continue;
    out.push({
      id: e["id"], text: e["text"], title: typeof e["title"] === "string" && e["title"] ? e["title"] : promptTitle(e["text"]),
      savedAt: typeof e["savedAt"] === "string" ? e["savedAt"] : "",
    });
    if (out.length >= MAX_PROMPTS) break;
  }
  return out;
}

/** The rules of a store over a list it reads and writes. */
class ListPromptStore implements PromptStore {
  readonly #read: () => SavedPrompt[];
  readonly #write: (list: SavedPrompt[]) => void;
  readonly #now: () => Date;

  constructor(read: () => SavedPrompt[], write: (list: SavedPrompt[]) => void, now: () => Date) {
    this.#read = read;
    this.#write = write;
    this.#now = now;
  }

  list(): Promise<SavedPrompt[]> {
    return Promise.resolve(this.#read().map((p) => ({ ...p })));
  }

  save(text: string): Promise<SavedPrompt> {
    try {
      const trimmed = text.trim();
      if (!trimmed) throw new PromptStoreError("empty");
      if (trimmed.length > MAX_PROMPT_LENGTH) throw new PromptStoreError("too_long");
      const list = this.#read();
      const same = list.find((p) => p.text === trimmed);
      if (same) return Promise.resolve({ ...same }); // the same text is kept once
      if (list.length >= MAX_PROMPTS) throw new PromptStoreError("too_many");
      const prompt: SavedPrompt = { id: newId(), title: promptTitle(trimmed), text: trimmed, savedAt: this.#now().toISOString() };
      this.#write([prompt, ...list]);
      return Promise.resolve({ ...prompt });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  remove(id: string): Promise<void> {
    const list = this.#read();
    if (list.some((p) => p.id === id)) this.#write(list.filter((p) => p.id !== id));
    return Promise.resolve();
  }
}

/** Prompts kept for as long as the page lives (tests, a host that keeps nothing). */
export class MemoryPromptStore implements PromptStore {
  readonly #store: ListPromptStore;

  constructor(options: { now?: () => Date } = {}) {
    let list: SavedPrompt[] = [];
    this.#store = new ListPromptStore(() => list, (next) => void (list = next), options.now ?? (() => new Date()));
  }

  list(): Promise<SavedPrompt[]> {
    return this.#store.list();
  }

  save(text: string): Promise<SavedPrompt> {
    return this.#store.save(text);
  }

  remove(id: string): Promise<void> {
    return this.#store.remove(id);
  }
}

/** The key a stored prompt list is kept under (`storedPromptStore`; the browser's store in localStorage). */
export const PROMPTS_STORAGE_KEY = "fadenstack.prompts";

/**
 * Text kept by key in a store that may refuse, synchronously: what `storedPromptStore` keeps its list in. The browser's
 * localStorage is one; so is a host's own synchronous key-value store.
 */
export interface KeyedTextStorage {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
}

/**
 * The keys a person's prompt list is kept under: `key` is theirs; `legacyKey`, when given, is the older key shared by everyone in
 * the browser profile, which is read while `key` holds nothing (it is never written).
 */
export interface PromptKeys {
  key: string;
  legacyKey?: string;
}

/**
 * The user's prompts in `storage` under `PROMPTS_STORAGE_KEY` (or, per person, under `options.keys()`: undefined while whose
 * they are is not known, when nothing is read and a save is refused), as JSON: one list for everything that shares the storage.
 * A damaged list reads as empty, and entries that are not prompts are dropped. When the storage refuses a write (quota,
 * private mode), the list is kept in memory from then on. `browserPromptStore()` (`@fadenstack/ui-web`) is this over
 * localStorage.
 */
export function storedPromptStore(storage: KeyedTextStorage, options: { now?: () => Date; keys?: () => PromptKeys | undefined } = {}): PromptStore {
  let memory: SavedPrompt[] | undefined; // when the storage refused a write: this list is the truth from then on
  let memoryKey: string | undefined; // whose the in-memory list is
  const keysNow = (): PromptKeys | undefined => {
    const keys = options.keys ? options.keys() : { key: PROMPTS_STORAGE_KEY };
    if (keys && keys.key !== memoryKey) {
      memoryKey = keys.key;
      memory = undefined; // another person: never the last one's list
    }
    return keys;
  };
  const read = (): SavedPrompt[] => {
    const keys = keysNow();
    if (!keys) return []; // whose prompts these are is not known yet
    if (memory) return memory;
    try {
      // The person's own key; where there is none yet, the key every person of the browser profile shared before (`legacyKey`,
      // given for the standalone principal only), read until the person's first save writes their own.
      const raw = storage.getItem(keys.key) ?? (keys.legacyKey !== undefined ? storage.getItem(keys.legacyKey) : undefined);
      return raw ? sanitize(JSON.parse(raw) as unknown) : [];
    } catch {
      return [];
    }
  };
  const write = (list: SavedPrompt[]): void => {
    const keys = keysNow();
    if (!keys) throw new Error("Whose prompts these are is not known yet."); // the chat reports "not saved"
    try {
      storage.setItem(keys.key, JSON.stringify(list));
      memory = undefined;
    } catch {
      memory = list;
    }
  };
  return new ListPromptStore(read, write, options.now ?? (() => new Date()));
}

/** Lower case without accents, so "uberprufung" finds "Überprüfung". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The prompts that match `query` in their title or text, titles first; all of them for an empty query. Accents and case do not matter. */
export function matchPrompts(prompts: readonly SavedPrompt[], query: string): SavedPrompt[] {
  const q = fold(query.trim());
  if (!q) return [...prompts];
  const titled: SavedPrompt[] = [];
  const texted: SavedPrompt[] = [];
  for (const prompt of prompts) {
    if (fold(prompt.title).includes(q)) titled.push(prompt);
    else if (fold(prompt.text).includes(q)) texted.push(prompt);
  }
  return [...titled, ...texted];
}
