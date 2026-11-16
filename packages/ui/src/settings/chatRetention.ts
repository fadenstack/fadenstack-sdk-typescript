import {
  CHAT_RETENTION_LIMITS, chatRetentionChoice, chatRetentionChoiceOf, isValidRetentionChats, isValidRetentionDays,
  type ChatRetentionChoice, type ChatRetentionControl, type ChatRetentionState, type FadenstackAgent,
} from "@fadenstack/agents";

import { Observable } from "../observable.js";
import { englishStrings, type UiStrings } from "../strings.js";
import type { StringsSource } from "../skills/contracts.js";

/** Where the setting for old chats reads and writes its state: an agent (`new ChatRetentionSettingsViewModel({ agent })`), or a test's. .NET: `IChatRetentionSource`. */
export interface ChatRetentionSource {
  /** How long old chats are kept, and who decides, as far as is known now. */
  readonly state: ChatRetentionState;
  /** Gets ready to know the state (an agent starts, which reads the server's limits and the person's choice). */
  start(): Promise<void>;
  /** Keeps the person's choice; returns the state in force (unchanged where the person may not choose). */
  set(choice: ChatRetentionChoice): Promise<ChatRetentionState>;
}

export interface ChatRetentionSettingsOptions {
  /** The agent whose chats it is. Give this or `source`. */
  agent?: FadenstackAgent;
  /** Where the state comes from and goes to (a test's). */
  source?: ChatRetentionSource;
  /** The texts; English by default. */
  strings?: StringsSource;
}

/**
 * The setting for old chats, for an app's settings page: whether chats are deleted automatically, and after how many days and beyond
 * how many chats. In a standalone agent the person chooses and presses Save; the choice is kept per person on the device
 * (`FadenstackAgent.setChatRetention`) and applied at once. It is read only, with a sentence that says why, where the organisation
 * decides (a governed agent: "Your organisation keeps at most N chats for D days on this device") or where the machine policy on this
 * computer fixes it. A skin binds to this class and holds no logic: the texts come from `strings` (say them again on `retext()`), the
 * checks and the state of the buttons are here. .NET: `ChatRetentionSettingsViewModel`.
 */
export class ChatRetentionSettingsViewModel extends Observable {
  readonly #source: ChatRetentionSource;
  readonly #strings: StringsSource;
  #state: ChatRetentionState;
  #autoDelete: boolean;
  #days = "";
  #chats = "";
  #saved = false;
  #saving = false;

  constructor(options: ChatRetentionSettingsOptions) {
    super();
    const { agent, source } = options;
    if (!agent && !source) throw new TypeError("Give an agent or a source.");
    this.#source = source ?? agentSource(agent!);
    this.#strings = options.strings ?? (() => englishStrings);
    this.#state = this.#source.state;
    this.#autoDelete = this.#state.autoDelete;
    this.#reset();
  }

  /** The texts the view model was given. */
  get strings(): UiStrings {
    return this.#strings();
  }

  /** Reads the agent's state again (starting the agent first, which fetches the server's limits and the person's choice). */
  async load(): Promise<void> {
    await this.#source.start();
    this.#state = this.#source.state;
    this.#saved = false;
    this.#reset();
    this.notify();
  }

  /** Who decides: the person, the organisation's server, or the machine policy. */
  get control(): ChatRetentionControl {
    return this.#state.control;
  }

  /** The person may change it (standalone, and the machine policy leaves it to them). */
  get canEdit(): boolean {
    return this.#state.canChange;
  }

  /** It is shown and cannot be changed. */
  get isReadOnly(): boolean {
    return !this.#state.canChange;
  }

  /** The switch and the two limits show: not in governed mode, where one sentence says what the organisation keeps. */
  get showControls(): boolean {
    return this.#state.control !== "organisation";
  }

  /** The sentence about who decides shows (governed, or fixed by the machine policy). */
  get showNote(): boolean {
    return this.#state.control !== "person";
  }

  /** "Your organisation keeps at most N chats for D days on this device.", "Your organisation sets no limit." or "Set by your organisation's policy on this computer." */
  get note(): string {
    const s = this.strings;
    switch (this.#state.control) {
      case "organisation": return this.#state.organisationSetsLimit ? s.chatRetentionOrganisationLimit(this.#state.maxSessions, this.#state.maxAgeDays) : s.chatRetentionOrganisationNoLimit;
      case "machinePolicy": return s.chatRetentionPolicyFixed;
      default: return "";
    }
  }

  /** Delete old chats automatically. Off keeps every chat until the person deletes it. */
  get autoDelete(): boolean {
    return this.#autoDelete;
  }

  set autoDelete(value: boolean) {
    if (!this.canEdit || this.#autoDelete === value) return;
    this.#autoDelete = value;
    this.#changed();
  }

  /** The limits can be typed: automatic deletion is on, and the person may change it. */
  get limitsEnabled(): boolean {
    return this.canEdit && this.#autoDelete;
  }

  /** The days after which a chat goes, as typed. */
  get maxAgeDaysText(): string {
    return this.#days;
  }

  set maxAgeDaysText(value: string) {
    if (!this.canEdit || this.#days === value) return;
    this.#days = value;
    this.#changed();
  }

  /** The most chats kept, as typed. */
  get maxSessionsText(): string {
    return this.#chats;
  }

  set maxSessionsText(value: string) {
    if (!this.canEdit || this.#chats === value) return;
    this.#chats = value;
    this.#changed();
  }

  /** Why the days are not valid; empty when they are (or when automatic deletion is off). */
  get daysError(): string {
    return this.limitsEnabled && parse(this.#days, isValidRetentionDays) === undefined
      ? this.strings.chatRetentionDaysError(CHAT_RETENTION_LIMITS.minDays, CHAT_RETENTION_LIMITS.maxDays) : "";
  }

  get hasDaysError(): boolean {
    return this.daysError.length > 0;
  }

  /** Why the chats are not valid; empty when they are (or when automatic deletion is off). */
  get chatsError(): string {
    return this.limitsEnabled && parse(this.#chats, isValidRetentionChats) === undefined
      ? this.strings.chatRetentionChatsError(CHAT_RETENTION_LIMITS.minChats, CHAT_RETENTION_LIMITS.maxChats) : "";
  }

  get hasChatsError(): boolean {
    return this.chatsError.length > 0;
  }

  /** What is typed can be saved: whole numbers within the bounds (not checked while automatic deletion is off). */
  get isValid(): boolean {
    return !this.hasDaysError && !this.hasChatsError;
  }

  /** The form differs from what is kept. */
  get isDirty(): boolean {
    return this.canEdit && (this.#autoDelete !== this.#state.autoDelete
      || (this.#autoDelete && (this.#days.trim() !== String(this.#state.maxAgeDays) || this.#chats.trim() !== String(this.#state.maxSessions))));
  }

  get canSave(): boolean {
    return this.isDirty && this.isValid && !this.#saving;
  }

  /** Cancel is possible when there is something to put back. */
  get canCancel(): boolean {
    return this.isDirty;
  }

  /** "Saved." after a save, until the person changes something. */
  get statusText(): string {
    return this.#saved ? this.strings.chatRetentionSaved : "";
  }

  /** Keeps what is typed (Save). Does nothing when it cannot be saved. */
  async save(): Promise<void> {
    if (!this.canSave) return;
    const days = parse(this.#days, isValidRetentionDays);
    const chats = parse(this.#chats, isValidRetentionChats);
    // Off keeps the limits it had, for later.
    const choice = this.#autoDelete && days !== undefined && chats !== undefined
      ? chatRetentionChoice({ autoDelete: true, maxAgeDays: days, maxSessions: chats })
      : chatRetentionChoice({ autoDelete: false, maxAgeDays: chatRetentionChoiceOf(this.#state).maxAgeDays, maxSessions: chatRetentionChoiceOf(this.#state).maxSessions });
    this.#saving = true;
    this.notify();
    try {
      this.#state = await this.#source.set(choice);
      this.#reset();
      this.#saved = true;
    } finally {
      this.#saving = false;
      this.notify();
    }
  }

  /** Cancel: the form shows what is kept again. */
  cancel(): void {
    this.#saved = false;
    this.#reset();
    this.notify();
  }

  /** The app's language changed: every text is said again. */
  retext(): void {
    this.notify();
  }

  #reset(): void {
    this.#autoDelete = this.#state.autoDelete;
    this.#days = String(this.#state.maxAgeDays);
    this.#chats = String(this.#state.maxSessions);
  }

  #changed(): void {
    this.#saved = false;
    this.notify();
  }
}

/** A whole number written with digits only, within its bounds; undefined otherwise. */
function parse(text: string, valid: (n: unknown) => n is number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return undefined;
  const number = Number(trimmed);
  return valid(number) ? number : undefined;
}

function agentSource(agent: FadenstackAgent): ChatRetentionSource {
  return {
    get state() {
      return agent.chatRetention;
    },
    start: () => agent.start(),
    set: (choice) => agent.setChatRetention(choice),
  };
}
