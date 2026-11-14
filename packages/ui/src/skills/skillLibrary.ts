import {
  SkillIssueCode,
  SkillLimits,
  SkillOrigin,
  SkillSaveStatus,
  SkillSeverity,
  createSkillDocument,
  importAnalysis,
  skillIssue,
  type ImportAnalysis,
  type SkillDocument,
  type SkillEntry,
  type SkillWorkshop,
  type SkillZipFile,
} from "@fadenstack/agents";

import { Observable } from "../observable.js";
import { englishStrings } from "../strings.js";
import {
  skillIssueText,
  skillIssueView,
  skillOriginLabel,
  type SkillFileHost,
  type SkillIssueView,
  type SkillModel,
  type StringsSource,
} from "./contracts.js";
import { SkillDraftViewModel, type SkillDraftMessage } from "./skillDraft.js";
import { SkillEditorMode, SkillEditorViewModel, type SkillEditorClosed } from "./skillEditor.js";

/** A skill in the library list: where it comes from, what the person may do with it, and its switch. */
export class SkillRowViewModel extends Observable {
  readonly entry: SkillEntry;
  readonly #strings: StringsSource;
  #enabled: boolean;

  constructor(entry: SkillEntry, strings: StringsSource) {
    super();
    this.entry = entry;
    this.#strings = strings;
    this.#enabled = entry.enabled;
  }

  get name(): string {
    return this.entry.name;
  }

  get description(): string {
    return this.entry.description;
  }

  get origin(): SkillOrigin {
    return this.entry.origin;
  }

  /** "Built in", "Yours" or "Your organisation". */
  get originLabel(): string {
    return skillOriginLabel(this.#strings(), this.entry.origin);
  }

  /** "Not reviewed" for the person's own skills; empty for the others. */
  get statusLabel(): string {
    return this.entry.notReviewed ? this.#strings().skillNotReviewed : "";
  }

  get isNotReviewed(): boolean {
    return this.entry.notReviewed;
  }

  /** The skill cannot be used as it is (its record breaks a rule): the module does not list it; open it to fix it, or delete it. */
  get isBroken(): boolean {
    return this.entry.isBroken;
  }

  get isEnabled(): boolean {
    return this.#enabled;
  }

  set isEnabled(value: boolean) {
    if (value === this.#enabled) return;
    this.#enabled = value;
    this.notify();
  }

  get switchLabel(): string {
    return this.#enabled ? this.#strings().skillOn : this.#strings().skillOff;
  }

  get canSwitch(): boolean {
    return this.entry.canSwitch;
  }

  get isReadOnly(): boolean {
    return this.entry.isReadOnly;
  }

  /** Open it for editing (own) or for reading (bundled); an organisation's skill has no text to show. */
  get canOpen(): boolean {
    return this.entry.origin !== SkillOrigin.Organisation;
  }

  get canDuplicate(): boolean {
    return this.entry.origin !== SkillOrigin.Organisation && !this.entry.isBroken;
  }

  get canDelete(): boolean {
    return this.entry.origin === SkillOrigin.Own;
  }

  get canExport(): boolean {
    return this.entry.origin !== SkillOrigin.Organisation && !this.entry.isBroken;
  }

  retext(): void {
    this.notify();
  }
}

export interface SkillLibraryOptions {
  /** The skills (`SkillsModule.workshop()` of `@fadenstack/skills`). */
  workshop: SkillWorkshop;
  /** Dialogs for import, export and adding a file; without it those commands do nothing. */
  files?: SkillFileHost | undefined;
  /** The model for the editor's "ask the model once" and for the draft (one call, no tool runs); without it those are off. */
  model?: SkillModel | undefined;
  /** The texts; English by default. */
  strings?: StringsSource | undefined;
}

/**
 * The skill library (sdk/51 F04): the bundled, the person's own and (governed mode) the organisation's skills with their labels and
 * on/off switches, and new, edit, duplicate, delete (after a confirmation), import (after the checks and a confirmation) and export.
 * Platform-neutral: the skins draw it. Nothing is written except by a command the person started, and an import writes nothing
 * until every check has passed and the person pressed Import. A newer action makes an older one's answer stale, and a stale
 * answer changes nothing. .NET: `SkillLibraryViewModel`.
 */
export class SkillLibraryViewModel extends Observable {
  readonly #workshop: SkillWorkshop;
  readonly #files: SkillFileHost | undefined;
  readonly #model: SkillModel | undefined;
  readonly #strings: StringsSource;
  #listVersion = 0;
  #importVersion = 0;
  #rows: readonly SkillRowViewModel[] = [];
  #loading = false;
  #loaded = false;
  #failed = false;
  #message = "";
  #pendingDelete: SkillRowViewModel | undefined;
  #pendingImport: ImportAnalysis | undefined;
  #importIssues: readonly SkillIssueView[] = [];
  #importBusy = false;
  #editor: SkillEditorViewModel | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: SkillLibraryOptions) {
    super();
    this.#workshop = options.workshop;
    this.#files = options.files;
    this.#model = options.model;
    this.#strings = options.strings ?? (() => englishStrings);
  }

  /** The skills, bundled first, then the person's own, then the organisation's. */
  get rows(): readonly SkillRowViewModel[] {
    return this.#rows;
  }

  get isLoading(): boolean {
    return this.#loading;
  }

  /** The list could not be read. */
  get failed(): boolean {
    return this.#failed;
  }

  get isEmpty(): boolean {
    return this.#loaded && this.#rows.length === 0;
  }

  /** What the library says instead of a list: reading, could not read, none yet; else empty. */
  get note(): string {
    const strings = this.#strings();
    return this.#loading && !this.#loaded ? strings.skillLibraryLoading : this.#failed ? strings.skillLibraryFailed : this.isEmpty ? strings.skillLibraryEmpty : "";
  }

  /** What the last action did ("x was saved"), or why not; empty when nothing was said. */
  get message(): string {
    return this.#message;
  }

  /** The skill the person asked to delete, until they confirm or cancel. */
  get pendingDelete(): SkillRowViewModel | undefined {
    return this.#pendingDelete;
  }

  get deleteTitle(): string {
    return this.#pendingDelete ? this.#strings().skillDeleteTitle(this.#pendingDelete.name) : "";
  }

  get deleteBody(): string {
    return this.#strings().skillDeleteBody;
  }

  /** What an import found, until the person confirms or cancels. Nothing is written yet. */
  get pendingImport(): ImportAnalysis | undefined {
    return this.#pendingImport;
  }

  /** The findings of the import's checks. */
  get importIssues(): readonly SkillIssueView[] {
    return this.#importIssues;
  }

  /** The import passed every check: the person may press Import. */
  get canConfirmImport(): boolean {
    return this.#pendingImport?.ok === true && !this.#importBusy;
  }

  /** The import would replace a skill of the same name: the button says Replace, and the text says so. */
  get importReplaces(): boolean {
    return this.#pendingImport?.wouldReplace === true;
  }

  get importTitle(): string {
    const document = this.#pendingImport?.document;
    return document ? this.#strings().skillImportTitle(document.name) : this.#strings().skillImportRefused;
  }

  get importBody(): string {
    const pending = this.#pendingImport;
    const strings = this.#strings();
    return !pending ? "" : !pending.ok ? strings.skillImportRefused : pending.wouldReplace ? strings.skillImportReplaceBody(pending.document!.name) : strings.skillImportBody;
  }

  /** The editor that is open, if any (new, edit, duplicate, view or a draft's proposal). */
  get editor(): SkillEditorViewModel | undefined {
    return this.#editor;
  }

  get canNew(): boolean {
    return this.#editor === undefined;
  }

  canEdit(row: SkillRowViewModel | undefined): boolean {
    return row?.canOpen === true && this.#editor === undefined;
  }

  canDuplicate(row: SkillRowViewModel | undefined): boolean {
    return row?.canDuplicate === true && this.#editor === undefined;
  }

  canAskDelete(row: SkillRowViewModel | undefined): boolean {
    return row?.canDelete === true;
  }

  get canConfirmDelete(): boolean {
    return this.#pendingDelete !== undefined;
  }

  canToggle(row: SkillRowViewModel | undefined): boolean {
    return row?.canSwitch === true;
  }

  get canImport(): boolean {
    return this.#files !== undefined && !this.#importBusy && this.#editor === undefined;
  }

  canExport(row: SkillRowViewModel | undefined): boolean {
    return this.#files !== undefined && row?.canExport === true;
  }

  /** Reads the list again. */
  async refresh(): Promise<void> {
    const version = ++this.#listVersion;
    this.#loading = true;
    this.notify();
    let entries: readonly SkillEntry[] | undefined;
    try {
      entries = await this.#workshop.list();
    } catch {
      entries = undefined;
    }
    if (version !== this.#listVersion) return; // a newer read is on its way
    this.#loading = false;
    if (entries === undefined) this.#failed = true;
    else {
      this.#failed = false;
      this.#loaded = true;
      this.#rows = entries.map((e) => new SkillRowViewModel(e, this.#strings));
    }
    this.notify();
  }

  /** The app's language changed: the labels are said in the new one. */
  retext(): void {
    for (const row of this.#rows) row.retext();
    this.#editor?.retext();
    this.notify();
  }

  #open(editor: SkillEditorViewModel): void {
    this.#unsubscribe?.();
    this.#unsubscribe = editor.onClosed((event) => this.#onEditorClosed(editor, event));
    this.#editor = editor;
    this.notify();
  }

  #newEditor(mode: SkillEditorMode, document: SkillDocument, originalName?: string, readIssues?: SkillIssueList): SkillEditorViewModel {
    return new SkillEditorViewModel({ workshop: this.#workshop, mode, document, originalName, readIssues, files: this.#files, model: this.#model, strings: this.#strings });
  }

  /** Shows an editor the app opened (a draft's proposal): the library closes it again when it is saved or cancelled. */
  openEditor(editor: SkillEditorViewModel): void {
    if (!editor) throw new TypeError("An editor is needed.");
    this.#open(editor);
  }

  #onEditorClosed(editor: SkillEditorViewModel, event: SkillEditorClosed): void {
    if (this.#editor !== editor) return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#editor = undefined;
    if (event.saved) this.#message = this.#strings().skillSaved(event.name ?? "");
    this.notify();
    void this.refresh();
  }

  /**
   * "Draft from this chat": a draft view model on the app's conversation. When the model's draft is ready it opens in `editor` as a
   * proposal; nothing is saved until the person presses Save there.
   */
  createDraft(conversation: () => readonly SkillDraftMessage[]): SkillDraftViewModel {
    const draft = new SkillDraftViewModel({ workshop: this.#workshop, model: this.#model, conversation, files: this.#files, strings: this.#strings });
    draft.onProposal((editor) => this.#open(editor));
    return draft;
  }

  /** A new skill, empty. */
  newSkill(): void {
    if (this.canNew) this.#open(this.#newEditor(SkillEditorMode.New, createSkillDocument()));
  }

  /** Opens a skill for editing (own) or for reading (bundled). */
  async edit(row: SkillRowViewModel | undefined): Promise<void> {
    if (!row || !this.canEdit(row)) return;
    const read = await this.#workshop.read(row.name);
    if (this.#editor !== undefined) return;
    if (!read.document) {
      const first = read.issues[0];
      this.#message = skillIssueText(this.#strings(), first?.code ?? SkillIssueCode.ReadFailed, row.name, 0, 0, first?.detail ?? "");
      this.notify();
      return;
    }
    this.#open(this.#newEditor(row.isReadOnly ? SkillEditorMode.View : SkillEditorMode.Edit, read.document, row.isReadOnly ? undefined : row.name, read.issues));
  }

  /** A copy of a skill as a new one: the person reads it and saves it; nothing is written yet. */
  async duplicate(row: SkillRowViewModel | undefined): Promise<void> {
    if (!row || !this.canDuplicate(row)) return;
    const read = await this.#workshop.read(row.name);
    const taken = new Set((await this.#workshop.list()).map((e) => e.name));
    if (this.#editor !== undefined) return;
    if (!read.document) {
      this.#message = skillIssueText(this.#strings(), SkillIssueCode.ReadFailed, row.name, 0, 0, "");
      this.notify();
      return;
    }
    this.#open(this.#newEditor(SkillEditorMode.New, { ...read.document, name: copyName(row.name, taken), unknownKeys: [] }));
  }

  askDelete(row: SkillRowViewModel | undefined): void {
    if (!row || !row.canDelete) return;
    this.#pendingDelete = row;
    this.notify();
  }

  cancelDelete(): void {
    if (this.#pendingDelete === undefined) return;
    this.#pendingDelete = undefined;
    this.notify();
  }

  async confirmDelete(): Promise<void> {
    const row = this.#pendingDelete;
    if (!row) return;
    this.#pendingDelete = undefined;
    let deleted = false;
    try {
      deleted = await this.#workshop.delete(row.name);
    } catch {
      deleted = false;
    }
    this.#message = deleted ? this.#strings().skillDeleted(row.name) : this.#strings().skillSaveFailed;
    this.notify();
    await this.refresh();
  }

  /** Switches a skill on or off. */
  async toggle(row: SkillRowViewModel | undefined): Promise<void> {
    if (!row || !row.canSwitch) return;
    const on = !row.isEnabled;
    row.isEnabled = on;
    row.retext();
    try {
      await this.#workshop.setEnabled(row.name, on);
    } catch {
      // the list below shows what is true
    }
    await this.refresh();
  }

  /** Asks the app for a zip and checks it. */
  async import(): Promise<void> {
    const files = this.#files;
    if (!files) return;
    let zip: SkillZipFile | undefined;
    try {
      zip = await files.pickImport();
    } catch {
      zip = undefined;
    }
    if (zip) await this.importFrom(zip);
  }

  /** Checks a zip (also a dropped one); writes nothing. The result waits in `pendingImport` for the person's confirmation. */
  async importFrom(zip: SkillZipFile): Promise<void> {
    const version = ++this.#importVersion;
    this.#importBusy = true;
    this.notify();
    let analysis: ImportAnalysis;
    try {
      analysis = await this.#workshop.analyzeZip(zip.bytes, zip.name);
    } catch {
      analysis = importAnalysis(zip.name, undefined, [skillIssue(SkillIssueCode.ReadFailed, SkillSeverity.Error, zip.name)], false, 0, 0);
    }
    if (version !== this.#importVersion) return;
    this.#importBusy = false;
    this.#setImport(analysis);
  }

  #setImport(analysis: ImportAnalysis | undefined): void {
    this.#pendingImport = analysis;
    const strings = this.#strings();
    this.#importIssues = analysis ? analysis.issues.map((i) => skillIssueView(i, strings)) : [];
    this.notify();
  }

  get canCancelImport(): boolean {
    return this.#pendingImport !== undefined;
  }

  cancelImport(): void {
    if (this.#pendingImport === undefined) return;
    this.#importVersion++; // an analysis still running is stale now
    this.#importBusy = false;
    this.#setImport(undefined);
  }

  async confirmImport(): Promise<void> {
    const analysis = this.#pendingImport;
    if (!analysis?.ok || this.#importBusy) return;
    this.#importBusy = true;
    this.notify();
    // Pressing Import is the person's confirmation, also to replace a skill of the same name.
    let saved = false;
    try {
      const result = await this.#workshop.commitImport(analysis, analysis.wouldReplace);
      this.#importBusy = false;
      if (result.saved) {
        saved = true;
        this.#setImport(undefined);
        this.#message = this.#strings().skillImported(result.name ?? "");
      } else if (result.status === SkillSaveStatus.Refused) {
        this.#setImport(importAnalysis(analysis.source, analysis.document, result.issues, analysis.wouldReplace, analysis.fileCount, analysis.totalBytes));
      } else {
        this.#message = this.#strings().skillSaveFailed;
      }
    } catch {
      this.#importBusy = false;
      this.#message = this.#strings().skillSaveFailed;
    }
    this.notify();
    if (saved) await this.refresh();
  }

  /** Exports a skill as a zip and hands it to the app. */
  async export(row: SkillRowViewModel | undefined): Promise<void> {
    const files = this.#files;
    if (!row || !files) return;
    let zip: Uint8Array | undefined;
    try {
      zip = await this.#workshop.exportZip(row.name);
    } catch {
      zip = undefined;
    }
    const written = zip !== undefined && (await files.saveExport(`${row.name}.zip`, zip).catch(() => false));
    this.#message = zip === undefined ? this.#strings().skillExportFailed(row.name) : written ? this.#strings().skillExported(row.name) : "";
    this.notify();
  }
}

type SkillIssueList = NonNullable<ConstructorParameters<typeof SkillEditorViewModel>[0]["readIssues"]>;

function copyName(name: string, taken: ReadonlySet<string>): string {
  const stem = name.length > SkillLimits.nameMax - 9 ? name.slice(0, SkillLimits.nameMax - 9).replace(/-+$/, "") : name;
  let candidate = `${stem}-copy`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-copy-${n}`;
  return candidate;
}
