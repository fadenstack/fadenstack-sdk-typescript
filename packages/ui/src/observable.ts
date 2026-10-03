export type Listener = () => void;

/**
 * A view model a skin can watch: `subscribe` for changes, `version` to tell whether anything changed. Fits
 * React's `useSyncExternalStore(vm.subscribe, () => vm.version)` and any other binding. Collections are
 * replaced, never changed in place, so a skin compares them by reference.
 */
export abstract class Observable {
  readonly #listeners = new Set<Listener>();
  #version = 0;

  /** Grows on every change. */
  get version(): number {
    return this.#version;
  }

  /** Calls `listener` after each change; returns the unsubscribe. Bound, so it can be passed around. */
  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  protected notify(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }
}
