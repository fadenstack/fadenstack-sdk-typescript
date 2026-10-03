/** When work runs later: a skin's frame clock; `setTimeout` by default. */
export interface UiScheduler {
  schedule(callback: () => void, delayMs: number): void;
}

export const timeoutScheduler: UiScheduler = {
  schedule: (callback, delayMs) => {
    setTimeout(callback, delayMs);
  },
};

/** Runs everything at once: for tests and headless hosts. */
export const immediateScheduler: UiScheduler = {
  schedule: (callback) => callback(),
};

export interface Clipboard {
  setText(text: string): void | Promise<void>;
}

/** No clipboard (headless): remembers the last text. */
export class MemoryClipboard implements Clipboard {
  lastText: string | undefined;

  setText(text: string): void {
    this.lastText = text;
  }
}

/** The browser's clipboard, when there is one. */
export const browserClipboard: Clipboard = {
  setText: (text) => globalThis.navigator?.clipboard?.writeText(text),
};
