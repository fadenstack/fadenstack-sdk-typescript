import { ImportNote, ImportProblem, ImportSkipReason, type ImportCandidateInfo, type ImportPreview, type ImportSkipInfo } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import type { UiStrings } from "../strings.js";
import type { ToolsHost } from "./contracts.js";
import { problemText } from "./serverSheet.js";

/** One server found in the pasted configuration, with a tick box. */
export class ImportRowViewModel extends Observable {
  readonly label: string;
  readonly where: string;
  readonly tickName: string;
  /** What the person should know before they tick it. */
  readonly notes: readonly string[];
  readonly #changed: () => void;
  #ticked = false;

  constructor(s: UiStrings, info: ImportCandidateInfo, changed: () => void) {
    super();
    this.label = info.label;
    this.where = info.where;
    this.tickName = s.toolsImportTick(info.label);
    this.notes = info.notes.map((n) => (n === ImportNote.HeadersLeftOut ? s.toolsImportNoteIgnored(info.detail ?? "") : ""));
    this.#changed = changed;
  }

  get hasNotes(): boolean {
    return this.notes.length > 0;
  }

  get isTicked(): boolean {
    return this.#ticked;
  }

  set isTicked(value: boolean) {
    if (value === this.#ticked) return;
    this.#ticked = value;
    this.notify();
    this.#changed();
  }
}

/** A server of the configuration that is not offered, and why. */
export interface SkippedRowViewModel {
  readonly name: string;
  readonly reason: string;
}

function skipped(s: UiStrings, info: ImportSkipInfo): SkippedRowViewModel {
  let reason: string;
  switch (info.reason) {
    case ImportSkipReason.Program: reason = s.toolsSkipProgram; break;
    case ImportSkipReason.Sse: reason = s.toolsSkipSse; break;
    case ImportSkipReason.NetworkServer: reason = s.toolsSkipNetwork; break;
    case ImportSkipReason.NothingToStart: reason = s.toolsSkipNothing; break;
    case ImportSkipReason.LabelTaken: reason = s.toolsSkipNotValid(s.toolsProblemLabelTaken); break;
    case ImportSkipReason.NotValid: reason = s.toolsSkipNotValid(info.problem ? problemText(s, info.problem) : ""); break;
    default: reason = s.toolsSkipNotUnderstood;
  }
  return { name: info.name, reason };
}

/**
 * The paste-import sheet: the person pastes the MCP configuration of another app (Claude Desktop, VS Code, Cursor, a .mcp.json file);
 * the servers found come with a tick box each, the others with their reasons. Nothing is copied until they tick servers and press
 * Import, and an import never turns on the plain-http switch or marks a server trusted: every server arrives switched off.
 *
 * The pasted text may hold header values (tokens): it is forgotten as soon as it was read (the catalog keeps what it needs for the
 * import, which is never shown), and again when the sheet is cancelled, imported or disposed. A text that could not be read stays so
 * the person can correct it.
 */
export class ImportSheetViewModel extends Observable {
  readonly #page: ToolsHost;
  #text = "";
  #preview: ImportPreview | undefined;
  #candidates: readonly ImportRowViewModel[] = [];
  #skipped: readonly SkippedRowViewModel[] = [];
  #status = "";
  #result = "";
  #busy = false;
  #disposed = false;

  constructor(page: ToolsHost) {
    super();
    this.#page = page;
  }

  get strings(): UiStrings {
    return this.#page.strings;
  }

  /** The pasted configuration (may hold secrets); empty once it was read. */
  get text(): string {
    return this.#text;
  }

  set text(value: string) {
    this.#text = value;
    this.notify();
  }

  get candidates(): readonly ImportRowViewModel[] {
    return this.#candidates;
  }

  get skipped(): readonly SkippedRowViewModel[] {
    return this.#skipped;
  }

  get hasSkipped(): boolean {
    return this.#skipped.length > 0;
  }

  /** "Servers found: 2", or why the text could not be used. */
  get statusText(): string {
    return this.#status;
  }

  get hasStatus(): boolean {
    return this.#status !== "";
  }

  /** The status is a problem with the text (a skin says it as an alert). */
  get statusIsProblem(): boolean {
    return this.#preview !== undefined && this.#preview.problem !== ImportProblem.None;
  }

  get resultText(): string {
    return this.#result;
  }

  get hasResult(): boolean {
    return this.#result !== "";
  }

  get isBusy(): boolean {
    return this.#busy;
  }

  get canRead(): boolean {
    return !this.#busy && this.#text.trim() !== "";
  }

  get canImport(): boolean {
    return !this.#busy && this.#candidates.some((c) => c.isTicked);
  }

  async read(): Promise<void> {
    const s = this.strings;
    this.#result = "";
    this.#candidates = [];
    this.#skipped = [];
    if (this.#text.trim() === "") {
      this.#preview = { problem: ImportProblem.Empty, servers: [], skipped: [] };
      this.#status = s.toolsPasteProblemEmpty;
      this.notify();
      return;
    }
    this.#busy = true;
    this.notify();
    let preview: ImportPreview;
    try {
      preview = await this.#page.catalog.readImport(this.#text);
    } catch {
      preview = { problem: ImportProblem.NotJson, servers: [], skipped: [] };
    } finally {
      this.#busy = false;
    }
    this.#preview = preview;
    switch (preview.problem) {
      case ImportProblem.None: this.#status = s.toolsPasteFound(preview.servers.length); break;
      case ImportProblem.Empty: this.#status = s.toolsPasteProblemEmpty; break;
      case ImportProblem.NoServerList: this.#status = s.toolsPasteProblemNoList; break;
      case ImportProblem.TooLarge: this.#status = s.toolsPasteProblemTooLarge; break;
      default: this.#status = s.toolsPasteProblemNotJson;
    }
    this.#candidates = preview.servers.map((server) => new ImportRowViewModel(s, server, () => this.notify()));
    this.#skipped = preview.skipped.map((skip) => skipped(s, skip));
    if (preview.problem === ImportProblem.None) {
      this.#text = ""; // the catalog holds what the import needs; the pasted text (and any token in it) is not kept here
      if (this.#candidates.length === 0) this.#result = s.toolsImportNothingToAdd;
    }
    this.notify();
  }

  async importSelected(): Promise<void> {
    if (!this.#preview || !this.canImport) return;
    const labels = this.#candidates.filter((c) => c.isTicked).map((c) => c.label);
    this.#busy = true;
    this.notify();
    let added = 0;
    try {
      added = await this.#page.catalog.import(this.#preview, labels);
    } catch {
      added = 0;
    } finally {
      this.#busy = false;
    }
    this.#result = this.strings.toolsImported(added);
    this.#candidates = [];
    this.#preview = undefined;
    this.#text = "";
    this.notify();
    this.#page.refresh();
  }

  cancel(): void {
    this.#page.closeSheet();
  }

  retext(): void {
    this.notify();
  }

  /** The sheet is closed or replaced: no pasted text stays. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#text = "";
    this.#preview = undefined;
    this.#candidates = [];
  }
}
