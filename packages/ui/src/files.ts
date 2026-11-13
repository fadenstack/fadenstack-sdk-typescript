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
 * Saving a file is the host's: an extension uses `chrome.downloads`, Office a dialog, a web page the browser's download
 * (`browserSaveFile` in `@fadenstack/ui-web`).
 */
export type SaveFile = (file: FileToSave) => void | Promise<void>;
