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

/** Text for the clipboard, and the same as HTML for programs that paste formatting (mail, documents, spreadsheets). */
export interface ClipboardContent {
  text: string;
  html?: string;
}

export interface Clipboard {
  setText(text: string): void | Promise<void>;
  /** Text and HTML at once; a clipboard without it gets the text. */
  setContent?(content: ClipboardContent): void | Promise<void>;
}

/** Writes `content` to `clipboard`: with its HTML where the clipboard takes HTML. */
export function writeClipboard(clipboard: Clipboard, content: ClipboardContent): void | Promise<void> {
  return content.html && clipboard.setContent ? clipboard.setContent(content) : clipboard.setText(content.text);
}

/** No clipboard (headless): remembers the last text (and HTML). The browser's is `browserClipboard` (`@fadenstack/ui-web`). */
export class MemoryClipboard implements Clipboard {
  lastText: string | undefined;
  lastHtml: string | undefined;

  setText(text: string): void {
    this.lastText = text;
    this.lastHtml = undefined;
  }

  setContent(content: ClipboardContent): void {
    this.lastText = content.text;
    this.lastHtml = content.html;
  }
}
