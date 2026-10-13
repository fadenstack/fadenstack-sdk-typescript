/**
 * Where the user's choices for the panel are kept, such as the language picked in its settings: one value per name.
 * A host passes its own (an extension's storage, the host application's settings); the browser's localStorage by
 * default.
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

/**
 * The browser's localStorage, as `fadenstack.<name>`: one choice for every panel of this site or extension. Where
 * there is none (Node, a sandboxed frame, storage switched off), memory.
 */
export function browserPreferences(): PreferenceStore {
  const storage = localStorageOrUndefined();
  if (!storage) return new MemoryPreferenceStore();
  const memory = new MemoryPreferenceStore(); // when the browser refuses a write (quota, private mode)
  return {
    get: (name) => {
      try {
        return storage.getItem(`fadenstack.${name}`) ?? undefined;
      } catch {
        return memory.get(name);
      }
    },
    set: (name, value) => {
      try {
        if (value === undefined) storage.removeItem(`fadenstack.${name}`);
        else storage.setItem(`fadenstack.${name}`, value);
      } catch {
        memory.set(name, value);
      }
    },
  };
}

function localStorageOrUndefined(): Storage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return undefined;
    storage.getItem("fadenstack.probe"); // throws where access is denied
    return storage;
  } catch {
    return undefined;
  }
}
