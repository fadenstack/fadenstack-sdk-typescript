import { LocalPlainHttpRefusal, LocalServerState, LocalToolClass, type LocalServerInfo } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import type { UiStrings } from "../strings.js";
import { containsText, type ToolsHost } from "./contracts.js";

/** A tool of a local server, as a mono chip on its card; a tool the server says may delete is warning-tinted. */
export interface ToolChipViewModel {
  /** The "+1" after the chips: the tools beyond the three shown (plain text, not a chip). */
  readonly isMore: boolean;
  readonly name: string;
  /** The server says the tool may delete or overwrite: the chip is warning-tinted. */
  readonly mayDelete: boolean;
  readonly tip: string;
}

/** What a card's status line says, as the dot's and the text's colour. */
export const ServerStatusKind = Object.freeze({
  /** Off, or starting: neutral. */
  Neutral: "neutral",
  /** Running. */
  Good: "good",
  /** Not allowed, refused, or the server changed its tools. */
  Warning: "warning",
  /** It cannot start. */
  Problem: "problem",
} as const);
export type ServerStatusKind = (typeof ServerStatusKind)[keyof typeof ServerStatusKind];

/** Each plain-http refusal in its own words. */
export function refusalText(s: UiStrings, refusal: LocalPlainHttpRefusal): string {
  switch (refusal) {
    case LocalPlainHttpRefusal.NoOptIn: return s.mcpPlainHttpNoOptIn;
    case LocalPlainHttpRefusal.NotLocal: return s.mcpPlainHttpNotLocal;
    case LocalPlainHttpRefusal.Secret: return s.mcpPlainHttpSecret;
    default: return s.mcpPlainHttpNotAllowed;
  }
}

/** "Added by you", "From mcpServers": where the server came from. */
export function originName(s: UiStrings, origin: string): string {
  return origin === "" || origin === "typed" ? s.toolsOriginTyped : s.toolsOriginImported(origin);
}

export function toolCountText(s: UiStrings, count: number): string {
  return count === 1 ? s.toolsCountOne : s.toolsCountMany(count);
}

const join = (...parts: string[]): string => parts.filter((p) => p !== "").join(" · ");

/**
 * One of the person's local servers as a card on the page: a plug tile, the label, where it came from and its address, the On switch,
 * a status line with its dot, up to three tool chips and "+n", and for a server that cannot start for want of a value the fix as an
 * inline action. The whole card opens the details. A server that plain http was refused for says why in its status, in its own words
 * for each reason.
 */
export class LocalServerViewModel extends Observable {
  readonly #page: ToolsHost;
  readonly label: string;
  #info!: LocalServerInfo;
  #updating = false;
  #on = false;
  #selected = false;
  #statusText = "";
  #statusTip = "";
  #statusKind: ServerStatusKind = ServerStatusKind.Neutral;
  #originText = "";
  #chips: readonly ToolChipViewModel[] = [];
  #moreText = "";
  #fixText = "";
  #refusal: LocalPlainHttpRefusal | undefined;

  constructor(page: ToolsHost, info: LocalServerInfo) {
    super();
    this.#page = page;
    this.label = info.label;
    this.update(info);
  }

  get strings(): UiStrings {
    return this.#page.strings;
  }

  /** What the app knows of the server now; the details read their facts and tools from it. */
  get info(): LocalServerInfo {
    return this.#info;
  }

  get where(): string {
    return this.#info.where;
  }

  /** "Added by you · https://notes.example.com/mcp": where it came from, then its address. */
  get originText(): string {
    return this.#originText;
  }

  /** "Running · 4 tools", "Off", "Can't start: ...", or why plain http was refused: beside the dot. */
  get statusText(): string {
    return this.#statusText;
  }

  /** The reason in full when the line is shortened (not allowed). */
  get statusTip(): string {
    return this.#statusTip;
  }

  get statusKind(): ServerStatusKind {
    return this.#statusKind;
  }

  /** Why a connection over plain http was refused; undefined when it was (the card's status says it in words). */
  get plainHttpRefusal(): LocalPlainHttpRefusal | undefined {
    return this.#refusal;
  }

  get isOn(): boolean {
    return this.#on;
  }

  /** The person moved the switch; a change from the page itself (`update`) is not sent back. */
  set isOn(value: boolean) {
    if (value === this.#on) return;
    this.#on = value;
    this.notify();
    if (!this.#updating) void this.#page.switchServer(this.label, value);
  }

  /** Its details are open: the card's border is the accent. */
  get isSelected(): boolean {
    return this.#selected;
  }

  set isSelected(value: boolean) {
    if (value === this.#selected) return;
    this.#selected = value;
    this.notify();
  }

  /** The listed tools, in all (the tab's count). */
  get toolTotal(): number {
    return this.#info.tools.length;
  }

  get chips(): readonly ToolChipViewModel[] {
    return this.#chips;
  }

  get hasChips(): boolean {
    return this.#chips.length > 0;
  }

  /** "+1": the tools beyond the three chips. */
  get moreText(): string {
    return this.#moreText;
  }

  get hasMore(): boolean {
    return this.#moreText !== "";
  }

  /** A failed card's fix, such as "Add the value"; it opens the edit sheet. */
  get fixText(): string {
    return this.#fixText;
  }

  get hasFix(): boolean {
    return this.#fixText !== "";
  }

  get switchName(): string {
    return this.strings.toolsSwitchName(this.label);
  }

  get openName(): string {
    return this.strings.toolsOpenDetails(this.label);
  }

  open(): void {
    this.#page.openDetails(this.label);
  }

  fix(): void {
    void this.#page.edit(this.label);
  }

  matches(filter: string): boolean {
    return containsText(this.label, filter) || this.#info.tools.some((t) => containsText(t.name, filter));
  }

  retext(): void {
    this.update(this.#info);
  }

  update(info: LocalServerInfo): void {
    const s = this.strings;
    this.#updating = true;
    try {
      this.#info = info;
      this.#originText = s.toolsOriginLine(originName(s, info.origin), info.where);
      this.#on = info.enabled;
      const tools = toolCountText(s, info.tools.length);
      this.#statusTip = "";
      this.#refusal = this.#refusalOf(info);
      if (this.#refusal !== undefined) {
        this.#statusText = refusalText(s, this.#refusal);
        this.#statusKind = ServerStatusKind.Warning;
      } else {
        switch (info.state) {
          case LocalServerState.Running:
            [this.#statusText, this.#statusKind] = info.toolsChanged
              ? [s.toolsStateChangedTools, ServerStatusKind.Warning] : [join(s.toolsStateRunning, tools), ServerStatusKind.Good];
            break;
          case LocalServerState.Starting:
            [this.#statusText, this.#statusKind] = [s.toolsStateStarting, ServerStatusKind.Neutral];
            break;
          case LocalServerState.Failed:
            [this.#statusText, this.#statusKind] = [
              info.missingValues.length > 0 ? s.toolsStateMissingValue(info.missingValues[0]!)
                : s.toolsStateFailed(info.detail?.trim() ? info.detail : s.toolsReasonUnknown),
              ServerStatusKind.Problem];
            break;
          case LocalServerState.NotAllowed:
            [this.#statusText, this.#statusKind] = [s.toolsStateNotAllowed, ServerStatusKind.Warning];
            this.#statusTip = s.toolsStateNotAllowedBecause(s.toolsReasonPolicy);
            break;
          default:
            [this.#statusText, this.#statusKind] = [info.tools.length > 0 ? join(s.toolsStateOff, tools) : s.toolsStateOff, ServerStatusKind.Neutral];
        }
      }
      const more = info.tools.length > 3;
      this.#moreText = more ? s.toolsMoreTools(info.tools.length - 3) : "";
      const chips: ToolChipViewModel[] = info.tools.slice(0, 3).map((t) => {
        const mayDelete = t.destructive === true || t.class === LocalToolClass.Destructive;
        return { isMore: false, name: t.name, mayDelete, tip: mayDelete ? s.toolsToolMayDelete(t.name) : t.name };
      });
      if (more) chips.push({ isMore: true, name: this.#moreText, mayDelete: false, tip: this.#moreText });
      this.#chips = chips;
      // A server that cannot start for want of a value offers the fix on its card; the person fills it in on the edit sheet.
      this.#fixText = info.state === LocalServerState.Failed && info.missingValues.length > 0 && this.#refusal === undefined ? s.toolsFixAddValue : "";
    } finally {
      this.#updating = false;
    }
    this.notify();
  }

  // The module's own reason, else (the switch is on, but this agent or computer does not allow plain http, and the module has not
  // tried yet) "not allowed": a server already on says so in its status.
  #refusalOf(info: LocalServerInfo): LocalPlainHttpRefusal | undefined {
    if (info.state === LocalServerState.Off) return undefined;
    if (info.plainHttpRefusal !== undefined) return info.plainHttpRefusal;
    return info.plainHttpApplies && info.plainHttpInLan && !this.#page.plainHttpPermitted && info.state !== LocalServerState.Running
      ? LocalPlainHttpRefusal.NotAllowed : undefined;
  }
}
