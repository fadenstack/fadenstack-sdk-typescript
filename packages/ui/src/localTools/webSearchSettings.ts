import { isAllowedSearxngUrl, type WebSearchStore } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import { englishStrings, type UiStrings } from "../strings.js";

/** Where the person's web searches go: nowhere (off), the Brave Search API with their own key, or a SearXNG instance they name. */
export type WebSearchChoice = "off" | "brave" | "searxng";

export interface WebSearchSettingsOptions {
  /** The person's settings and key (`IndexedDbWebSearchStore`, or `MemoryWebSearchStore` without IndexedDB). */
  store: WebSearchStore;
  /** The texts, asked for on every use (default: English); `retext()` says them again. */
  strings?: () => UiStrings;
  /** Called after Save or Cancel (the Tools page closes its sheet); a view of its own can leave it out. */
  onClose?: () => void;
}

/** The state of the web search as the Tools page's row says it: "Off", "Brave", "SearXNG · host". */
export function webSearchStateText(s: UiStrings, provider: string, searxngUrl: string | undefined): string {
  if (provider === "brave") return s.webSearchStateBrave;
  if (provider === "searxng" && searxngUrl) {
    let host = searxngUrl;
    try {
      host = new URL(searxngUrl).host;
    } catch {
      // an address the store let through is shown as it is
    }
    return s.webSearchStateSearxng(host);
  }
  return s.webSearchStateOff;
}

/**
 * The web search settings sheet (sdk/51 F06): Off, Brave (the person's own key) or a SearXNG address. The key goes to the store's key
 * seal and is never read back: the box is empty, and a key that is kept shows as "saved" with Replace and Remove key. A SearXNG
 * address is checked with `isAllowedSearxngUrl` (https, or http on this computer only, no user or password). Save writes the settings,
 * then the key (a typed one, or none when Remove key was pressed); Cancel writes nothing. The typed key is forgotten when the sheet is
 * saved, cancelled or disposed (OWASP ASVS 5.0 V13). .NET: `WebSearchSettingsViewModel`.
 */
export class WebSearchSettingsViewModel extends Observable {
  readonly #store: WebSearchStore;
  readonly #strings: () => UiStrings;
  readonly #onClose: (() => void) | undefined;
  #choice: WebSearchChoice = "off";
  #address = "";
  #key = "";
  #hasKey = false;
  #replacing = false;
  #removed = false;
  #error: "webSearchKeyMissing" | "webSearchUrlMissing" | "webSearchUrlRefused" | "webSearchSaveFailed" | "" = "";
  #saved = "";
  #busy = false;
  #disposed = false;

  /** Settles when the store was read; the choice, the address and whether a key is kept are known after it. */
  readonly ready: Promise<void>;

  constructor(options: WebSearchSettingsOptions) {
    super();
    this.#store = options.store;
    this.#strings = options.strings ?? (() => englishStrings);
    this.#onClose = options.onClose;
    this.ready = this.#load();
  }

  async #load(): Promise<void> {
    try {
      const [settings, hasKey] = await Promise.all([this.#store.settings(), this.#store.hasBraveKey()]);
      if (this.#disposed) return;
      this.#choice = settings.provider === "brave" ? "brave" : settings.provider === "searxng" ? "searxng" : "off";
      this.#address = settings.searxngUrl ?? "";
      this.#hasKey = hasKey;
    } catch {
      // the store cannot be read: the sheet starts as off, with nothing kept
    }
    this.notify();
  }

  get strings(): UiStrings {
    return this.#strings();
  }

  get title(): string {
    return this.strings.webSearchTitle;
  }

  get choice(): WebSearchChoice {
    return this.#choice;
  }

  set choice(value: WebSearchChoice) {
    if (value === this.#choice) return;
    this.#choice = value;
    this.#error = "";
    this.notify();
  }

  get isOff(): boolean {
    return this.#choice === "off";
  }

  get isBrave(): boolean {
    return this.#choice === "brave";
  }

  get isSearxng(): boolean {
    return this.#choice === "searxng";
  }

  // ---- Brave --------------------------------------------------------------------------------------------------------

  /** The key being typed; never filled from the store. Empty once saved, cancelled or disposed. */
  get key(): string {
    return this.#key;
  }

  set key(value: string) {
    if (value === this.#key) return;
    this.#key = value;
    this.notify();
  }

  /** A key is kept and is neither being replaced nor removed: the box shows "A key is saved" with Replace and Remove key. */
  get keyIsKept(): boolean {
    return this.#hasKey && !this.#replacing && !this.#removed;
  }

  /** The key box is shown (no key is kept, or Replace or Remove key was pressed). */
  get showsKeyInput(): boolean {
    return !this.keyIsKept;
  }

  /** Remove key was pressed: the kept key goes when the sheet is saved. */
  get keyIsRemoved(): boolean {
    return this.#removed;
  }

  /** Remove key is offered while a key is kept and not yet marked. */
  get canRemoveKey(): boolean {
    return this.#hasKey && !this.#removed;
  }

  /** Lets the person type a new key; the kept one stays until they save. */
  replaceKey(): void {
    this.#replacing = true;
    this.#removed = false;
    this.#key = "";
    this.notify();
  }

  /** Marks the kept key for removal when the sheet is saved. */
  removeKey(): void {
    this.#removed = true;
    this.#replacing = false;
    this.#key = "";
    this.notify();
  }

  // ---- SearXNG ------------------------------------------------------------------------------------------------------

  get address(): string {
    return this.#address;
  }

  set address(value: string) {
    if (value === this.#address) return;
    this.#address = value;
    this.notify();
  }

  // ---- lines --------------------------------------------------------------------------------------------------------

  /** Where the key is kept (the key store, which never shows it again). */
  get keptWhereText(): string {
    return this.strings.webSearchKeptStore;
  }

  /** That the query leaves the organisation, and that the assistant asks first (below Auto). */
  get privacyText(): string {
    return this.strings.webSearchPrivacy;
  }

  /** Why the sheet cannot be saved; empty when nothing is wrong. */
  get errorText(): string {
    return this.#error === "" ? "" : this.strings[this.#error];
  }

  get hasError(): boolean {
    return this.#error !== "";
  }

  /** "Saved." after a save that left the sheet open (a view of its own). */
  get savedText(): string {
    return this.#saved;
  }

  get hasSaved(): boolean {
    return this.#saved !== "";
  }

  get isBusy(): boolean {
    return this.#busy;
  }

  // ---- commands -----------------------------------------------------------------------------------------------------

  /** Checks the choice and writes the settings, then the key. */
  async save(): Promise<void> {
    if (this.#busy || this.#disposed) return;
    const s = this.strings;
    this.#saved = "";
    let searxngUrl: string | undefined;
    if (this.#choice === "searxng") {
      searxngUrl = this.#address.trim();
      if (searxngUrl === "") return this.#refuse("webSearchUrlMissing");
      if (!isAllowedSearxngUrl(searxngUrl)) return this.#refuse("webSearchUrlRefused");
    }
    const typed = this.#choice === "brave" ? this.#key.trim() : "";
    if (this.#choice === "brave" && typed === "" && !this.keyIsKept && !(this.#hasKey && this.#replacing)) return this.#refuse("webSearchKeyMissing");
    this.#error = "";
    this.#busy = true;
    this.notify();
    try {
      await this.#store.save(this.#choice === "brave" ? { provider: "brave" } : this.#choice === "searxng" ? { provider: "searxng", searxngUrl: searxngUrl! } : { provider: "none" });
      if (typed !== "") await this.#store.setBraveKey(typed);
      else if (this.#removed) await this.#store.setBraveKey(undefined);
    } catch (e) {
      this.#busy = false;
      // A failed write (a rejected transaction, a full quota, anything the store throws) keeps the sheet open and what was typed.
      // Nothing about the failure is kept or shown: not its message, not the key.
      if (e instanceof TypeError && searxngUrl !== undefined && !isAllowedSearxngUrl(searxngUrl)) return this.#refuse("webSearchUrlRefused");
      return this.#refuse("webSearchSaveFailed");
    }
    this.#busy = false;
    this.#forget();
    try {
      this.#hasKey = await this.#store.hasBraveKey();
    } catch {
      // the next open reads it again
    }
    this.#replacing = false;
    this.#removed = false;
    this.#saved = this.#onClose ? "" : s.webSearchSaved;
    this.notify();
    this.#onClose?.();
  }

  /** Writes nothing; the typed key is forgotten. */
  cancel(): void {
    this.#forget();
    this.#replacing = false;
    this.#removed = false;
    this.notify();
    this.#onClose?.();
  }

  retext(): void {
    this.notify();
  }

  /** The sheet is closed or replaced: no typed key stays. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#key = "";
  }

  #refuse(text: "webSearchKeyMissing" | "webSearchUrlMissing" | "webSearchUrlRefused" | "webSearchSaveFailed"): void {
    this.#error = text;
    this.notify();
  }

  #forget(): void {
    this.#key = "";
  }
}
