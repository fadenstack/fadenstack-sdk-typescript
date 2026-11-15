import {
  MemoryPreferenceStore,
  MemoryPromptStore,
  storedPromptStore,
  type ChatHostServices,
  type Clipboard,
  type FileToSave,
  type PreferenceStore,
  type PromptStore,
  type FollowsPerson,
  type PersonSource,
} from "@fadenstack/ui";
import { STANDALONE_PRINCIPAL, userLocalKey, type StorePrincipal } from "@fadenstack/agents";

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

/** Whose choices these are: asked at every use. The chat tells it (`followPerson`); until then, the standalone principal. */
class Person implements FollowsPerson {
  #source: PersonSource | undefined;
  readonly #fixed: { principal: StorePrincipal | undefined } | undefined;

  constructor(fixed?: { principal: StorePrincipal | undefined }) {
    this.#fixed = fixed;
  }

  followPerson(source: PersonSource): void {
    this.#source = source;
  }

  /** The person now; undefined while the chat has not yet learned whose they are. */
  now(): { principal: StorePrincipal | undefined } | undefined {
    return this.#fixed ?? (this.#source ? this.#source() : { principal: STANDALONE_PRINCIPAL });
  }
}

const isStandalone = (p: StorePrincipal | undefined): boolean => p?.tenantId === STANDALONE_PRINCIPAL.tenantId && p.userId === STANDALONE_PRINCIPAL.userId;

/**
 * What a person of the browser profile keeps as `fadenstack.<name>:<tenant>:<user>` in `localStorage` (`userLocalKey`): the
 * choices of two people who use one profile are apart, and `deleteMyData` removes the signed-in person's. The chat gives the
 * store the agent's principal (`followPerson`); used on its own it keeps the standalone principal's. A server that names no user
 * keeps the one shared key as before. The standalone principal reads the key every person shared before (`fadenstack.<name>`)
 * while it has none of its own: those choices were made on this browser by whoever used the app, which in the standalone case is
 * its one person. The old key is left alone (a person's own may then differ), and `deleteMyData` removes it with the rest.
 * Where there is no `localStorage` (Node, a sandboxed frame, storage switched off), memory.
 */
export function browserPreferences(options: { principal?: StorePrincipal | undefined } = {}): PreferenceStore & FollowsPerson {
  const person = new Person("principal" in options ? { principal: options.principal } : undefined);
  const storage = localStorageOrUndefined();
  const memory = new MemoryPreferenceStore(); // when the browser refuses a write (quota, private mode), or no one is known
  const memoryName = (name: string, now: { principal: StorePrincipal | undefined }): string => userLocalKey(name, now.principal);
  return {
    followPerson: (source) => person.followPerson(source),
    get: (name) => {
      const now = person.now();
      if (!now) return undefined; // whose they are is not known yet
      if (!storage) return memory.get(memoryName(name, now));
      try {
        const own = storage.getItem(userLocalKey(name, now.principal));
        if (own !== null) return own;
        return (isStandalone(now.principal) ? storage.getItem(`fadenstack.${name}`) : null) ?? memory.get(memoryName(name, now));
      } catch {
        return memory.get(memoryName(name, now));
      }
    },
    set: (name, value) => {
      const now = person.now();
      if (!now) return;
      const key = userLocalKey(name, now.principal);
      if (!storage) return memory.set(memoryName(name, now), value);
      try {
        if (value === undefined) {
          // A choice forgotten must not come back from the shared key the standalone principal adopts: its own key then holds "".
          if (isStandalone(now.principal) && storage.getItem(`fadenstack.${name}`) !== null) storage.setItem(key, "");
          else storage.removeItem(key);
          memory.set(key, undefined);
        } else storage.setItem(key, value);
      } catch {
        memory.set(key, value);
      }
    },
  };
}

/**
 * The person's prompts in the browser's localStorage under `fadenstack.prompts:<tenant>:<user>` (`userLocalKey`), apart from
 * another person's of the browser profile: `storedPromptStore` over localStorage, following the agent's principal like
 * `browserPreferences()` (and with the same adoption of the old shared key for the standalone principal). Where there is no
 * localStorage (Node, a sandboxed frame, storage switched off), memory; when the browser refuses a write (quota, private
 * mode), memory from then on.
 */
export function browserPromptStore(options: { now?: () => Date; principal?: StorePrincipal | undefined } = {}): PromptStore & FollowsPerson {
  const person = new Person("principal" in options ? { principal: options.principal } : undefined);
  const storage = localStorageOrUndefined();
  const inner: PromptStore = storage
    ? storedPromptStore(storage, {
      ...(options.now ? { now: options.now } : {}),
      keys: () => {
        const now = person.now();
        if (!now) return undefined;
        return { key: userLocalKey("prompts", now.principal), ...(isStandalone(now.principal) ? { legacyKey: "fadenstack.prompts" } : {}) };
      },
    })
    : new MemoryPromptStore(options);
  return {
    followPerson: (source) => person.followPerson(source),
    list: () => inner.list(),
    save: (text) => inner.save(text),
    remove: (id) => inner.remove(id),
  };
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

/** The bytes of a file the person chose (`File.arrayBuffer`, or a `FileReader` where a browser has none). */
export function readFileBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}

/** Asks for one file with the browser's picker; undefined when the person cancels. Call it inside a click: a picker needs the gesture. */
function pickFile(accept: string, signal?: AbortSignal): Promise<File | undefined> {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const input = doc.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.style.display = "none";
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;
    const done = (file: File | undefined) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0]), { once: true });
    input.addEventListener("cancel", () => done(undefined), { once: true });
    signal?.addEventListener("abort", () => done(undefined), { once: true });
    doc.body.appendChild(input);
    input.click();
  });
}

/**
 * The browser's ways for the skill editor (`SkillFileHost`): the file picker for a zip to import and for a file to add to a skill,
 * and the exported zip as a download (a Blob behind an object URL and a temporary `<a download>`). A browser has no folders, so a
 * zip is the only way in and out. Where there is no page it answers undefined or false.
 */
export function browserSkillFiles(): {
  pickImport(signal?: AbortSignal): Promise<{ readonly name: string; readonly bytes: Uint8Array } | undefined>;
  saveExport(suggestedFileName: string, zip: Uint8Array): Promise<boolean>;
  pickResource(signal?: AbortSignal): Promise<{ readonly path: string; readonly bytes: Uint8Array } | undefined>;
} {
  return {
    async pickImport(signal) {
      const file = await pickFile(".zip", signal);
      return file ? { name: file.name, bytes: await readFileBytes(file) } : undefined;
    },
    async pickResource(signal) {
      const file = await pickFile("", signal);
      return file ? { path: file.name, bytes: await readFileBytes(file) } : undefined;
    },
    saveExport(suggestedFileName, zip) {
      const doc = (globalThis as { document?: Document }).document;
      if (!doc || typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || typeof Blob === "undefined") return Promise.resolve(false);
      const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
      const link = doc.createElement("a");
      link.href = url;
      link.download = suggestedFileName;
      link.rel = "noopener";
      link.style.display = "none";
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 40_000);
      return Promise.resolve(true);
    },
  };
}
