import {
  MemoryPreferenceStore,
  MemoryPromptStore,
  storedPromptStore,
  type ChatHostServices,
  type Clipboard,
  type FileToSave,
  type PreferenceStore,
  type PromptStore,
} from "@fadenstack/ui";

// The browser's ways for what the panel needs from its host (`ChatHostServices` in @fadenstack/ui, which has no browser
// default of its own: sdk/52 P4). A web page passes `browserChatServices()`; a host with its own ways passes those.

/** The browser's clipboard, when there is one. Rejects when the browser refuses (a page without focus). */
export const browserClipboard: Clipboard = {
  setText: (text) => globalThis.navigator?.clipboard?.writeText(text),
  setContent: (content) => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) return undefined;
    if (!content.html || typeof ClipboardItem === "undefined") return clipboard.writeText(content.text);
    return clipboard.write([new ClipboardItem({
      "text/plain": new Blob([content.text], { type: "text/plain" }),
      "text/html": new Blob([content.html], { type: "text/html" }),
    })]);
  },
};

/** A link in a new tab, with no way back to the panel and no Referer (intranet addresses stay inside). */
export function browserOpenLink(url: string): void {
  globalThis.open?.(url, "_blank", "noopener,noreferrer");
}

/**
 * Saves a file the browser's way: a Blob behind an object URL, a temporary `<a download>` that is clicked, then the URL
 * is released. Where there is no page (Node, a worker) it does nothing.
 */
export function browserSaveFile(file: FileToSave): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || typeof Blob === "undefined") return;
  const url = URL.createObjectURL(new Blob([file.content], { type: `${file.type};charset=utf-8` }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = file.name;
  link.rel = "noopener";
  link.style.display = "none";
  doc.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked once the browser surely has the file: revoking at once may cancel a download that has not started yet.
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
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

/**
 * The user's prompts in the browser's localStorage under `fadenstack.prompts` (one list for every panel of this site or
 * extension): `storedPromptStore` over localStorage. Where there is none (Node, a sandboxed frame, storage switched off),
 * memory; when the browser refuses a write (quota, private mode), memory from then on.
 */
export function browserPromptStore(options: { now?: () => Date } = {}): PromptStore {
  const storage = localStorageOrUndefined();
  return storage ? storedPromptStore(storage, options) : new MemoryPromptStore(options);
}

/**
 * The browser's four for a chat panel in a web page: `{ clipboard, openLink, saveFile, preferences }`, to spread into the
 * view model's options. Override what the host does its own way: `{ ...browserChatServices(), preferences: mine }`.
 */
export function browserChatServices(): ChatHostServices {
  return {
    clipboard: browserClipboard,
    openLink: browserOpenLink,
    saveFile: browserSaveFile,
    preferences: browserPreferences(),
  };
}

/** The page's localStorage, or undefined where there is none or access is denied. */
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
