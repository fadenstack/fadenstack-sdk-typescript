import type { AgentEvent, AgentSession, FadenAgent, MessageAttachment, TranscriptEntry } from "@fadenstack/agents";
import { FadenSignInRequiredError, TOOL_MODES, narrowestMode, type ToolMode } from "@fadenstack/client";

import type { ApprovalBroker, PendingApproval } from "./approvalBroker.js";
import { AttachmentViewModel } from "./attachments.js";
import { RenderBatcher } from "./batcher.js";
import { formatWhen } from "./format.js";
import { markdownToHtml } from "./markdown/serialize.js";
import { Observable } from "./observable.js";
import { NoticePart, type PartContext } from "./parts.js";
import { citationsRenderer, fallbackRenderer, piiRenderer, type AgentEventRenderer } from "./renderers.js";
import { browserClipboard, timeoutScheduler, writeClipboard, type Clipboard, type UiScheduler } from "./services.js";
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
  /** Texts in another language or the host's own words. */
  strings?: Partial<UiStrings>;
  /** For dates and numbers; the browser's by default. */
  locale?: string;
  now?: () => Date;
}

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
 * stay light. .NET: `Faden.UI.ViewModels.AgentChatViewModel`.
 */
export class AgentChatViewModel extends Observable implements TurnHost {
  readonly strings: UiStrings;
  readonly #agent: FadenAgent;
  readonly #approvals: ApprovalBroker;
  readonly #batcher: RenderBatcher;
  readonly #renderers: AgentEventRenderer[];
  readonly #context: PartContext;
  readonly #initialTurns: number;
  readonly #pageSize: number;
  readonly #unsubscribe: () => void;
  readonly #focusListeners = new Set<() => void>();
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
  #greeting = "";
  #suggestions: readonly string[] = [];
  #turns: readonly TurnViewModel[] = [];
  #attachments: readonly AttachmentViewModel[] = [];
  #sessions: readonly SessionItem[] = [];
  #input = "";
  #ready = false;
  #busy = false;
  #historyOpen = false;
  #modeMenuOpen = false;
  #signInRequired = false;
  #error: string | undefined;
  #mode: ToolMode = "ask";

  constructor(agent: FadenAgent, approvals: ApprovalBroker, options: AgentChatOptions = {}) {
    super();
    this.#agent = agent;
    this.#approvals = approvals;
    this.strings = withStrings(options.strings);
    this.#batcher = new RenderBatcher(options.scheduler ?? timeoutScheduler, options.renderIntervalMs ?? 33);
    this.#renderers = [...(options.renderers ?? []), citationsRenderer, piiRenderer, fallbackRenderer];
    this.#initialTurns = options.initialTurns ?? 30;
    this.#pageSize = options.pageSize ?? 30;
    this.#context = {
      strings: this.strings,
      clipboard: options.clipboard ?? browserClipboard,
      locale: options.locale,
      previewLength: options.previewLength ?? 4000,
      now: options.now ?? (() => new Date()),
    };
    this.#unsubscribe = approvals.onRequested((pending) => this.#onApprovalRequested(pending));
  }

  // -- state ----------------------------------------------------------------------------------------

  get agent(): FadenAgent {
    return this.#agent;
  }

  get title(): string {
    return this.#title;
  }

  /** The agent's greeting for an empty chat (profile `ui.greeting`). */
  get greeting(): string {
    return this.#greeting;
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

  /** A turn is running. */
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

  /** The picker's modes; those above the agent's ceiling (EE) cannot be picked. */
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

  /** Starts the agent (profile, tools) and reads the session list. */
  async initialize(): Promise<void> {
    this.#error = undefined;
    this.#signInRequired = false;
    this.notify();
    try {
      await this.#agent.start();
      const profile = this.#agent.profile;
      this.#title = profile.name;
      const greeting = profile.ui["greeting"];
      this.#greeting = typeof greeting === "string" && greeting ? greeting : this.strings.greetingFallback(profile.name);
      const suggestions = profile.ui["suggestions"];
      this.#suggestions = Array.isArray(suggestions) ? suggestions.filter((s): s is string => typeof s === "string").slice(0, 6) : [];
      this.#mode = this.#startMode();
      await this.refreshSessions();
      this.#ready = true;
    } catch (error) {
      if (error instanceof FadenSignInRequiredError) this.#signInRequired = true;
      this.#error = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  setInput(text: string): void {
    if (this.#input === text) return;
    this.#input = text;
    this.notify();
  }

  /** Sends a message (the composer's when none is given); settles when its turn has ended and been shown. */
  async send(text: string = this.#input): Promise<void> {
    const message = text.trim();
    if (!message || !this.#ready || this.#busy) return;
    if (message === this.#input.trim()) this.#input = "";
    const attached = this.#attachments.filter((a) => a.sends);
    this.#attachments = this.#attachments.filter((a) => a.implicit);
    const turn = new TurnViewModel(this.#context, this, message, this.#context.now(),
      attached.map((a) => ({ title: a.title, subtitle: a.subtitle })));
    this.#turns = [...this.#turns, turn];
    this.#current = turn;
    this.#stop = new AbortController();
    this.#busy = true;
    this.notify();
    try {
      await this.#runTurn(turn, message, attached, this.#mode, this.#stop.signal);
      await this.#batcher.whenFlushed();
    } finally {
      this.#current = undefined;
      this.#stop = undefined;
      this.#busy = false;
      this.#touchSession(message);
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
    this.#sessions = sessions.map((s) => {
      const lastActivity = new Date(s.lastActivity);
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

  setModeMenuOpen(open: boolean): void {
    if (this.#modeMenuOpen === open) return;
    this.#modeMenuOpen = open;
    this.notify();
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

  /** Adds context for the next message (a chip in the composer). An implicit chip replaces one with the same title. */
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

  async #runTurn(turn: TurnViewModel, text: string, attached: readonly AttachmentViewModel[], mode: ToolMode,
    signal: AbortSignal): Promise<void> {
    try {
      const attachments: MessageAttachment[] = [];
      for (const a of attached) {
        try {
          const resolved = await a.resolve(signal);
          if (resolved) attachments.push(resolved);
        } catch (error) {
          if (signal.aborted) throw error;
          const title = a.title;
          this.#batcher.enqueue(() => turn.addPart(new NoticePart("warning", this.strings.notAttached(title),
            error instanceof Error ? error.message : String(error))));
        }
      }
      if (!this.#session) {
        this.#session = await this.#agent.startSession(mode);
        this.#batcher.enqueue(() => this.notify());
      }
      this.#session.toolMode = mode;
      for await (const event of this.#session.stream(text, { attachments, signal })) this.#apply(turn, event);
    } catch (error) {
      if (signal.aborted) {
        this.#batcher.enqueue(() => turn.stop());
      } else if (error instanceof FadenSignInRequiredError) {
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
