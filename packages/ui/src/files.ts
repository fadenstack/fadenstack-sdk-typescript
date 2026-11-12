/** A file the panel hands to the host to save: a table as CSV, a chat as Markdown. */
export interface FileToSave {
  /** A safe file name with its extension. */
  name: string;
  /** The media type: `text/csv`, `text/markdown`. */
  type: string;
  /** The text of the file (UTF-8). */
  content: string;
}

/**
 * Saving a file is the host's: an extension uses `chrome.downloads`, Office a dialog. By default the browser's
 * download (`browserSaveFile`).
 */
export type SaveFile = (file: FileToSave) => void | Promise<void>;

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
  setTimeout(() => URL.revokeObjectURL(url), 0); // the download has started by then
}
