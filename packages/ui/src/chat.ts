import type { AgentEvent, AgentSession, FadenstackAgent, MessageAttachment, TranscriptEntry } from "@fadenstack/agents";
import { FadenstackSignInRequiredError, TOOL_MODES, narrowestMode, type SkillOption, type ToolMode } from "@fadenstack/client";

import type { ApprovalBroker, PendingApproval } from "./approvalBroker.js";
import { AttachmentViewModel, type AttachmentChip } from "./attachments.js";
import { RenderBatcher } from "./batcher.js";
import { formatWhen } from "./format.js";
import { markdownToHtml } from "./markdown/serialize.js";
import { Observable } from "./observable.js";
import { NoticePart, type PartContext } from "./parts.js";
import { citationsRenderer, fallbackRenderer, piiRenderer, type AgentEventRenderer } from "./renderers.js";
import { browserClipboard, timeoutScheduler, writeClipboard, type Clipboard, type UiScheduler } from "./services.js";
import { builtInStrings, stringsFor } from "./languages/index.js";
import { browserPreferences, type PreferenceStore } from "./preferences.js";
import { SkillPickerViewModel, skillToken } from "./skills.js";
import { withStrings, type UiStrings } from "./strings.js";
import { buildTurn, groupTurns } from "./transcriptTurns.js";
import { TurnViewModel, type TurnHost } from "./turn.js";

/** How a chat view model behaves; the defaults suit a chat panel. */
export interface AgentChatOptions {
  /**
   * How often streamed updates reach the view models (default 33 ms, about 30 a second). Tokens in between are
   * merged, so a fast model costs one update per frame.
   */
  renderIntervalMs?: number;
  /** Turns shown when a session is opened (default 30); older ones load on request. */
  initialTurns?: number;
  /** Turns added by "Show earlier" (default 30). */
  pageSize?: number;
  /** Characters of a tool result or argument shown (default 4 000). */
  previewLength?: number;
  clipboard?: Clipboard;
  scheduler?: UiScheduler;
  /** Renderers for gateway events, tried before the built-in ones. */
  renderers?: AgentEventRenderer[];
  /**
   * The languages the user can pick in the panel's settings, by BCP 47 tag: `builtInStrings` by default. Add one, or
   * change a language's words: `{ ...builtInStrings, it: italianStrings, de: withStrings({ allow: "Einmal zulassen" }, germanStrings) }`.
   */
  languages?: Readonly<Record<string, UiStrings>>;
  /**
   * What "Automatic" means: the host's language, best first (Office's, the Nextcloud user's); the browser's
   * languages by default. The panel starts in it until the user picks another.
   */
  automaticLanguage?: string | readonly string[];
  /** A language the organisation fixed (a policy): the panel uses it, and its settings show it without a choice. */
  lockedLanguage?: string;
  /** Where the user's pick is kept: the browser's localStorage by default (`browserPreferences()`), memory where there is none. */
  preferences?: PreferenceStore;
  /**
   * Texts fixed by the host instead of a language the user picks: the panel then offers no choice. What a partial
   * set leaves out is English. Most hosts leave it out and pass `automaticLanguage`.
   */
  strings?: Partial<UiStrings>;
  /** For dates and numbers; the browser's by default. */
  locale?: string;
  now?: () => Date;
  /**
   * Runs before every message goes -- from the composer, a suggestion, Retry, or Edit and resend -- for what the
   * host does first: check it may still send, take the context its tools read, add attachments (they go with this
   * message). The chat is busy meanwhile and Stop aborts `signal`. When it throws, nothing is sent: the text stays
   * in the composer and `error` says why.
   */
  beforeSend?: (message: OutgoingMessage, signal: AbortSignal) => void | Promise<void>;
  /** Runs once after every send, however it ended: its turn finished, failed or was stopped, or `beforeSend` threw. */
  afterSend?: (message: OutgoingMessage) => void;
}

/** A message on its way, for `beforeSend` and `afterSend`. */
export interface OutgoingMessage {
  /** What the user sent, trimmed. */
  readonly text: string;
}

/** A picture for the next message (`attachPicture`): pasted, dropped, or taken by the host (a screenshot). */
export interface PictureInput {
  /** The picture as a `data:image/...` URL, already as small as it should go (`@fadenstack/ui-web` `readPicture`). */
  dataUrl: string;
  /** Its name on the chip; "Pasted picture" by default. */
  title?: string;
  /** Where it comes from, for the model (`screenshot`, `file`); `picture` by default. */
  kind?: string;
}

/** A language in the panel's settings: `"auto"` (the host's) or a tag, named in itself ("Deutsch"). */
export interface LanguageOption {
  id: string;
  label: string;
  /** The language the label is written in, for the item's `lang`. */
  lang: string;
  selected: boolean;
}

/** The settings' pick that follows the host's language. */
export const AUTOMATIC_LANGUAGE = "auto";
const LANGUAGE_PREFERENCE = "language";
const primaryTag = (tag: string): string => tag.split("-")[0]!.toLowerCase();

/** A mode in the picker, with what it means; above the ceiling it cannot be picked. */
export interface ToolModeOption {
  mode: ToolMode;
  label: string;
  description: string;
  available: boolean;
}

/** A session in the history list. */
export interface SessionItem {
  id: string;
  title: string;
  lastActivity: Date;
  whenText: string;
  isCurrent: boolean;
}

/**
 * A chat with one agent, for any skin: the conversation as turns, the composer, the tool-mode picker, the session
 * history. The agent's events reach the view models in batches, one per `renderIntervalMs`, however fast it
 * streams. Opened sessions show their latest turns and load older ones on request, so long sessions open fast and
 * stay light. .NET: `Fadenstack.UI.ViewModels.AgentChatViewModel`.
 */
export class AgentChatViewModel extends Observable implements TurnHost {
  /** The skills list the composer opens on `$` (or `/` at the start); skins draw it while it is open. */
  readonly skillPicker: SkillPickerViewModel;
  readonly #agent: FadenstackAgent;
  readonly #approvals: ApprovalBroker;
  readonly #batcher: RenderBatcher;
  readonly #renderers: AgentEventRenderer[];
  readonly #context: PartContext;
  readonly #initialTurns: number;
  readonly #pageSize: number;
  readonly #unsubscribe: () => void;
  readonly #focusListeners = new Set<() => void>();
  readonly #beforeSend: AgentChatOptions["beforeSend"];
  readonly #afterSend: AgentChatOptions["afterSend"];
  // Approvals arrive twice: as an event, in order with the turn's other events, and as the broker's request,
  // which carries the answer. Whichever comes second adds the card, so it sits where the event put it.
  readonly #waitingForEvent = new Map<string, PendingApproval>();
  readonly #eventsWithoutRequest = new Set<string>();
  #session: AgentSession | undefined;
  #stop: AbortController | undefined;
  #current: TurnViewModel | undefined;
  #history: TranscriptEntry[][] = [];
  #loadedFrom = 0;
  #title = "";
  #profileGreeting: string | undefined;
  readonly #languages: Readonly<Record<string, UiStrings>>;
  readonly #automatic: string | readonly string[] | undefined;
  readonly #locked: string | undefined;
  readonly #fixed: UiStrings | undefined;
  readonly #preferences: PreferenceStore;
  #language = AUTOMATIC_LANGUAGE;
  #languageLoaded = false;
  #languagePicked = false;
  #settingsOpen = false;
  readonly #untitled = new Set<string>();
  #suggestions: readonly string[] = [];
  #turns: readonly TurnViewModel[] = [];
  #attachments: readonly AttachmentViewModel[] = [];
  #skills: readonly SkillOption[] = [];
  #sessions: readonly SessionItem[] = [];
  #input = "";
  #ready = false;
  #busy = false;
  #historyOpen = false;
  #modeMenuOpen = false;
  #signInRequired = false;
  #error: string | undefined;
  #mode: ToolMode = "ask";

  constructor(agent: FadenstackAgent, approvals: ApprovalBroker, options: AgentChatOptions = {}) {
    super();
    this.#agent = agent;
    this.#approvals = approvals;
    this.#languages = options.languages ?? builtInStrings;
    this.#automatic = options.automaticLanguage;
    this.#fixed = options.strings ? withStrings(options.strings) : undefined;
    this.#locked = options.lockedLanguage === undefined ? undefined : this.#keyOf(stringsFor(options.lockedLanguage, this.#languages));
    this.#preferences = options.preferences ?? browserPreferences();
    this.#batcher = new RenderBatcher(options.scheduler ?? timeoutScheduler, options.renderIntervalMs ?? 33);
    this.#renderers = [...(options.renderers ?? []), citationsRenderer, piiRenderer, fallbackRenderer];
    this.#initialTurns = options.initialTurns ?? 30;
    this.#pageSize = options.pageSize ?? 30;
    this.#context = {
      strings: this.#resolve(),
      clipboard: options.clipboard ?? browserClipboard,
      locale: options.locale,
      previewLength: options.previewLength ?? 4000,
      now: options.now ?? (() => new Date()),
    };
    this.#beforeSend = options.beforeSend;
    this.#afterSend = options.afterSend;
    this.skillPicker = new SkillPickerViewModel({
      load: (signal) => agent.listSkills(undefined, signal),
      onPick: (skill) => this.#pickSkill(skill),
    });
    this.#unsubscribe = approvals.onRequested((pending) => this.#onApprovalRequested(pending));
    // A store that answers at once (localStorage) gives the user's language from the first paint.
    try {
      const saved = this.#preferences.get(LANGUAGE_PREFERENCE);
      if (!(saved instanceof Promise)) this.#adopt(saved);
    } catch {
      // the store failed: the automatic language
    }
  }

  // -- state ----------------------------------------------------------------------------------------

  get agent(): FadenstackAgent {
    return this.#agent;
  }

  get title(): string {
    return this.#title;
  }

  /** The chat's texts, in the language the user picked (or the host's): skins take every label from them. */
  get strings(): UiStrings {
    return this.#context.strings;
  }

  /** The agent's greeting for an empty chat (profile `ui.greeting`). */
  get greeting(): string {
    return this.#profileGreeting ?? (this.#title ? this.strings.greetingFallback(this.#title) : "");
  }

  /** The settings' language: `"auto"` (the host's language) or a tag of `languageOptions`. */
  get language(): string {
    return this.#locked ?? this.#language;
  }

  /** The languages to pick from, "Automatic" first; none when the host fixed the texts. */
  get languageOptions(): readonly LanguageOption[] {
    if (this.#fixed) return [];
    const current = this.strings;
    const chosen = this.language;
    return [
      { id: AUTOMATIC_LANGUAGE, label: current.languageAutomatic(stringsFor(this.#automatic, this.#languages).languageName),
        lang: current.language, selected: chosen === AUTOMATIC_LANGUAGE },
      ...Object.entries(this.#languages).map(([id, strings]) => ({ id, label: strings.languageName, lang: strings.language, selected: chosen === id })),
    ];
  }

  /** The user can pick a language: the host did not fix the texts, nor the organisation the language. */
  get canChangeLanguage(): boolean {
    return !this.#fixed && this.#locked === undefined && Object.keys(this.#languages).length > 1;
  }

  /** The organisation fixed the language: the settings show it without a choice. */
  get isLanguageLocked(): boolean {
    return !this.#fixed && this.#locked !== undefined;
  }

  get isSettingsOpen(): boolean {
    return this.#settingsOpen;
  }

  /** Prompts to start with (profile `ui.suggestions`). */
  get suggestions(): readonly string[] {
    return this.#suggestions;
  }

  get turns(): readonly TurnViewModel[] {
    return this.#turns;
  }

  /** Context that goes with the next message (chips in the composer). */
  get attachments(): readonly AttachmentViewModel[] {
    return this.#attachments;
  }

  /** The skills picked for the next message (chips in the composer). */
  get pickedSkills(): readonly SkillOption[] {
    return this.#skills;
  }

  /** The server offers skills: typing `$` in the composer lists them. */
  get canPickSkills(): boolean {
    return this.#agent.isStarted && this.#agent.profile.skills;
  }

  /** The agent's model sees pictures: a picture can go with a message (`attachPicture`). */
  get canAttachPictures(): boolean {
    return this.#agent.isStarted && this.#agent.profile.vision === true;
  }

  get isEmpty(): boolean {
    return this.#turns.length === 0;
  }

  /** Older turns of an opened session that are not shown yet. */
  get hasEarlierTurns(): boolean {
    return this.#loadedFrom > 0;
  }

  get sessions(): readonly SessionItem[] {
    return this.#sessions;
  }

  get currentSessionId(): string | undefined {
    return this.#session?.id;
  }

  get input(): string {
    return this.#input;
  }

  get canSend(): boolean {
    return this.#ready && !this.#busy && this.#input.trim().length > 0;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  /** A message is on its way: the host's `beforeSend` or its turn is running. */
  get isBusy(): boolean {
    return this.#busy;
  }

  get isHistoryOpen(): boolean {
    return this.#historyOpen;
  }

  get isModeMenuOpen(): boolean {
    return this.#modeMenuOpen;
  }

  /** The agent needs a sign-in first (the host shows its sign-in, then calls `initialize`). */
  get signInRequired(): boolean {
    return this.#signInRequired;
  }

  get error(): string | undefined {
    return this.#error;
  }

  get toolMode(): ToolMode {
    return this.#mode;
  }

  /** The picker's modes; those above the ceiling the server sets cannot be picked. */
  get toolModes(): readonly ToolModeOption[] {
    const ceiling = this.#agent.ceiling;
    return TOOL_MODES.map((mode) => ({
      mode,
      label: this.strings.modes[mode].label,
      description: this.strings.modes[mode].description,
      available: narrowestMode(mode, ceiling) === mode,
    }));
  }

  /** What the pick means here, including a ceiling. */
  get toolModeHint(): string {
    const effective = narrowestMode(this.#mode, this.#agent.ceiling);
    const description = this.strings.modes[this.#mode].description;
    return effective === this.#mode ? description : this.strings.limitedTo(description, this.strings.modes[effective].label);
  }

  // -- actions --------------------------------------------------------------------------------------

  /** Starts the agent (profile, tools) and reads the session list; first, the language the user picked before. */
  async initialize(): Promise<void> {
    if (!this.#languageLoaded) {
      try {
        this.#adopt(await this.#preferences.get(LANGUAGE_PREFERENCE));
      } catch {
        // the store failed: the automatic language
      }
    }
    this.#error = undefined;
    this.#signInRequired = false;
    this.notify();
    try {
      await this.#agent.start();
      const profile = this.#agent.profile;
      this.#adoptUserLanguage(profile.user?.language ?? null);
      this.#title = profile.name;
      const greeting = profile.ui["greeting"];
      this.#profileGreeting = typeof greeting === "string" && greeting ? greeting : undefined;
      const suggestions = profile.ui["suggestions"];
      this.#suggestions = Array.isArray(suggestions) ? suggestions.filter((s): s is string => typeof s === "string").slice(0, 6) : [];
      this.#mode = this.#startMode();
      await this.refreshSessions();
      this.#ready = true;
    } catch (error) {
      if (error instanceof FadenstackSignInRequiredError) this.#signInRequired = true;
      this.#error = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  /** The composer's text; a `$` at its end (or `/` as the whole of it) opens the skill picker, narrowed by what follows. */
  setInput(text: string): void {
    if (this.#input === text) return;
    this.#input = text;
    const token = this.canPickSkills ? skillToken(text) : undefined;
    if (token) this.skillPicker.show(token.query);
    else this.skillPicker.close();
    this.notify();
  }

  /**
   * Sends a message (the composer's when none is given), after the host's `beforeSend`; settles when its turn has
   * ended and been shown. A new message clears the last `error`.
   */
  async send(text: string = this.#input): Promise<void> {
    const message = text.trim();
    if (!message || !this.#ready || this.#busy) return;
    const outgoing: OutgoingMessage = { text: message };
    const stop = new AbortController();
    this.#stop = stop;
    this.#busy = true;
    this.#error = undefined;
    let turn: TurnViewModel | undefined;
    try {
      if (this.#beforeSend) {
        this.notify();
        try {
          await this.#beforeSend(outgoing, stop.signal);
          stop.signal.throwIfAborted();
        } catch (error) {
          if (!stop.signal.aborted) this.#error = error instanceof Error ? error.message : String(error);
          return;
        }
      }
      if (message === this.#input.trim()) this.#input = "";
      this.skillPicker.close();
      const attached = this.#attachments.filter((a) => a.sends);
      this.#attachments = this.#attachments.filter((a) => a.implicit);
      const skills = this.#skills;
      this.#skills = [];
      const chips: AttachmentChip[] = [
        ...skills.map((s): AttachmentChip => ({ title: s.name, subtitle: undefined, skill: true })),
        ...attached.map((a): AttachmentChip => (a.image ? { title: a.title, subtitle: a.subtitle, image: a.image } : { title: a.title, subtitle: a.subtitle })),
      ];
      turn = new TurnViewModel(this.#context, this, message, this.#context.now(), chips);
      this.#turns = [...this.#turns, turn];
      this.#current = turn;
      this.notify();
      await this.#runTurn(turn, message, attached, skills, this.#mode, stop.signal);
      await this.#batcher.whenFlushed();
    } finally {
      this.#current = undefined;
      this.#stop = undefined;
      this.#busy = false;
      if (turn) this.#touchSession(message);
      this.#runAfterSend(outgoing);
      this.notify();
    }
  }

  /** Stops the running turn (Esc). */
  stop(): void {
    this.#stop?.abort(abortError());
  }

  /** Starts a new chat; the session is created with its first message. */
  newChat(): void {
    if (this.#busy) return;
    this.#session = undefined;
    this.#history = [];
    this.#loadedFrom = 0;
    this.#turns = [];
    this.#attachments = this.#attachments.filter((a) => a.implicit);
    this.#skills = [];
    this.#mode = this.#startMode();
    this.#sessions = this.#sessions.map((s) => ({ ...s, isCurrent: false }));
    this.notify();
  }

  /** Opens a session from this device: its latest turns first. */
  async openSession(sessionId: string): Promise<void> {
    if (this.#busy) return;
    this.#error = undefined;
    try {
      const session = await this.#agent.openSession(sessionId);
      const grouped = groupTurns(session.transcript);
      const from = Math.max(0, grouped.length - this.#initialTurns);
      this.#session = session;
      this.#history = grouped;
      this.#loadedFrom = from;
      this.#turns = grouped.slice(from).map((t) => buildTurn(t, this.#context, this));
      this.#mode = session.toolMode;
      this.#historyOpen = false;
      this.#markCurrent();
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  /** Shows the next page of older turns. */
  loadEarlier(): void {
    if (this.#loadedFrom === 0) return;
    const from = Math.max(0, this.#loadedFrom - this.#pageSize);
    const older = this.#history.slice(from, this.#loadedFrom).map((t) => buildTurn(t, this.#context, this));
    this.#turns = [...older, ...this.#turns];
    this.#loadedFrom = from;
    this.notify();
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.#busy && sessionId === this.#session?.id) return;
    await this.#agent.deleteSession(sessionId);
    this.#sessions = this.#sessions.filter((s) => s.id !== sessionId);
    if (sessionId === this.#session?.id) this.newChat();
    this.notify();
  }

  async refreshSessions(): Promise<void> {
    const now = this.#context.now();
    const sessions = await this.#agent.listSessions();
    this.#untitled.clear();
    this.#sessions = sessions.map((s) => {
      const lastActivity = new Date(s.lastActivity);
      if (!s.title) this.#untitled.add(s.id);
      return {
        id: s.id,
        title: s.title ?? this.strings.newChat,
        lastActivity,
        whenText: formatWhen(lastActivity, now, this.strings.yesterday, this.#context.locale),
        isCurrent: s.id === this.#session?.id,
      };
    });
    this.notify();
  }

  async toggleHistory(): Promise<void> {
    this.#historyOpen = !this.#historyOpen;
    this.notify();
    if (this.#historyOpen) await this.refreshSessions();
  }

  setHistoryOpen(open: boolean): void {
    if (this.#historyOpen === open) return;
    this.#historyOpen = open;
    this.notify();
  }

  setSettingsOpen(open: boolean): void {
    if (this.#settingsOpen === open) return;
    this.#settingsOpen = open;
    this.notify();
  }

  /**
   * Picks the panel's language (`"auto"` for the host's) and remembers it on this device and for the user, so all
   * their clients and the console follow it. Everything on screen, the conversation too, is drawn again in it.
   * Nothing changes when the language is fixed.
   */
  async setLanguage(id: string): Promise<void> {
    this.#settingsOpen = false;
    if (!this.canChangeLanguage || (id !== AUTOMATIC_LANGUAGE && !Object.hasOwn(this.#languages, id))) {
      this.notify();
      return;
    }
    this.#languageLoaded = true; // the user's pick wins over one still being read
    this.#languagePicked = true;
    this.#language = id;
    this.#applyLanguage();
    try {
      await this.#preferences.set(LANGUAGE_PREFERENCE, id === AUTOMATIC_LANGUAGE ? undefined : id);
    } catch {
      // not remembered: still this chat's language
    }
    try {
      await this.#agent.setUserLanguage(id === AUTOMATIC_LANGUAGE ? null : id);
    } catch {
      // not kept for the user (an older server, no network): this device still remembers it
    }
  }

  setModeMenuOpen(open: boolean): void {
    if (this.#modeMenuOpen === open) return;
    this.#modeMenuOpen = open;
    this.notify();
  }

  /**
   * Forgets what the user allowed always for this agent on this device, and what they allowed for this chat: the
   * next call of those tools asks again.
   */
  async resetApprovals(): Promise<void> {
    this.#modeMenuOpen = false;
    this.notify();
    this.#session?.resetApprovals();
    await this.#agent.resetApprovals();
  }

  /** The user's pick for this chat; the next turn runs in it. New chats start in `ask`. */
  selectToolMode(mode: ToolMode): void {
    const option = this.toolModes.find((o) => o.mode === mode);
    this.#modeMenuOpen = false;
    if (option?.available) {
      this.#mode = mode;
      if (this.#session) this.#session.toolMode = mode;
    }
    this.notify();
  }

  /** Adds context for the next message (a chip in the composer). An implicit chip stays until removed; change it with `update`. */
  addAttachment(attachment: AttachmentViewModel): void {
    this.#attachments = [...this.#attachments, attachment];
    this.notify();
  }

  /** Adds known content as a chip. */
  attach(content: MessageAttachment): AttachmentViewModel {
    const chip = AttachmentViewModel.fromContent(content);
    this.addAttachment(chip);
    return chip;
  }

  removeAttachment(attachment: AttachmentViewModel): void {
    this.#attachments = this.#attachments.filter((a) => a !== attachment);
    this.notify();
  }

  /**
   * A picture for the next message, as a chip. Only for a model that sees pictures: otherwise nothing is added,
   * `error` says why, and it returns false.
   */
  attachPicture(picture: PictureInput): boolean {
    if (!this.canAttachPictures) {
      this.#error = this.strings.picturesNotSeen;
      this.notify();
      return false;
    }
    const title = picture.title?.trim() || this.strings.pastedPicture;
    const attachment: MessageAttachment = {
      title,
      content: picture.dataUrl,
      kind: picture.kind ?? "picture",
      mediaType: /^data:(image\/[\w.+-]+)[;,]/.exec(picture.dataUrl)?.[1] ?? "image/png",
    };
    this.addAttachment(new AttachmentViewModel({
      title,
      subtitle: this.strings.picture,
      image: picture.dataUrl,
      resolve: () => Promise.resolve(attachment),
    }));
    this.requestComposerFocus();
    return true;
  }

  /** Says that a file the user added could not be read as a picture (`error`). */
  pictureNotRead(name: string): void {
    this.#error = this.strings.pictureNotRead(name);
    this.notify();
  }

  /** Takes a picked skill off the next message. */
  removeSkill(slug: string): void {
    this.#skills = this.#skills.filter((s) => s.slug !== slug);
    this.notify();
  }

  /** The picker's choice: the `$...` the user typed goes, the skill goes with the next message. */
  #pickSkill(skill: SkillOption): void {
    const token = skillToken(this.#input);
    if (token) this.#input = this.#input.slice(0, token.start).replace(/\s+$/, (space) => (token.start > 0 ? space.slice(0, 1) : ""));
    if (!this.#skills.some((s) => s.slug === skill.slug)) this.#skills = [...this.#skills, skill];
    this.notify();
    this.requestComposerFocus();
  }

  /** Asks the skin to put the focus in the composer (e.g. after the host attached the selection). */
  requestComposerFocus(): void {
    for (const listener of [...this.#focusListeners]) listener();
  }

  onComposerFocus(listener: () => void): () => void {
    this.#focusListeners.add(listener);
    return () => {
      this.#focusListeners.delete(listener);
    };
  }

  dispose(): void {
    this.#unsubscribe();
    this.#stop?.abort(abortError());
  }

  // -- TurnHost ---------------------------------------------------------------------------------------

  edit(text: string): void {
    this.#input = text;
    this.notify();
    this.requestComposerFocus();
  }

  retry(turn: TurnViewModel): Promise<void> {
    return this.send(turn.userText);
  }

  /** Copies an answer: its Markdown as text, and as HTML, so it pastes formatted into mail and documents. */
  copy(text: string): void {
    void Promise.resolve(writeClipboard(this.#context.clipboard, { text, html: markdownToHtml(text) })).catch(() => undefined);
  }

  // -- the turn -------------------------------------------------------------------------------------

  async #runTurn(turn: TurnViewModel, text: string, attached: readonly AttachmentViewModel[], skills: readonly SkillOption[],
    mode: ToolMode, signal: AbortSignal): Promise<void> {
    try {
      const attachments: MessageAttachment[] = [];
      for (const a of attached) {
        try {
          const resolved = await a.resolve(signal);
          if (resolved) attachments.push(resolved);
        } catch (error) {
          if (signal.aborted) throw error;
          const title = a.title;
          const message = error instanceof Error ? error.message : String(error);
          this.#batcher.enqueue(() => turn.addPart(NoticePart.localized(this.#context, "warning",
            (s) => ({ title: s.notAttached(title), message }))));
        }
      }
      if (!this.#session) {
        this.#session = await this.#agent.startSession(mode);
        this.#batcher.enqueue(() => this.notify());
      }
      this.#session.toolMode = mode;
      const picked = skills.map((s) => ({ slug: s.slug, name: s.name }));
      for await (const event of this.#session.stream(text, { attachments, skills: picked, signal })) this.#apply(turn, event);
    } catch (error) {
      if (signal.aborted) {
        this.#batcher.enqueue(() => turn.stop());
      } else if (error instanceof FadenstackSignInRequiredError) {
        this.#batcher.enqueue(() => {
          this.#signInRequired = true;
          turn.fail(error.message);
          this.notify();
        });
      } else {
        this.#batcher.enqueue(() => turn.fail(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  #apply(turn: TurnViewModel, e: AgentEvent): void {
    switch (e.type) {
      case "turn_started":
        this.#batcher.enqueue(() => turn.setId(e.turnId));
        break;
      case "text":
        this.#batcher.enqueueText(turn, e.text, (t) => turn.appendText(t));
        break;
      case "reasoning":
        this.#batcher.enqueueText(reasoningKey(turn), e.text, (t) => turn.appendReasoning(t));
        break;
      case "tool_started":
        this.#batcher.enqueue(() => turn.toolStarted(e));
        break;
      case "tool_completed":
        this.#batcher.enqueue(() => turn.toolCompleted(e));
        break;
      case "approval_requested":
        this.#onApprovalEvent(turn, e.request);
        break;
      case "approval_decided":
        this.#batcher.enqueue(() => turn.approvalDecided(e.request, e.decision));
        break;
      case "notice":
        this.#batcher.enqueue(() => turn.addNotice(e.notice));
        break;
      case "gateway_event":
        this.#batcher.enqueue(() => {
          for (const renderer of this.#renderers) if (renderer.render(e.event, turn, this.#context)) break;
        });
        break;
      case "turn_completed":
        this.#batcher.enqueue(() => turn.complete(e.result));
        break;
    }
  }

  #onApprovalEvent(turn: TurnViewModel, request: { callId: string; toolName: string }): void {
    const key = approvalKey(request);
    const pending = this.#waitingForEvent.get(key);
    if (!pending) {
      this.#eventsWithoutRequest.add(key);
      return;
    }
    this.#waitingForEvent.delete(key);
    this.#batcher.enqueue(() => turn.addApproval(pending));
  }

  #onApprovalRequested(pending: PendingApproval): void {
    const key = approvalKey(pending.request);
    if (!this.#eventsWithoutRequest.delete(key)) {
      this.#waitingForEvent.set(key, pending);
      return;
    }
    const turn = this.#current;
    if (!turn) {
      pending.resolve({ approved: false, reason: "The chat is closed." });
      return;
    }
    this.#batcher.enqueue(() => turn.addApproval(pending));
  }

  #runAfterSend(message: OutgoingMessage): void {
    if (!this.#afterSend) return;
    try {
      this.#afterSend(message);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
    }
  }

  /** The texts for the language: the host's fixed ones, the organisation's, the user's pick, or the host's language. */
  #resolve(): UiStrings {
    if (this.#fixed) return this.#fixed;
    const id = this.#locked ?? this.#language;
    return (id !== AUTOMATIC_LANGUAGE ? this.#languages[id] : undefined) ?? stringsFor(this.#automatic, this.#languages);
  }

  /** A pick read back from the store, when it is still one the user can make. */
  #adopt(saved: string | undefined): void {
    if (this.#languageLoaded) return;
    this.#languageLoaded = true;
    if (!saved || !this.canChangeLanguage || !Object.hasOwn(this.#languages, saved) || saved === this.#language) return;
    this.#language = saved;
    this.#applyLanguage();
  }

  /**
   * The language the user picked in another client or the console wins over this device's, when the panel offers
   * it (`de-AT` is German, `zh` Simplified Chinese; a language it lacks changes nothing). A pick made here since
   * the panel opened stays.
   */
  #adoptUserLanguage(tag: string | null): void {
    if (!tag || this.#languagePicked || !this.canChangeLanguage) return;
    const key = this.#keyOf(stringsFor(tag, this.#languages));
    if (!key || primaryTag(key) !== primaryTag(tag) || key === this.#language) return;
    this.#languageLoaded = true;
    this.#language = key;
    this.#applyLanguage();
    try {
      void Promise.resolve(this.#preferences.set(LANGUAGE_PREFERENCE, key)).catch(() => undefined);
    } catch {
      // not remembered on this device: the profile says it again next time
    }
  }

  /** Every text on screen in the language: the conversation's, the history's, the menus'. */
  #applyLanguage(): void {
    const strings = this.#resolve();
    if (this.#context && strings !== this.#context.strings) {
      this.#context.strings = strings;
      const now = this.#context.now();
      this.#sessions = this.#sessions.map((s) => ({
        ...s,
        title: this.#untitled.has(s.id) ? strings.newChat : s.title,
        whenText: formatWhen(s.lastActivity, now, strings.yesterday, this.#context.locale),
      }));
      for (const turn of this.#turns) turn.retext();
    }
    this.notify();
  }

  #keyOf(strings: UiStrings): string | undefined {
    return Object.entries(this.#languages).find(([, s]) => s === strings)?.[0];
  }

  #startMode(): ToolMode {
    const start = this.#agent.defaultToolMode;
    const options = this.toolModes;
    return options.find((o) => o.mode === start && o.available)?.mode ?? [...options].reverse().find((o) => o.available)?.mode ?? "off";
  }

  #touchSession(text: string): void {
    const session = this.#session;
    if (!session) return;
    const now = this.#context.now();
    const whenText = formatWhen(now, now, this.strings.yesterday, this.#context.locale);
    const existing = this.#sessions.find((s) => s.id === session.id);
    const item: SessionItem = existing
      ? { ...existing, lastActivity: now, whenText }
      : { id: session.id, title: text.length <= 60 ? text : `${text.slice(0, 57)}...`, lastActivity: now, whenText, isCurrent: true };
    this.#sessions = [item, ...this.#sessions.filter((s) => s.id !== session.id)];
    this.#markCurrent();
  }

  #markCurrent(): void {
    const id = this.#session?.id;
    this.#sessions = this.#sessions.map((s) => (s.isCurrent === (s.id === id) ? s : { ...s, isCurrent: s.id === id }));
  }
}

const reasoningKeys = new WeakMap<TurnViewModel, object>();

/** A batch target for a turn's reasoning, apart from its text. */
function reasoningKey(turn: TurnViewModel): object {
  let key = reasoningKeys.get(turn);
  if (!key) {
    key = {};
    reasoningKeys.set(turn, key);
  }
  return key;
}

function approvalKey(request: { callId: string; toolName: string }): string {
  return `${request.callId}\u0001${request.toolName}`;
}

function abortError(): Error {
  const error = new Error("Stopped.");
  error.name = "AbortError";
  return error;
}
