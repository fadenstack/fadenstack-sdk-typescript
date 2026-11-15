import { ServerProblem, TestOutcome, clearServerSecrets, type SecretPairDraft, type ServerDraft, type ServerTestInfo } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import type { UiStrings } from "../strings.js";
import type { ToolsHost } from "./contracts.js";
import { refusalText } from "./serverCards.js";

/** What is wrong with a draft, in the person's language. */
export function problemText(s: UiStrings, problem: ServerProblem): string {
  switch (problem) {
    case ServerProblem.LabelMissing: return s.toolsProblemLabelMissing;
    case ServerProblem.LabelInvalid: return s.toolsProblemLabelInvalid;
    case ServerProblem.LabelTaken: return s.toolsProblemLabelTaken;
    case ServerProblem.NameInvalid: return s.toolsProblemName;
    case ServerProblem.ValueInvalid: return s.toolsProblemValue;
    case ServerProblem.AddressMissing: return s.toolsProblemAddressMissing;
    case ServerProblem.AddressInvalid: return s.toolsProblemAddressInvalid;
    case ServerProblem.TimeoutOutOfRange: return s.toolsProblemTimeout;
    case ServerProblem.TooManyHeaders: return s.toolsProblemTooManyHeaders;
    case ServerProblem.PlainHttpWithHeaders: return s.toolsProblemPlainHttpWithHeaders;
    case ServerProblem.PlainHttpNotLocal: return s.toolsProblemPlainHttpNotLocal;
    default: return "";
  }
}

/** The line a test result shows; a refusal of plain http says why, in its own words. */
export function testLine(s: UiStrings, result: ServerTestInfo): string {
  if (result.plainHttp !== undefined) return refusalText(s, result.plainHttp);
  switch (result.outcome) {
    case TestOutcome.NotAllowed: return s.toolsTestNotAllowed;
    case TestOutcome.Started: return result.tools.length === 0 ? s.toolsTestOkNoTools : s.toolsTestOk(result.tools.join(", "));
    default: return s.toolsTestFailed(result.error?.trim() ? result.error : s.toolsReasonUnknown);
  }
}

/**
 * A header's name and value in the sheet (OWASP ASVS 5.0 V13). A saved value shows as dots and the view model never holds it: Replace
 * clears the mark and lets the person type a new one, which lives here only until the sheet is saved, tested or closed (`forget`). The
 * value is never put in a message, a log or an error.
 */
export class SecretRowViewModel extends Observable {
  readonly #strings: () => UiStrings;
  readonly #remove: (row: SecretRowViewModel) => void;
  #name: string;
  #value = "";
  #kept: boolean;

  constructor(strings: () => UiStrings, name: string, isKept: boolean, remove: (row: SecretRowViewModel) => void) {
    super();
    this.#strings = strings;
    this.#name = name;
    this.#kept = isKept;
    this.#remove = remove;
  }

  get strings(): UiStrings {
    return this.#strings();
  }

  get name(): string {
    return this.#name;
  }

  set name(value: string) {
    if (value === this.#name) return;
    this.#name = value;
    this.notify();
  }

  /** The new value while it is typed; empty when the saved one is kept. */
  get value(): string {
    return this.#value;
  }

  set value(value: string) {
    if (value === this.#value) return;
    this.#value = value;
    this.notify();
  }

  /** The value is the one saved earlier, which the page never sees. */
  get isKept(): boolean {
    return this.#kept;
  }

  get showsInput(): boolean {
    return !this.#kept;
  }

  /** The row's name for a screen reader: "Authorization: saved value (hidden)" is told apart from the other rows by the name. */
  get savedName(): string {
    return `${this.#name} · ${this.strings.toolsValueSavedName}`;
  }

  replace(): void {
    this.#kept = false;
    this.#value = "";
    this.notify();
  }

  remove(): void {
    this.forget();
    this.#remove(this);
  }

  toDraft(): SecretPairDraft {
    return { name: this.#name, value: this.#value, isKept: this.#kept };
  }

  /** Forgets the typed value. */
  forget(): void {
    if (this.#value === "") return;
    this.#value = "";
    this.notify();
  }
}

/**
 * The sheet that adds a server or edits one: its name, its address, its headers as masked rows with Replace, the longest call and
 * whether to switch it on, then Test and Add (Save when editing). Checked by the catalog's rules before it is saved. Saved values are
 * never shown again.
 *
 * How a value travels: the skin binds the row's password box to `SecretRowViewModel.value`; `save` and `test` copy the rows into a
 * `ServerDraft` and give it to the catalog, which puts a saved value back for a row that is kept; the draft's values are cleared when
 * the call returns, and the rows' values when the sheet is saved, cancelled or disposed.
 */
export class ServerSheetViewModel extends Observable {
  readonly #page: ToolsHost;
  readonly #original: string | undefined;
  #label: string;
  #enabled: boolean;
  #url: string;
  #timeoutText: string;
  #headers: SecretRowViewModel[] = [];
  #error = "";
  #test = "";
  #busy = false;
  #disposed = false;

  constructor(page: ToolsHost, original: string | undefined, draft: ServerDraft) {
    super();
    this.#page = page;
    this.#original = original;
    this.#label = draft.label;
    this.#enabled = draft.enabled;
    this.#url = draft.url;
    this.#timeoutText = String(draft.callTimeoutSeconds);
    this.#headers = draft.headers.map((p) => this.#row(p.name, p.isKept));
    clearServerSecrets(draft);
  }

  #row(name: string, isKept: boolean): SecretRowViewModel {
    return new SecretRowViewModel(() => this.strings, name, isKept, (row) => {
      this.#headers = this.#headers.filter((r) => r !== row);
      this.notify();
    });
  }

  get strings(): UiStrings {
    return this.#page.strings;
  }

  get isEditing(): boolean {
    return this.#original !== undefined;
  }

  /** The sheet adds a server (otherwise it edits one): its primary button says Add, then Save. */
  get isAdding(): boolean {
    return this.#original === undefined;
  }

  get title(): string {
    return this.#original === undefined ? this.strings.toolsSheetAddTitle : this.strings.toolsSheetEditTitle(this.#original);
  }

  get primaryText(): string {
    return this.isAdding ? this.strings.toolsAddButton : this.strings.toolsSave;
  }

  get label(): string {
    return this.#label;
  }

  set label(value: string) {
    this.#label = value;
    this.notify();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  set enabled(value: boolean) {
    this.#enabled = value;
    this.notify();
  }

  get url(): string {
    return this.#url;
  }

  set url(value: string) {
    this.#url = value;
    this.notify();
  }

  get timeoutText(): string {
    return this.#timeoutText;
  }

  set timeoutText(value: string) {
    this.#timeoutText = value;
    this.notify();
  }

  get headerRows(): readonly SecretRowViewModel[] {
    return this.#headers;
  }

  addHeader(): void {
    this.#headers = [...this.#headers, this.#row("", false)];
    this.notify();
  }

  /** Why the sheet cannot be saved; empty when nothing is wrong. */
  get errorText(): string {
    return this.#error;
  }

  get hasError(): boolean {
    return this.#error !== "";
  }

  get testText(): string {
    return this.#test;
  }

  get hasTest(): boolean {
    return this.#test !== "";
  }

  get isBusy(): boolean {
    return this.#busy;
  }

  /** The paste-import sheet instead (the link at the foot of the sheet). */
  importMore(): void {
    this.#page.importServers();
  }

  cancel(): void {
    this.#page.closeSheet();
  }

  #draft(): ServerDraft | undefined {
    const text = this.#timeoutText.trim();
    const timeout = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (Number.isNaN(timeout)) {
      this.#error = this.strings.toolsProblemTimeout;
      this.notify();
      return undefined;
    }
    const draft: ServerDraft = {
      label: this.#label.trim(),
      enabled: this.#enabled,
      url: this.#url.trim(),
      headers: this.#headers.filter((r) => r.name.trim() !== "").map((r) => r.toDraft()),
      callTimeoutSeconds: timeout,
    };
    const problem = this.#page.catalog.validate(draft, this.#original);
    this.#error = problem === ServerProblem.None ? "" : problemText(this.strings, problem);
    if (problem !== ServerProblem.None) clearServerSecrets(draft);
    this.notify();
    return problem === ServerProblem.None ? draft : undefined;
  }

  /** Saves the server and closes the sheet; the problem stays on the sheet. */
  async save(): Promise<void> {
    const draft = this.#draft();
    if (!draft) return;
    this.#busy = true;
    this.notify();
    let problem: ServerProblem;
    try {
      problem = await this.#page.catalog.save(this.#original, draft);
    } catch {
      problem = ServerProblem.AddressInvalid;
    } finally {
      clearServerSecrets(draft);
      this.#busy = false;
    }
    if (problem !== ServerProblem.None) {
      this.#error = problemText(this.strings, problem);
      this.notify();
      return;
    }
    this.#page.closeSheet(); // disposes this sheet: the typed values go
    this.#page.refresh();
  }

  /** Connects to the server for a moment and lists its tools. */
  async test(): Promise<void> {
    const draft = this.#draft();
    if (!draft) return;
    this.#busy = true;
    this.#test = this.strings.toolsTestRunning;
    this.notify();
    try {
      this.#test = testLine(this.strings, await this.#page.catalog.test(draft, this.#original));
    } catch {
      this.#test = this.strings.toolsTestFailed(this.strings.toolsReasonUnknown);
    } finally {
      clearServerSecrets(draft);
      this.#busy = false;
    }
    this.notify();
  }

  retext(): void {
    this.notify();
  }

  /** The sheet is saved, cancelled or replaced: no typed secret value stays in the rows. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const row of this.#headers) row.forget();
  }
}
