import { LocalServerState, LocalToolClass, LocalToolRaise, ServerProblem, type LocalToolInfo } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import { PLAIN_HTTP_WARNING_VERSION, type UiStrings } from "../strings.js";
import { containsText, type ToolsHost } from "./contracts.js";
import type { LocalServerViewModel } from "./serverCards.js";
import { problemText, testLine } from "./serverSheet.js";

/** One choice of a tool's raise picker: none, read or write. */
export interface RaiseOptionViewModel {
  readonly raise: LocalToolRaise;
  readonly text: string;
}

/**
 * A tool of a local server in the details: its name, what the server says it does, the server's own hints as outlined badges, the
 * class it has now, and the person's raise. A raise picker (as it arrives, reads only, changes things) is offered for every tool but
 * one the server says is destructive: that one shows "Destructive" fixed, because a destructive hint is a floor.
 */
export class LocalToolViewModel extends Observable {
  readonly #details: ServerDetailsViewModel;
  readonly name: string;
  #tool!: LocalToolInfo;
  #updating = false;

  constructor(details: ServerDetailsViewModel, tool: LocalToolInfo) {
    super();
    this.#details = details;
    this.name = tool.name;
    this.update(tool);
  }

  get description(): string {
    return this.#tool.description;
  }

  get hasDescription(): boolean {
    return this.#tool.description !== "";
  }

  /** "Says: reads only": the server's own word about the tool, labelled as such, each as its own badge. */
  get hints(): readonly string[] {
    const s = this.#details.strings;
    const t = this.#tool;
    return [
      ...(t.readOnly === true ? [s.toolsSaysReadOnly] : []),
      ...(t.destructive === true ? [s.toolsSaysDestructive] : []),
      ...(t.idempotent === true ? [s.toolsSaysIdempotent] : []),
      ...(t.openWorld === true ? [s.toolsSaysOpenWorld] : []),
    ];
  }

  get hasHints(): boolean {
    return this.hints.length > 0;
  }

  get class(): LocalToolClass {
    return this.#tool.class;
  }

  /** The server says the tool may delete or overwrite: no picker, "Destructive" fixed. */
  get isDestructive(): boolean {
    return this.#tool.destructive === true || this.#tool.class === LocalToolClass.Destructive;
  }

  /** The class it has now: "Asks every time", "Reads", "Changes things" or "Destructive". */
  get classText(): string {
    const s = this.#details.strings;
    switch (this.#tool.class) {
      case LocalToolClass.Read: return s.toolsClassRead;
      case LocalToolClass.Write: return s.toolsClassWrite;
      case LocalToolClass.Destructive: return s.toolsClassDestructive;
      default: return this.isDestructive ? s.toolsClassDestructive : s.toolsClassUnknown;
    }
  }

  /** "The server says this tool may delete or overwrite. It always asks, and nothing can lower that." */
  get destructiveHelp(): string {
    return this.isDestructive ? this.#details.strings.toolsDestructiveHelp : "";
  }

  /** The person can raise it (and can change marks at all: standalone); never below a destructive hint. */
  get canRaise(): boolean {
    return !this.isDestructive && this.#details.canChangeMarks;
  }

  /** As it arrives, reads only, changes things; empty for a destructive tool. */
  get raiseOptions(): readonly RaiseOptionViewModel[] {
    const s = this.#details.strings;
    return this.isDestructive ? [] : [
      { raise: LocalToolRaise.None, text: s.toolsRaiseNone },
      { raise: LocalToolRaise.Read, text: s.toolsRaiseRead },
      { raise: LocalToolRaise.Write, text: s.toolsRaiseWrite },
    ];
  }

  /** The picker's choice; choosing one tells the catalog. */
  get selectedRaise(): LocalToolRaise {
    return this.#tool.raise;
  }

  set selectedRaise(value: LocalToolRaise) {
    if (value === this.#tool.raise || this.#updating) return;
    if (!this.canRaise) return;
    this.#tool = { ...this.#tool, raise: value };
    this.notify();
    this.#details.setRaise(this.name, value);
  }

  /** "Class of echo": the picker's name for a screen reader, so the pickers of two rows are told apart. */
  get raiseName(): string {
    return this.#details.strings.toolsRaiseName(this.name);
  }

  update(tool: LocalToolInfo): void {
    this.#updating = true;
    this.#tool = tool;
    this.#updating = false;
    this.notify();
  }

  matches(filter: string): boolean {
    return containsText(this.name, filter) || containsText(this.#tool.description, filter);
  }
}

/** One row of the details' facts: a label and what it says, in mono for an address. */
export interface FactRowViewModel {
  readonly label: string;
  readonly value: string;
  readonly isMono: boolean;
  readonly isMuted: boolean;
}

/** "90 seconds", "2 minutes". */
export function durationText(s: UiStrings, seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? s.toolsMinutesOne : s.toolsMinutesMany(minutes);
  }
  return seconds === 1 ? s.toolsSecondsOne : s.toolsSecondsMany(seconds);
}

/**
 * The details of a local server: its header with the status and the switch, the facts (added, its address, its header names, the
 * longest call), the "Trusted" switch, the note that its tools are its own words, its tools with a filter, the server's hints, their
 * class and the raise picker, "Advanced" with the plain-http switch where it applies, and at the foot Test, Restart, Edit and Remove,
 * which asks first. Values of headers are never here.
 *
 * The plain-http switch follows the owner's rules: it is hidden where plain http is not permitted or does not apply; turning it on
 * first shows the warning and changes nothing until the person confirms (`confirmPlainHttp`), and the confirmation carries the
 * warning's version (`PLAIN_HTTP_WARNING_VERSION`); cancelling leaves it off; turning it off needs no warning.
 */
export class ServerDetailsViewModel extends Observable {
  readonly #page: ToolsHost;
  readonly label: string;
  #server: LocalServerViewModel;
  readonly #rows = new Map<string, LocalToolViewModel>();
  #all: readonly LocalToolViewModel[] = [];
  #tools: readonly LocalToolViewModel[] = [];
  #facts: readonly FactRowViewModel[] = [];
  #toolFilter = "";
  #statusText = "";
  #canChangeMarks = false;
  #trusted = false;
  #showsAdvanced = false;
  #plainHttpOn = false;
  #warningOpen = false;
  #plainHttpError = "";
  #testText = "";
  #busy = false;
  #confirmingRemove = false;

  constructor(page: ToolsHost, server: LocalServerViewModel) {
    super();
    this.#page = page;
    this.#server = server;
    this.label = server.label;
    this.refresh(server);
  }

  get strings(): UiStrings {
    return this.#page.strings;
  }

  /** The card, whose switch and status the details share. */
  get server(): LocalServerViewModel {
    return this.#server;
  }

  get drawerName(): string {
    return this.strings.toolsDrawerName(this.label);
  }

  /** "Running since 17:03", else the card's status line. */
  get statusText(): string {
    return this.#statusText;
  }

  get facts(): readonly FactRowViewModel[] {
    return this.#facts;
  }

  get tools(): readonly LocalToolViewModel[] {
    return this.#tools;
  }

  /** "Tools · 4". */
  get toolsTitle(): string {
    return this.strings.toolsListHeading(this.#all.length);
  }

  get toolFilter(): string {
    return this.#toolFilter;
  }

  set toolFilter(value: string) {
    this.#toolFilter = value;
    this.#applyFilter();
    this.notify();
  }

  /** The server lists no tools (or none matches the filter). */
  get noToolsText(): string {
    const s = this.strings;
    return this.#all.length === 0 ? s.toolsNoTools : this.#tools.length === 0 ? s.toolsNoToolsMatch : "";
  }

  get hasNoToolsText(): boolean {
    return this.noToolsText !== "";
  }

  get testText(): string {
    return this.#testText;
  }

  get hasTest(): boolean {
    return this.#testText !== "";
  }

  get isBusy(): boolean {
    return this.#busy;
  }

  get isConfirmingRemove(): boolean {
    return this.#confirmingRemove;
  }

  get removeConfirmText(): string {
    return this.strings.toolsRemoveConfirm(this.label);
  }

  get removeName(): string {
    return this.strings.toolsRemoveName(this.label);
  }

  get canRestart(): boolean {
    return this.#server.isOn && !this.#busy;
  }

  // ---- trust ---------------------------------------------------------------------------------------------------------

  /** The person can change the trust mark and the raises (standalone); false: an administrator's marks count and are shown as they are. */
  get canChangeMarks(): boolean {
    return this.#canChangeMarks;
  }

  /** The server's read-only hints count; a server's own word is never enough. Setting it tells the catalog. */
  get isTrusted(): boolean {
    return this.#trusted;
  }

  set isTrusted(value: boolean) {
    if (value === this.#trusted || !this.#canChangeMarks) return;
    this.#trusted = value;
    this.notify();
    void this.#page.run(this.#page.catalog.setTrusted(this.label, value).then(() => this.#page.refresh()));
  }

  /** "Only a trusted server's “reads only” hints count..." or "Marked by your administrator". */
  get trustedNote(): string {
    return this.#canChangeMarks ? this.strings.toolsTrustedHelp : this.strings.toolsTrustedByAdmin;
  }

  get trustedName(): string {
    return this.strings.toolsTrustedName(this.label);
  }

  // ---- Advanced: plain http on the local network -----------------------------------------------------------------------

  /** The switch applies to this server (plain http beyond this computer) and is permitted here; otherwise the whole Advanced part is hidden. */
  get showsAdvanced(): boolean {
    return this.#showsAdvanced;
  }

  /**
   * "Allow plain http on the local network" as it stands. Turning it on does not change it: it opens the warning, and the switch stays
   * off until `confirmPlainHttp`. Turning it off changes it at once, with no warning.
   */
  get plainHttpOn(): boolean {
    return this.#plainHttpOn;
  }

  set plainHttpOn(value: boolean) {
    if (value === this.#plainHttpOn) return;
    if (value) {
      this.#warningOpen = true;
      this.notify(); // the switch the person pressed goes back to off until they confirm
    } else {
      void this.#turnOff();
    }
  }

  /** The warning is shown, and the person has not answered it. */
  get isPlainHttpWarningOpen(): boolean {
    return this.#warningOpen;
  }

  /** The warning (`mcpPlainHttpWarning`) while it is open; empty otherwise. */
  get plainHttpWarningText(): string {
    return this.#warningOpen ? this.strings.mcpPlainHttpWarning : "";
  }

  /** Why the switch could not be changed; empty when nothing is wrong. */
  get plainHttpError(): string {
    return this.#plainHttpError;
  }

  get hasPlainHttpError(): boolean {
    return this.#plainHttpError !== "";
  }

  /** Turns the switch on; the person has read the warning and confirmed. Passes the warning's version. */
  async confirmPlainHttp(): Promise<void> {
    if (!this.#warningOpen) return;
    this.#warningOpen = false;
    this.notify();
    await this.#setSwitch(true, PLAIN_HTTP_WARNING_VERSION);
  }

  /** The person did not confirm: the switch stays off, and nothing was changed. */
  cancelPlainHttp(): void {
    if (!this.#warningOpen) return;
    this.#warningOpen = false;
    this.notify();
  }

  async #turnOff(): Promise<void> {
    await this.#setSwitch(false, undefined);
  }

  async #setSwitch(on: boolean, version: string | undefined): Promise<void> {
    let problem: ServerProblem | undefined;
    try {
      problem = await this.#page.catalog.setPlainHttpInLan(this.label, on, version);
    } catch {
      problem = undefined; // nothing changed: the switch shows how it stands after the page reads the catalog again
    }
    this.#plainHttpError = problem === undefined || problem === ServerProblem.None ? "" : problemText(this.strings, problem);
    this.notify();
    this.#page.refresh();
  }

  // ---- the footer ----------------------------------------------------------------------------------------------------

  close(): void {
    this.#page.closeDetails();
  }

  edit(): void {
    void this.#page.edit(this.label);
  }

  askRemove(): void {
    this.#confirmingRemove = true;
    this.notify();
  }

  keep(): void {
    this.#confirmingRemove = false;
    this.notify();
  }

  async confirmRemove(): Promise<void> {
    await this.#page.run(this.#page.catalog.remove(this.label));
    this.#page.closeDetails();
    this.#page.refresh();
  }

  async test(): Promise<void> {
    const draft = await this.#page.catalog.getDraft(this.label);
    if (!draft) return;
    this.#busy = true;
    this.#testText = this.strings.toolsTestRunning;
    this.notify();
    try {
      this.#testText = testLine(this.strings, await this.#page.catalog.test(draft, this.label));
    } catch {
      this.#testText = this.strings.toolsTestFailed(this.strings.toolsReasonUnknown);
    } finally {
      this.#busy = false;
    }
    this.notify();
  }

  async restart(): Promise<void> {
    this.#busy = true;
    this.notify();
    try {
      await this.#page.catalog.restart(this.label);
      this.#testText = this.strings.toolsRestartedLine;
    } catch {
      this.#testText = this.strings.toolsTestFailed(this.strings.toolsReasonUnknown);
    } finally {
      this.#busy = false;
    }
    this.notify();
    this.#page.refresh();
  }

  setRaise(tool: string, raise: LocalToolRaise): void {
    void this.#page.run(this.#page.catalog.setToolClass(this.label, tool, raise).then(() => this.#page.refresh()));
  }

  retext(): void {
    this.refresh(this.#server);
  }

  /** Reads the card's server again (the catalog reported a change). */
  refresh(server: LocalServerViewModel): void {
    const s = this.strings;
    this.#server = server;
    const info = server.info;
    this.#statusText = info.state === LocalServerState.Running && !info.toolsChanged && info.runningSince
      ? s.toolsRunningSince(info.runningSince.toLocaleTimeString(s.language, { hour: "numeric", minute: "2-digit" }))
      : server.statusText;
    this.#canChangeMarks = this.#page.catalog.marksAreYours;
    this.#trusted = info.trusted;
    this.#showsAdvanced = info.plainHttpApplies && this.#page.plainHttpPermitted;
    this.#plainHttpOn = info.plainHttpInLan;
    if (!this.#showsAdvanced) this.#warningOpen = false;

    this.#facts = [
      { label: s.toolsFactAdded, value: info.origin === "" || info.origin === "typed" ? s.toolsAddedByYou : s.toolsAddedFrom(info.origin), isMono: false, isMuted: false },
      { label: s.toolsFactAddress, value: info.where, isMono: true, isMuted: false },
      info.secretNames.length === 0
        ? { label: s.toolsFactSecrets, value: s.toolsNoneText, isMono: false, isMuted: true }
        : { label: s.toolsFactSecrets, value: info.secretNames.join(", "), isMono: true, isMuted: false },
      { label: s.toolsFactLongestCall, value: durationText(s, info.callTimeoutSeconds), isMono: false, isMuted: false },
    ];

    // A tool that stays keeps its row (and its picker); the rows follow the server's own order.
    const listed: LocalToolViewModel[] = [];
    for (const tool of info.tools) {
      let row = this.#rows.get(tool.name);
      if (row) row.update(tool);
      else {
        row = new LocalToolViewModel(this, tool);
        this.#rows.set(tool.name, row);
      }
      listed.push(row);
    }
    for (const gone of [...this.#rows.keys()]) if (!info.tools.some((t) => t.name === gone)) this.#rows.delete(gone);
    this.#all = listed;
    this.#applyFilter();
    this.notify();
  }

  #applyFilter(): void {
    this.#tools = this.#all.filter((t) => t.matches(this.#toolFilter));
  }
}
