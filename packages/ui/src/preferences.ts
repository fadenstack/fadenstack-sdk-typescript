/**
 * Where the user's choices for the panel are kept, such as the language picked in its settings: one value per name.
 * The host passes it: its own (an extension's storage, the host application's settings, a user's settings on a server),
 * or the browser's localStorage (`browserPreferences()` in `@fadenstack/ui-web`).
 */
export interface PreferenceStore {
  get(name: string): string | undefined | Promise<string | undefined>;
  /** `undefined` forgets the value. */
  set(name: string, value: string | undefined): void | Promise<void>;
}

/** Choices kept for as long as the page lives (tests, a host that keeps nothing). */
export class MemoryPreferenceStore implements PreferenceStore {
  readonly #values = new Map<string, string>();

  get(name: string): string | undefined {
    return this.#values.get(name);
  }

  set(name: string, value: string | undefined): void {
    if (value === undefined) this.#values.delete(name);
    else this.#values.set(name, value);
  }
}
