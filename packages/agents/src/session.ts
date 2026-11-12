import {
  FadenstackRateLimitedError,
  decideTool,
  eventKind,
  isRefusal,
  narrowestMode,
  parseToolClass,
  parseToolMode,
  readNotice,
  receiptIdOf,
  type ChatMessage,
  type ChatOptions,
  type AgentGrant,
  type ChatOutcome,
  type ReasoningEffort,
  type FadenstackEvent,
  type FinishReason,
  type GovernanceNotice,
  type HostToolDecision,
  type ReceiptNote,
  type ToolCall,
  type ToolClass,
  type ToolMode,
  type Usage,
} from "@fadenstack/client";

import type { FadenstackAgent } from "./agent.js";
import { ApprovalDecision, type ApprovalHandler, type ApprovalRequest, type ApprovalScope } from "./approvals.js";
import { BypassSignInError } from "./stepUp.js";
import { attachmentData, type MessageAttachment } from "./attachments.js";
import { ContextBuilder, isBlank } from "./contextBuilder.js";
import { EventQueue } from "./eventQueue.js";
import type { AgentEvent, AgentResult, ToolOutcome } from "./events.js";
import type { ToolInvocation, ToolInvoker, ToolServiceCall } from "./stages.js";
import { checkArguments, type AgentTool, type ToolServiceKey, type ToolServices } from "./tools.js";
import { EntryTypes, TurnStatus, newId, type TranscriptEntry } from "./transcript.js";
import { commandJson, commandSchemaHash } from "./commands.js";
import { reasoningLevelOf, reasoningRecord, type ReasoningLevel } from "./reasoning.js";
import { AgentGrants, cutReason, type GrantCall, type GrantPlace, type GrantVerdict } from "./grants.js";

/** A skill the user picked for a message: its slug for the server, its name for the transcript. */
export interface PickedSkill {
  slug: string;
  name?: string;
}

export interface SendOptions {
  /** Context the user attached (a selection, the page, a picture). */
  attachments?: readonly MessageAttachment[];
  /** Skills the user picked for this message: every model call of the turn gets them. */
  skills?: readonly PickedSkill[];
  /** Stops the turn: it is recorded as cancelled and the stream throws the reason. */
  signal?: AbortSignal;
}

export interface HostCommandOptions {
  origin?: "user_command" | "user_history";
  signal?: AbortSignal;
  /** Single-line local display text, never an argument, grant or model message. */
  label?: string;
}

export interface HostCommandResult {
  turnId: string;
  callId: string;
  outcome: ToolOutcome;
  result: string | undefined;
}

type Data = Record<string, unknown>;
const str = (data: unknown, key: string): string | undefined => {
  const v = data && typeof data === "object" ? (data as Data)[key] : undefined;
  return typeof v === "string" ? v : undefined;
};

/** What a turn may do to its session that nobody else may: write the transcript, keep what this chat allowed. */
interface SessionAccess {
  append(type: string, turnId: string | null, data: Data, status?: string | null): Promise<void>;
  readonly approved: Set<string>;
}

/**
 * A call of the agent's own tool the gateway marked (`faden.approval_required` without an approvalId): an admin's
 * "Ask first" rule, or the class the gateway holds for the tool, which the session never takes looser than its own.
 */
interface GatewayMark {
  rule: boolean;
  toolClass: ToolClass | undefined;
  message: string;
}

/**
 * Which call of a round a word of the gateway (`faden.tool_denied`, `faden.approval_required`) is about: the call's index in the
 * stream when the gateway gives one, else its id, else (no id) the tool's name.
 */
interface Aim {
  callId: string;
  toolName: string;
  index: number | undefined;
}

function aimOf(value: unknown): Aim {
  const index = value && typeof value === "object" ? (value as Data)["toolCallIndex"] : undefined;
  return {
    callId: str(value, "toolCallId") ?? "", toolName: str(value, "toolCallName") ?? "",
    index: typeof index === "number" && Number.isInteger(index) ? index : undefined,
  };
}

/** A call of a round ready to run: under an id of its own, with what the gateway said of it. */
interface PlannedCall {
  call: ToolCall;
  denied: boolean;
  hidden: boolean;
  mark: GatewayMark | undefined;
}

/** Two marks on one call: a rule wins, the stricter class wins. */
function mergeMarks(a: GatewayMark, b: GatewayMark): GatewayMark {
  return {
    rule: a.rule || b.rule,
    toolClass: a.toolClass === undefined ? b.toolClass : stricterClass(a.toolClass, b.toolClass),
    message: b.rule && !a.rule ? b.message : a.message,
  };
}

/** The stricter of two classes; unclassified when either is. */
function stricterClass(own: ToolClass, other: ToolClass | undefined): ToolClass {
  if (!other || other === own) return own;
  if (own === "unknown" || other === "unknown") return "unknown";
  const rank: Record<ToolClass, number> = { read: 0, write: 1, destructive: 2, unknown: 3 };
  return rank[other] > rank[own] ? other : own;
}

/** Destructive and unclassified tools ask every time: never for the chat, never always. */
const asksEveryTime = (toolClass: ToolClass): boolean => toolClass === "destructive" || toolClass === "unknown";

class CommandDenied extends Error {}

function freezeCommand<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeCommand(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * One conversation with the agent, kept on this device (06). A turn sends the history the session rule allows,
 * streams the answer, runs the agent's tools under the session's tool mode -- asking the user where the mode
 * says so -- and ends with a typed outcome. Refusals are outcomes; the session goes on.
 */
export class AgentSession {
  readonly id: string;
  /** The mode the user picked for this session. New sessions start in `ask`. */
  toolMode: ToolMode;
  readonly agent: FadenstackAgent;
  /**
   * The handler asked for this session's approvals; the agent's own when not set. A host that gives each chat its own
   * handler sets it; one that shares a handler tells the chats apart by `ApprovalRequest.sessionId`.
   */
  approvals: ApprovalHandler | undefined;
  #reasoning: ReasoningLevel | undefined;
  readonly #entries: TranscriptEntry[];
  /** "Allow for this chat": this object's only, in memory. A session opened again starts asking again. */
  readonly #approvedForSession = new Set<string>();
  readonly #context: ContextBuilder;
  #running = false;

  constructor(agent: FadenstackAgent, id: string, entries: TranscriptEntry[], toolMode: ToolMode) {
    this.agent = agent;
    this.id = id;
    this.#entries = entries;
    this.toolMode = toolMode;
    this.#context = new ContextBuilder(agent.settings.historyTokens);
  }

  /**
   * The mode turns run in: the user's pick, narrowed by the ceiling the server sets, if any. Bypass only while the server
   * holds the conversation's Bypass grant (`startBypass`): no grant, no Bypass -- it is `auto` (sdk/09 L-59).
   */
  get effectiveToolMode(): ToolMode {
    const mode = narrowestMode(this.toolMode, this.agent.ceiling);
    return mode === "bypass" && this.bypass === undefined ? "auto" : mode;
  }

  /** The conversation's live Bypass grant (the marker shows its time left); undefined when it is not in Bypass. */
  get bypass(): AgentGrant | undefined {
    return this.agent.grants.bypassFor(this.id);
  }

  // The mode before Bypass, to go back to when it ends.
  #beforeBypass: ToolMode | undefined;

  /**
   * How long the model thinks on the next message. Until it is set, the agent's level (`FadenstackAgent.reasoning`: the
   * person's pick, the app's) -- so a new conversation starts from the person's pick. A turn that already started keeps the
   * level it started with. A level above the server's maximum shows and sends the maximum.
   */
  get reasoning(): ReasoningLevel {
    const level = this.#reasoning;
    return level !== undefined && level !== "auto" ? reasoningLevelOf(this.agent.effortFor(level)) : level ?? this.agent.reasoning;
  }

  set reasoning(level: ReasoningLevel) {
    this.#reasoning = level;
  }

  /** @internal What a turn started now would send: the session's level, or -- while it follows the agent -- the agent's own effort. */
  get requestEffort(): ReasoningEffort | undefined {
    return this.#reasoning !== undefined ? this.agent.effortFor(this.#reasoning) : this.agent.requestEffort;
  }

  /** The transcript, as kept on this device. */
  get transcript(): readonly TranscriptEntry[] {
    return this.#entries;
  }

  /** What the next request would carry as history. */
  get history(): ChatMessage[] {
    return this.#context.build(this.#entries);
  }

  /** Tools the user approved for the rest of this session ("Allow for this chat"), while this object lives. */
  get approvedForSession(): ReadonlySet<string> {
    return this.#approvedForSession;
  }

  /** Forgets what the user allowed for this chat: every tool, or `tool` only. */
  resetApprovals(tool?: string): void {
    if (tool === undefined) this.#approvedForSession.clear();
    else this.#approvedForSession.delete(tool);
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /**
   * Asks the person to let the agent work alongside them in this chat (desktop 37 §5.3): read and write in `places`, for a
   * while, without asking -- never for anything destructive, unclassified, or an admin's "Ask first" rule. The card is drawn
   * by the app's grant handler (`useGrantHandler`); the person may remove places and picks the time. Returns the grant the
   * server confirmed, or null: declined, not offered (no grants on the server, the agent does not offer them, no handler),
   * or no place left. A refusal by the server is thrown: no answer, no grant (L-59).
   */
  async offerWork(places: readonly GrantPlace[], reason?: string, signal?: AbortSignal): Promise<AgentGrant | null> {
    const grants = this.agent.grants;
    const handler = this.agent.grantHandler;
    if (!handler || !grants.offers("grant") || places.length === 0 || grants.choices.length === 0) return null;
    const choices = grants.choices;
    const answer = await handler.requestGrant({
      places, classes: grants.settings!.grantClasses, durations: choices,
      preselected: choices.includes(AgentGrants.preselected) ? AgentGrants.preselected : choices[choices.length - 1]!,
      ...(reason !== undefined ? { reason } : {}), conversationId: this.id,
    }, signal ?? new AbortController().signal);
    const kept = answer.places.filter((p) => places.some((q) => AgentGrants.samePlace(p, q)));
    if (!answer.allowed || kept.length === 0) return null;
    return grants.grantWork(kept, within(answer.duration, choices), this.id, answer.shownText, signal);
  }

  /**
   * Asks the person to extend a running grant -- `more` time (milliseconds), and for a stretch of work the new `places` --
   * on the same card, showing only the difference (desktop 37 §5.3). The server keeps the grant within the agent's longest
   * grant from when it was made; past that it refuses, and a new grant needs the full card. A Bypass grant is never
   * extended: it runs for the time its confirmation said, and more time is a new Bypass with the confirmation again (L-58).
   * Returns the extended grant, or null when the person said no or nothing is offered.
   */
  async offerExtension(grant: AgentGrant, more: number, places: readonly GrantPlace[] = [], reason?: string,
    signal?: AbortSignal): Promise<AgentGrant | null> {
    const grants = this.agent.grants;
    const handler = this.agent.grantHandler;
    if (!handler || !grants.available || grant.kind === "bypass") return null;
    const answer = await handler.requestGrant({
      places, classes: grant.scope.classes ?? [], durations: [more], preselected: more,
      ...(reason !== undefined ? { reason } : {}), extending: grant,
    }, signal ?? new AbortController().signal);
    if (!answer.allowed) return null;
    const kept = answer.places.filter((p) => places.some((q) => AgentGrants.samePlace(p, q)));
    const time = answer.duration > 0 ? Math.min(answer.duration, more) : 0;
    if (time === 0 && kept.length === 0) return null;
    return grants.extend(grant.id, time, kept, answer.shownText, signal);
  }

  /**
   * Asks the person to switch approvals off in this conversation for a while (sdk/09 §3.12, L-58): the app's grant handler
   * draws the confirmation (`GrantOffer.bypass`), which says what will no longer be asked, what still asks and what the
   * server records, and the person picks the time -- 30 minutes are preselected, else the longest offered -- and may say why.
   * Only once the server confirmed the grant does the conversation run in Bypass (L-59); a refusal is thrown. An app set to
   * the `bypass` permission mode chose it in its own code: no card, the longest time, recorded the same way. `reason` is
   * recorded when the person gave none on the card. Returns the grant, or null: not offered (the organisation or the agent
   * does not allow it), no handler, or declined. The second sign-in comes after the card's Allow, never before and never on
   * the model's word: no tool and no other agent can call this (L-58).
   * @throws BypassSignInError The second sign-in did not happen.
   */
  async startBypass(reason?: string, signal?: AbortSignal): Promise<AgentGrant | null> {
    const grants = this.agent.grants;
    const choices = grants.bypassChoices;
    if (!this.agent.bypassOffered || choices.length === 0) return null;
    let duration = choices[choices.length - 1]!;
    let shown: string | undefined;
    if (this.agent.permissionMode !== "bypass") {
      const handler = this.agent.grantHandler;
      if (!handler) return null;
      const answer = await handler.requestGrant({
        // 30 min first, as the work card (owner, 2026-11-09); where it is not offered, the longest that is.
        bypass: true, places: [], classes: [], durations: choices, ...(reason !== undefined ? { reason } : {}),
        preselected: choices.includes(AgentGrants.preselected) ? AgentGrants.preselected : choices[choices.length - 1]!,
        ...(grants.settings?.bypass ? { evidence: grants.settings.bypass.evidence } : {}), conversationId: this.id,
      }, signal ?? new AbortController().signal);
      if (!answer.allowed) return null;
      duration = within(answer.duration, choices);
      shown = answer.shownText;
      const own = answer.reason?.trim();
      if (own) reason = cutReason(own);
    } else if (!this.agent.stepUpHandler) {
      // Set in the app's code, but nobody can sign in again for it: no Bypass, the session runs in Auto (sdk/41).
      console.warn("Bypass was not switched on: the app opens no second sign-in (useStepUpHandler).");
      this.#runInAutoInstead();
      return null;
    }
    // The second sign-in comes after the card's Allow, never before and never on the model's word (sdk/41).
    const grant = await grants.grantBypass(duration, this.id, reason, shown, signal);
    if (this.toolMode !== "bypass") {
      this.#beforeBypass = this.toolMode;
      this.toolMode = "bypass";
    }
    return grant;
  }

  /**
   * Ends Bypass in this conversation: its grant ends from the next call on (a call already running finishes), and the
   * conversation goes back to the mode it had before. The marker's Stop.
   */
  async stopBypass(signal?: AbortSignal): Promise<void> {
    await this.#endBypassGrants(signal);
    if (this.toolMode === "bypass") this.toolMode = this.#beforeBypass ?? "auto";
    this.#beforeBypass = undefined;
  }

  async #endBypassGrants(signal?: AbortSignal): Promise<void> {
    for (const grant of this.agent.grants.live.filter((g) => g.kind === "bypass" && g.conversationId === this.id)) {
      await this.agent.grants.revoke(grant.id, signal);
    }
  }

  /**
   * @internal Before a turn: a conversation that left Bypass ends its grant (leaving Bypass ends it, L-63); an app set to
   * the `bypass` permission mode starts it where the server offers it, never from Read only or Off -- Bypass skips
   * questions, it does not show what the mode hides.
   */
  async settleBypass(signal: AbortSignal): Promise<void> {
    if (this.toolMode !== "bypass" && this.bypass !== undefined) await this.#endBypassGrants(signal);
    if (this.agent.permissionMode === "bypass" && narrowestMode("ask", this.toolMode) === "ask" && this.bypass === undefined) {
      // Where Bypass cannot be had -- the server does not offer it, or the app opens no second sign-in -- the session runs in
      // Auto instead (owner, 2026-11-09), as it did before the flow: never above the app's own default.
      if (!this.agent.bypassOffered || !this.agent.stepUpHandler) return this.#runInAutoInstead();
      try {
        await this.startBypass("PermissionMode.Bypass", signal);
      } catch (error) {
        if (!(error instanceof BypassSignInError)) throw error;
        // No second sign-in, no Bypass (sdk/41): the turn runs in Auto.
        console.warn(`Bypass was not switched on, the turn runs in auto: ${error.message}`);
        this.#runInAutoInstead();
      }
    }
  }

  /**
   * An app set to the `bypass` permission mode that gets no Bypass (no second sign-in): its session runs in Auto instead
   * (owner, 2026-11-09), never above the ceiling and never more than the app's own mode allows.
   */
  #runInAutoInstead(): void {
    if (this.toolMode === "ask") this.toolMode = narrowestMode("auto", this.agent.settings.defaultMode);
  }

  /**
   * @internal After a turn in Bypass: the calls the device ran under its grant go to the gateway, which compares them with
   * its own records (L-61). A report that does not arrive is logged; the gateway's record stands on its own.
   */
  async reportBypass(grantId: string | undefined, calls: readonly string[]): Promise<void> {
    if (grantId === undefined) return;
    try {
      await this.agent.grants.report(grantId, calls);
    } catch {
      console.warn("The calls of a turn in Bypass could not be reported to the server.");
    }
  }

  /** @internal A session opened again in Bypass (its grant lives): the mode to go back to when it ends. */
  reopened(before: ToolMode | undefined): void {
    if (this.toolMode === "bypass") this.#beforeBypass = before;
  }

  /** @internal Whether the last turn of the transcript ran in Bypass (its `effective_tool_mode`). */
  lastTurnRanInBypass(): boolean {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i]!.type === EntryTypes.turnStart) return parseToolMode(str(this.#entries[i]!.data, "effective_tool_mode")) === "bypass";
    }
    return false;
  }

  /** Sends a message and waits for the turn to end. */
  async send(message: string, options: SendOptions = {}): Promise<AgentResult> {
    let result: AgentResult | undefined;
    for await (const event of this.stream(message, options)) {
      if (event.type === "turn_completed") result = event.result;
    }
    return result!;
  }

  /** One explicit user command through current central policy, stages and approval; no model request. */
  async invokeTool(name: string, args: Record<string, unknown>, options: HostCommandOptions = {}): Promise<HostCommandResult> {
    let result: HostCommandResult | undefined;
    for await (const event of this.streamTool(name, args, options)) {
      if (event.type === "tool_completed") result = {
        turnId: event.turnId, callId: event.callId, outcome: event.outcome, result: event.result,
      };
    }
    if (!result) throw new Error("The host command did not finish.");
    return result;
  }

  /** Streams an explicit user action using normal SDK events; cancellation also cancels pending approval. */
  async *streamTool(name: string, args: Record<string, unknown>, options: HostCommandOptions = {}): AsyncGenerator<AgentEvent> {
    if (this.#running) throw new Error("A turn is already running in this session.");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new TypeError("A valid host tool name is required.");
    const copied = JSON.parse(commandJson(args)) as Record<string, unknown>;
    const origin = options.origin ?? "user_command";
    if (origin !== "user_command" && origin !== "user_history") throw new TypeError("Invalid command origin.");
    const label = options.label;
    if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 200 || /[\x00-\x1f\x7f]/.test(label))) throw new TypeError("A command label must be a single line of at most 200 characters.");
    this.#running = true;
    const stop = new AbortController();
    const onAbort = () => stop.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const queue = new EventQueue<AgentEvent>();
    const access: SessionAccess = {
      append: (type, turnId, data, status) => this.#append(type, turnId, data, status),
      approved: this.#approvedForSession,
    };
    const turn = new Turn(this, newId(), (e) => queue.push(e), access);
    const run = turn.runCommand(name, copied, origin, stop.signal, label?.trim())
      .then(() => queue.end(), (error: unknown) => queue.end(error ?? new Error("The command failed.")))
      .finally(() => this.agent.reporter.flush());
    let finished = false;
    try {
      for await (const event of queue) yield event;
      finished = true;
    } finally {
      if (!finished) stop.abort(abortReason());
      await run;
      options.signal?.removeEventListener("abort", onAbort);
      this.#running = false;
    }
  }

  /**
   * Sends a message and streams what happens. Leaving the stream early (or aborting the signal) stops the turn;
   * it is recorded as cancelled.
   */
  async *stream(message: string, options: SendOptions = {}): AsyncGenerator<AgentEvent> {
    if (this.#running) throw new Error("A turn is already running in this session.");
    this.#running = true;
    const stop = new AbortController();
    const onAbort = () => stop.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const queue = new EventQueue<AgentEvent>();
    const access: SessionAccess = {
      append: (type, turnId, data, status) => this.#append(type, turnId, data, status),
      approved: this.#approvedForSession,
    };
    const turn = new Turn(this, newId(), (e) => queue.push(e), access);
    const run = turn
      .run(message, options.attachments ?? [], options.skills ?? [], stop.signal)
      .then(() => queue.end(), (error: unknown) => queue.end(error ?? new Error("The turn failed.")))
      .finally(async () => {
        await this.reportBypass(turn.bypassGrant, turn.bypassRan);
        await this.agent.reporter.flush();
      });
    let finished = false;
    try {
      for await (const event of queue) yield event;
      finished = true;
    } finally {
      if (!finished) stop.abort(abortReason());
      await run;
      options.signal?.removeEventListener("abort", onAbort);
      this.#running = false;
    }
  }

  /** Reports the session's counts (never content) and sends what is left to report. */
  async close(): Promise<void> {
    this.agent.reporter.add({
      type: "session.stats",
      conversationId: this.id,
      turns: this.#entries.filter((e) => e.type === EntryTypes.turnEnd).length,
      compactions: this.#entries.filter((e) => e.type === EntryTypes.compaction).length,
    });
    await this.agent.flush();
  }

  /** @internal */
  writeStart(): Promise<void> {
    return this.#append(EntryTypes.sessionStart, null, {
      agent: this.agent.slug,
      agent_version: this.agent.profile.version,
      tool_mode: this.toolMode,
    });
  }

  /** The mode a session was last in. */
  static lastMode(entries: readonly TranscriptEntry[]): ToolMode | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === EntryTypes.turnStart || e.type === EntryTypes.sessionStart) {
        // Never Bypass: a switch-on never comes back from the transcript (sdk/09 L-58).
        const mode = parseToolMode(str(e.data, "tool_mode"));
        if (mode && mode !== "bypass") return mode;
      }
    }
    return undefined;
  }

  /** Adds an entry to the transcript and the store. A stopped turn is still recorded. */
  async #append(type: string, turnId: string | null, data: Data, status: string | null = null): Promise<void> {
    const entry: TranscriptEntry = {
      id: newId(),
      parentId: this.#entries.length ? this.#entries[this.#entries.length - 1]!.id : null,
      timestamp: new Date().toISOString(),
      type,
      turnId,
      status,
      data: JSON.parse(JSON.stringify(data)) as Data,
    };
    await this.agent.sessionStore.append(this.agent.slug, this.id, entry);
    this.#entries.push(entry);
  }
}

/** How a call that needed approval was settled. */
interface Settled {
  scope?: ApprovalScope;
  grantId?: string;
  coveredGrantId?: string;
  approved: boolean;
  /** Nobody answered in time. */
  timedOut: boolean;
  /** How long the user took; undefined when nobody was asked. */
  waitedMs: number | undefined;
  /** The user's reason for declining. */
  reason: string | undefined;
}

interface PreparedHostPolicy {
  decision: HostToolDecision;
  inputJson: string;
  controlsJson: string;
}

/** One turn: the loop of model calls and tool runs, and its record. */
class Turn {
  readonly #session: AgentSession;
  readonly #id: string;
  readonly #emit: (event: AgentEvent) => void;
  readonly #access: SessionAccess;
  readonly #notices: GovernanceNotice[] = [];
  // The gateway's words on the round's calls, kept until the round's calls are planned (the call ids may be empty or shared).
  #denials: Aim[] = [];
  #marks: { aim: Aim; mark: GatewayMark }[] = [];
  /** Tools the gateway hides in this turn's tool mode (`faden.tool_mode`): refused here too. */
  readonly #hidden = new Set<string>();
  readonly #grantUsed = new Map<string, { grantId: string; toolName: string }>();
  readonly #receipts: ReceiptNote[] = [];
  #text = "";
  #usage: Usage | undefined;
  #blocked: GovernanceNotice | undefined;
  #toolDenied = false;
  #mode: ToolMode = "ask";
  #skills: string[] = [];
  #commandOrigin: "user_command" | "user_history" | undefined;
  #commandInputJson: string | undefined;
  // The conversation's Bypass grant as the turn began, the calls of the app's tools it ran without the person's answer
  // (L-61), and whether the conversation's Bypass ended since its last turn (the model is told).
  #bypassGrant: string | undefined;
  readonly #bypassRan: string[] = [];
  #bypassEnded = false;
  // What this turn asks the model to think, fixed when it starts: a change of the level applies from the next message.
  #effort: ReasoningEffort | undefined;

  /** The Bypass grant the turn ran under; undefined when it did not run in Bypass. */
  get bypassGrant(): string | undefined {
    return this.#bypassGrant;
  }

  /** The calls of the app's own tools the turn ran in Bypass without the person's answer. */
  get bypassRan(): readonly string[] {
    return this.#bypassRan;
  }

  constructor(session: AgentSession, id: string, emit: (event: AgentEvent) => void, access: SessionAccess) {
    this.#session = session;
    this.#id = id;
    this.#emit = emit;
    this.#access = access;
  }

  get #agent(): FadenstackAgent {
    return this.#session.agent;
  }

  async runCommand(name: string, args: Record<string, unknown>, origin: "user_command" | "user_history", signal: AbortSignal, label?: string): Promise<void> {
    await this.#agent.refreshTools(signal);
    this.#mode = this.#session.effectiveToolMode;
    this.#commandOrigin = origin;
    this.#commandInputJson = commandJson(args);
    await this.#access.append(EntryTypes.userCommand, this.#id, { name, origin, ...(label ? { label } : {}) });
    await this.#access.append(EntryTypes.turnStart, this.#id, { tool_mode: this.#session.toolMode, effective_tool_mode: this.#mode, origin });
    this.#emit({ type: "turn_started", turnId: this.#id, toolMode: this.#mode });
    try {
      signal.throwIfAborted();
      const tool = this.#agent.find(name);
      if (tool && tool.source !== "host") throw new Error("Explicit commands are available for host tools only.");
      await this.#runTool({ call: { id: newId(), name, arguments: args, argumentsJson: commandJson(args) },
        denied: false, hidden: false, mark: undefined }, signal);
      await this.#end(TurnStatus.ok, this.#toolDenied ? "tool_denied" : "completed");
    } catch (error) {
      await this.#end(signal.aborted ? TurnStatus.cancelled : TurnStatus.error, undefined);
      throw signal.aborted ? signal.reason ?? error : error;
    }
  }

  async run(message: string, attachments: readonly MessageAttachment[], skills: readonly PickedSkill[], signal: AbortSignal): Promise<void> {
    await Promise.resolve(); // the caller gets the stream before the first request goes out
    await this.#agent.refreshTools(signal); // tools that changed since the last turn, never inside one
    await this.#session.settleBypass(signal);
    this.#mode = this.#session.effectiveToolMode;
    this.#effort = this.#session.requestEffort;
    this.#bypassGrant = this.#mode === "bypass" ? this.#session.bypass?.id : undefined;
    // The last turn ran in Bypass and this one does not: the model hears it ended (from the transcript, so an app started
    // again tells it too).
    this.#bypassEnded = this.#mode !== "bypass" && this.#session.lastTurnRanInBypass();
    this.#skills = [...new Set(skills.map((s) => s.slug).filter(Boolean))];
    const user: Data = { text: message };
    if (attachments.length) user["attachments"] = attachments.map(attachmentData);
    if (skills.length) user["skills"] = skills.map((s) => ({ slug: s.slug, name: s.name ?? s.slug }));
    await this.#access.append(EntryTypes.userMessage, this.#id, user);
    await this.#access.append(EntryTypes.turnStart, this.#id, {
      tool_mode: this.#session.toolMode,
      effective_tool_mode: this.#mode,
      reasoning_effort: reasoningRecord(this.#effort),
    });
    this.#emit({ type: "turn_started", turnId: this.#id, toolMode: this.#mode });
    try {
      for (let round = 0; ; round++) {
        if (round === this.#agent.settings.maxRounds) {
          await this.#notice({ outcome: "round_limit", stage: "tool", message: `Stopped after ${round} rounds of tool calls.` });
          break;
        }
        signal.throwIfAborted();
        const calls = await this.#request(signal, round);
        if (this.#blocked || calls.length === 0) break;
        for (const planned of calls) await this.#runTool(planned, signal);
      }
    } catch (error) {
      if (signal.aborted) {
        await this.#end(TurnStatus.cancelled, undefined);
        throw signal.reason ?? error;
      }
      if (error instanceof FadenstackRateLimitedError) {
        const notice: GovernanceNotice = { outcome: "rate_limited", message: error.message };
        if (error.retryAfterMs !== undefined) notice.retryAfterMs = error.retryAfterMs;
        await this.#notice(notice);
        await this.#end(TurnStatus.error, "rate_limited");
        return;
      }
      await this.#end(TurnStatus.error, undefined);
      throw error;
    }
    const status = this.#blocked === undefined ? TurnStatus.ok
      : this.#blocked.outcome === "prompt_blocked" ? TurnStatus.promptBlocked : TurnStatus.responseBlocked;
    const outcome: ChatOutcome = status === TurnStatus.promptBlocked ? "prompt_blocked"
      : status === TurnStatus.responseBlocked ? "response_blocked"
      : this.#toolDenied ? "tool_denied" : "completed";
    await this.#end(status, outcome);
  }

  /** One model call; returns the calls of the agent's own tools to run. */
  async #request(signal: AbortSignal, round: number): Promise<PlannedCall[]> {
    // The gateway's word on a call holds for its round only: a later call with the same id is judged anew.
    this.#grantUsed.clear();
    this.#marks = [];
    this.#denials = [];
    const options: ChatOptions = {
      conversationId: this.#session.id,
      turnId: this.#id,
      toolMode: this.#mode,
      signal,
    };
    const tools = this.#agent.offer(this.#mode, this.#session);
    if (tools.length) options.tools = tools;
    // On every call of the turn, not the first only: the gateway gives a request the skills it names.
    if (this.#skills.length) options.skills = this.#skills;
    if (this.#effort) options.reasoningEffort = this.#effort;
    let text = "";
    let finish: FinishReason | undefined;
    const calls: ToolCall[] = [];
    const receipts: ReceiptNote[] = [];
    const history = this.#session.history;
    if (this.#bypassEnded) {
      // Before the person's newest message, every round of this turn: what the model may and may not do now.
      const newest = history.map((m) => m.role).lastIndexOf("user");
      history.splice(Math.max(0, newest), 0, { role: "system", content: BYPASS_ENDED_NOTE });
    }
    for await (const update of this.#agent.settings.chat.stream(history, options)) {
      switch (update.type) {
        case "text":
          text += update.text;
          this.#emit({ type: "text", turnId: this.#id, text: update.text });
          break;
        case "reasoning":
          this.#emit({ type: "reasoning", turnId: this.#id, text: update.text });
          break;
        case "tool_calls":
          calls.push(...update.calls);
          break;
        case "usage":
          this.#addUsage(update.usage);
          break;
        case "refused":
          this.#blocked = update.notice;
          break;
        case "event":
          await this.#onGatewayEvent(update.event, signal);
          break;
        case "receipt":
          receipts.push(update.receipt);
          break;
        case "finish":
          finish = update.reason;
          if (update.reason === "content_filter" && !this.#blocked) {
            this.#blocked = { outcome: "response_blocked", stage: "output", message: "The answer was stopped." };
          }
          break;
      }
    }
    if (this.#blocked) calls.length = 0; // a refused answer's tool calls never run
    const planned = this.#plan(calls, round);
    this.#text += text;
    this.#receipts.push(...receipts);
    if (text || calls.length) {
      await this.#access.append(EntryTypes.assistantMessage, this.#id, {
        text,
        tool_calls: planned.map((p) => ({ id: p.call.id, name: p.call.name, arguments: p.call.argumentsJson || "{}" })),
        origin: "model",
        // What made the answer, by the receipts' ids: never more of them than that.
        ...(receipts.length ? { receipts: receipts.map(receiptData) } : {}),
      });
    }
    if (this.#blocked) await this.#notice(this.#blocked);
    // A model that thought and then wrote nothing would leave the user with nothing at all on screen.
    else if (calls.length === 0 && isBlank(text) && !signal.aborted) await this.#notice(emptyAnswer(finish));
    return planned;
  }

  /**
   * The round's calls, each under an id of its own and with the gateway's word on it. A call with no id, or an id another call
   * of the round has, gets `fs-{turn}-{round}-{index}`. A word that cannot tell calls apart (no id, or one id on several
   * calls) covers every call of its tool: a refusal is never lost, and a mark asks (.NET `AgentSession.Plan`).
   */
  #plan(calls: readonly ToolCall[], round: number): PlannedCall[] {
    const model = calls.map((call, i) => ({ call, modelId: call.id, index: call.index ?? i }));
    const denied = model.map(() => false);
    const marks: (GatewayMark | undefined)[] = model.map(() => undefined);
    for (const aim of this.#denials) for (const i of aimed(aim, model).places) denied[i] = true;
    for (const { aim, mark } of this.#marks) {
      const { places, byName } = aimed(aim, model);
      for (const i of places) {
        const word = byName ? { ...mark, rule: true } : mark;
        const earlier = marks[i];
        marks[i] = earlier ? mergeMarks(earlier, word) : word;
      }
    }
    return model.map((c, i) => {
      const shared = c.modelId === "" || model.filter((o) => o.modelId === c.modelId).length > 1;
      const call: ToolCall = shared ? { ...c.call, id: `fs-${this.#id}-${round}-${c.index}` } : c.call;
      const hidden = this.#hidden.has(c.call.name);
      return { call, denied: denied[i]! || hidden, hidden, mark: marks[i] };
    });
  }

  async #onGatewayEvent(event: FadenstackEvent, signal: AbortSignal): Promise<void> {
    const value = event.value;
    switch (eventKind(event)) {
      case "faden.grants":
        this.#agent.grants.snapshot(value);
        break;
      case "faden.grant_used": {
        const callId = str(value, "toolCallId"), toolName = str(value, "toolCallName"), grantId = str(value, "grantId");
        if (callId && toolName && grantId) this.#grantUsed.set(callId, { grantId, toolName });
        break;
      }
      case "faden.gateway_round":
        await this.#keepRound(value);
        break;
      case "faden.approval_required":
        // With an approvalId the gateway runs the tool and waits for the answer; without, the call is one of the
        // agent's own tools, which the session asks about as the gateway says.
        if (str(value, "approvalId")) await this.#answerGatewayApproval(value, signal);
        else this.#mark(value);
        break;
      case "faden.tool_denied": {
        this.#toolDenied = true;
        this.#denials.push(aimOf(value));
        const notice: GovernanceNotice = {
          outcome: "tool_denied",
          stage: "tool",
          message: str(value, "message") ?? `'${str(value, "toolCallName") ?? "A tool"}' is not allowed here.`,
        };
        const decision = str(value, "decisionId");
        if (decision) notice.decisionId = decision;
        await this.#notice(notice);
        break;
      }
      case "faden.governance":
        // A refusal arrives as a `refused` update; any other outcome only informs, and the turn goes on.
        if (value && typeof value === "object" && !isRefusal(str(value, "outcome"))) await this.#notice(readNotice(value));
        break;
      case "faden.tool_mode":
        this.#followToolMode(value);
        break;
      case "TOOL_CALL_START":
        this.#emit({
          type: "tool_started", turnId: this.#id, callId: str(event.raw, "toolCallId") ?? "",
          name: str(event.raw, "toolCallName") ?? "", toolClass: "read", source: "gateway", arguments: {},
        });
        break;
      case "TOOL_CALL_END":
        this.#emit({
          type: "tool_completed", turnId: this.#id, callId: str(event.raw, "toolCallId") ?? "",
          name: str(event.raw, "toolCallName") ?? "", source: "gateway", outcome: event.raw["error"] === true ? "error" : "ok",
          result: undefined, durationMs: typeof event.raw["durationMs"] === "number" ? (event.raw["durationMs"] as number) : 0,
        });
        break;
    }
    this.#emit({ type: "gateway_event", turnId: this.#id, event });
  }

  /** The gateway's own tool round, kept so the model still knows what it searched. */
  async #keepRound(value: unknown): Promise<void> {
    const messages = value && typeof value === "object" ? (value as Data)["messages"] : undefined;
    if (!Array.isArray(messages)) return;
    const names = new Map<string, string>();
    for (const m of messages as Data[]) {
      const role = str(m, "role");
      if (role === "assistant") {
        const calls = (Array.isArray(m["tool_calls"]) ? (m["tool_calls"] as Data[]) : []).map((c) => {
          const id = str(c, "id") ?? "";
          const name = str(c["function"], "name") ?? "";
          names.set(id, name);
          return { id, name, arguments: str(c["function"], "arguments") ?? "{}" };
        });
        await this.#access.append(EntryTypes.assistantMessage, this.#id, { text: str(m, "content") ?? "", tool_calls: calls, origin: "gateway" });
      } else if (role === "tool") {
        const callId = str(m, "tool_call_id") ?? "";
        await this.#access.append(EntryTypes.toolComplete, this.#id, {
          call_id: callId, name: names.get(callId) ?? null, source: "gateway", result: str(m, "content") ?? "", origin: "gateway",
        });
      }
    }
  }

  /**
   * A gateway tool held for the user: ask, and answer the gateway while it waits. Bypass never answers here: the gateway
   * runs the tool, and only the server may skip its question.
   */
  async #answerGatewayApproval(value: unknown, signal: AbortSignal): Promise<void> {
    const approvalId = str(value, "approvalId");
    if (!approvalId) return;
    const request: ApprovalRequest = {
      callId: str(value, "toolCallId") ?? "",
      toolName: str(value, "toolCallName") ?? "",
      toolClass: parseToolClass(str(value, "toolClass")),
      source: "gateway",
      reason: str(value, "message") ?? "",
      arguments: {},
    };
    const timeoutS = (value as Data)["timeoutS"];
    // A gateway that does not say whether a rule asks is taken as one: it asks every time.
    const rule = (value as Data)["rule"] !== false;
    const settled = await this.#approve(request, rule, typeof timeoutS === "number" ? timeoutS * 1000 : 5 * 60_000, signal,
      undefined, false, true);
    if (settled.timedOut) return; // the gateway expires it on its own
    const scope = settled.scope === "chat" || settled.scope === "always" ? settled.scope : "once";
    await this.#agent.client.agent!.answerApproval(approvalId, settled.approved, scope, signal);
    if (!settled.approved) this.#toolDenied = true;
  }

  /** The gateway's word on a call of the agent's own tool, kept until the round's calls are planned. */
  #mark(value: unknown): void {
    const toolClass = str(value, "toolClass");
    this.#marks.push({ aim: aimOf(value), mark: {
      rule: (value as Data)["rule"] !== false,
      toolClass: toolClass === undefined ? undefined : parseToolClass(toolClass),
      message: str(value, "message") ?? "",
    } });
  }

  /**
   * The gateway's tool mode for this turn: the turn's mode is never widened by it, an unknown mode is ignored, and the tools
   * it hides are refused here too.
   */
  #followToolMode(value: unknown): void {
    const effective = parseToolMode(str(value, "effective_tool_mode"));
    if (effective) this.#mode = narrowestMode(this.#mode, effective);
    const hidden = value && typeof value === "object" ? (value as Data)["hidden"] : undefined;
    if (Array.isArray(hidden)) for (const name of hidden) if (typeof name === "string") this.#hidden.add(name);
  }

  async #runTool(planned: PlannedCall, signal: AbortSignal): Promise<void> {
    const { call, mark } = planned;
    const tool = this.#agent.find(call.name);
    const source = tool?.source ?? "host";
    const toolClass: ToolClass = tool ? stricterClass(tool.toolClass, mark?.toolClass) : "unknown";
    const args = call.arguments ?? {};
    await this.#access.append(EntryTypes.toolStart, this.#id, { call_id: call.id, name: call.name, source, tool_class: toolClass });
    this.#emit({ type: "tool_started", turnId: this.#id, callId: call.id, name: call.name, toolClass, source, arguments: args });
    const started = performance.now();
    let result: string;
    let outcome: ToolOutcome;
    let waited = 0;
    // Asked once, and only for a call that would run: a tool the scope has not switched on answers instead of running.
    const answered = tool && !planned.denied && call.argumentsError === undefined && !this.#commandOrigin
      ? tool.scope?.beforeCall(tool, this.#session) : undefined;
    if (!tool) {
      [result, outcome] = [this.#agent.isGone(call.name) ? `${call.name} is no longer available.` : `Tool '${call.name}' does not exist here.`, "error"];
    } else if (planned.denied) {
      if (planned.hidden) {
        this.#toolDenied = true;
        await this.#notice({ outcome: "tool_denied", stage: "tool", category: "mode",
          message: `'${call.name}' is not allowed: the gateway hides it in this tool mode.` });
      }
      [result, outcome] = [`Tool '${call.name}' is not allowed here.`, "denied"];
    } else if (call.argumentsError !== undefined) {
      [result, outcome] = [`Error: the arguments are not valid JSON (${call.argumentsError}).`, "error"];
    } else if (answered !== undefined) {
      [result, outcome] = [answered, "ok"]; // a tool outside the conversation's scope, now switched on
    } else {
      ({ result, outcome, waited } = await this.#decideAndRun(tool, toolClass, mark, call, args, signal));
    }
    // The tool's own time: the user's time on the approval card is reported apart (approval.decided).
    const ran = Math.max(0, performance.now() - started - waited);
    await this.#access.append(EntryTypes.toolComplete, this.#id, {
      call_id: call.id, name: call.name, source, result, outcome, duration_ms: Math.round(ran), origin: "client",
    });
    this.#emit({ type: "tool_completed", turnId: this.#id, callId: call.id, name: call.name, source, outcome, result, durationMs: ran });
    if (tool) {
      this.#agent.reporter.add({
        type: "tool.executed", conversationId: this.#session.id, tool: call.name,
        source: source === "mcp" ? "mcp" : "host", durationMs: ran, outcome,
        ...(tool.server !== undefined ? { server: tool.server } : {}),
      });
    }
  }

  /**
   * Asks if the mode or an admin's rule says so, then runs the tool; also returns how long the asking took.
   * `toolClass` is the stricter of the tool's own and the gateway's.
   */
  async #decideAndRun(tool: AgentTool, toolClass: ToolClass, mark: GatewayMark | undefined, call: ToolCall,
    args: Record<string, unknown>, signal: AbortSignal): Promise<{ result: string; outcome: ToolOutcome; waited: number }> {
    let policy: PreparedHostPolicy | undefined;
    if (!this.#commandOrigin && tool.source === "host" && this.#agent.hostToolPolicyChecks) {
      try {
        await this.#agent.refreshPolicy(signal);
        const inputJson = commandJson(args);
        const decision = await this.#agent.client.agent!.checkHostTool({ name: tool.name, arguments: JSON.parse(inputJson) as Record<string, unknown>,
          origin: "model_tool", callId: call.id, phase: "prepare", toolMode: narrowestMode(this.#mode, this.#session.effectiveToolMode),
          schemaSha256: await commandSchemaHash(tool.parameters), conversationId: this.#session.id, turnId: this.#id }, signal);
        if (!this.#agent.profile.principal || commandJson(decision.principal) !== commandJson(this.#agent.profile.principal))
          throw new Error("The host call's authenticated identity changed.");
        if (decision.decision === "deny") {
          this.#toolDenied = true;
          await this.#notice({ outcome: "tool_denied", stage: "tool", message: decision.message });
          return { result: decision.message, outcome: "denied", waited: 0 };
        }
        policy = { decision, inputJson, controlsJson: this.#approvalControlsJson() };
        toolClass = stricterClass(toolClass, decision.toolClass);
        this.#mode = narrowestMode(narrowestMode(this.#mode, this.#session.effectiveToolMode), decision.effectiveToolMode);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        return { result: `Error: ${error instanceof Error ? error.message : String(error)}`, outcome: "error", waited: 0 };
      }
    }
    const contractApproval = this.#agent.profile.hostToolContract.find(entry => entry.name === tool.name)?.approval;
    const decision = decideTool(this.#mode, toolClass, contractApproval);
    if (decision === "hidden") {
      this.#toolDenied = true;
      const why = `the tool mode is ${this.#mode}`;
      await this.#notice({ outcome: "tool_denied", stage: "tool", category: "mode", message: `'${tool.name}' is not allowed: ${why}.` });
      return { result: `Tool '${tool.name}' is not allowed here: ${why}.`, outcome: "denied", waited: 0 };
    }
    const invalid = checkArguments(tool.parameters, args);
    if (invalid) return { result: `Error: ${invalid}`, outcome: "error", waited: 0 };
    let waited = 0;
    const rule = mark?.rule === true || contractApproval === "always" || policy?.decision.requiredByRule === true;
    let coverage: { id: string; call: GrantCall } | undefined;
    // In Bypass the device reports what ran without the person's answer, as the gateway records it (L-61): what the mode ran,
    // and what the turn's own Bypass grant settled. A call the person answered is recorded as an answer (L-60); one a time or
    // work grant settled belongs to that grant.
    let unanswered = true;
    if (!this.#commandOrigin && (rule || decision === "ask" || policy?.decision.decision === "ask")) {
      const settled = await this.#approve({
        callId: call.id,
        toolName: tool.name,
        toolClass,
        source: tool.source,
        reason: rule ? mark?.message ?? "This tool requires individual approval."
          : toolClass === "unknown" ? "Nobody has said what this tool does."
          : `'${tool.name}' is ${toolClass}; the tool mode is ${this.#mode}.`,
        arguments: args,
        ...(tool.openWorld ? { openWorld: true } : {}),
      }, rule, undefined, signal, tool.describe ? () => describeTarget(tool, args, signal) : undefined);
      waited = settled.waitedMs ?? 0;
      unanswered = settled.scope === "grant" && settled.grantId !== undefined && settled.grantId === this.#bypassGrant;
      if (settled.coveredGrantId) coverage = { id: settled.coveredGrantId, call: this.#grantCall({ callId: call.id,
        toolName: tool.name, toolClass, arguments: args, requiredByRule: rule }) };
      if (!settled.approved) {
        this.#toolDenied = true;
        const reason = settled.reason ? ` (${settled.reason})` : "";
        return { result: `The user declined to run '${tool.name}'${reason}.`, outcome: "denied", waited };
      }
    }
    try {
      const services = this.#services(tool, toolClass, call.id, args, signal);
      const invocation: ToolInvocation = {
        tool,
        arguments: { ...args },
        toolClass,
        context: { signal, callId: call.id, sessionId: this.#session.id, turnId: this.#id, services },
      };
      if (this.#bypassGrant !== undefined && unanswered) this.#bypassRan.push(call.id); // it runs: the device reports it, whatever it returns
      const value = await this.#invoker(services, policy, coverage)(invocation);
      return { result: resultText(value), outcome: "ok", waited };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof CommandDenied) return { result: error.message, outcome: "denied", waited };
      return { result: `Error: ${error instanceof Error ? error.message : String(error)}`, outcome: "error", waited };
    }
  }

  /** The services modules give this call, each made on first use. */
  #services(tool: AgentTool, toolClass: ToolClass, callId: string, args: Record<string, unknown>, signal: AbortSignal): CallServices {
    const append = this.#access.append;
    const turnId = this.#id;
    return new CallServices(this.#agent.settings.toolServices, {
      tool, toolClass, arguments: Object.freeze({ ...args }), callId, sessionId: this.#session.id, turnId, signal,
      agent: this.#agent.context,
      record: async (type, data) => {
        if (CORE_ENTRY_TYPES.has(type) || !MODULE_ENTRY_TYPE.test(type)) {
          throw new TypeError(`A module's transcript entry is its own type, such as 'provenance.placed': not '${type}'.`);
        }
        await append(type, turnId, data);
      },
      notice: (notice) => this.#notice(notice),
    });
  }

  #invoker(services: CallServices, policy?: PreparedHostPolicy, coverage?: { id: string; call: GrantCall }): ToolInvoker {
    let invoker: ToolInvoker = async (i) => {
      if (this.#commandOrigin) return this.#invokeCommand(i, () => services.ran(i.arguments));
      if (coverage && !await this.#agent.grants.covers(coverage.id, { ...coverage.call, arguments: i.arguments }, i.context.signal, true))
        throw new Error("The server-held grant changed or no longer covers this call. Review a new call.");
      if (policy) await this.#checkHostDispatch(i, policy);
      services.ran(i.arguments); // the arguments the tool gets, after the stages that change them
      return i.tool.invoke(i.arguments, i.context);
    };
    const stages = this.#agent.settings.toolStages;
    for (let s = stages.length - 1; s >= 0; s--) {
      const stage = stages[s]!;
      const next = invoker;
      invoker = (i) => stage.invoke(i, next);
    }
    return invoker;
  }

  #approvalControlsJson(): string {
    return commandJson({ modes: this.#agent.profile.toolModes, approvals: this.#agent.profile.approvals ?? null });
  }

  /** No transformed local values are sent to a new cloud endpoint; native proposals retain their own final binding. */
  async #checkHostDispatch(invocation: ToolInvocation, policy: PreparedHostPolicy): Promise<void> {
    const signal = invocation.context.signal;
    signal.throwIfAborted();
    if (commandJson(invocation.arguments) !== policy.inputJson)
      throw new Error("Host arguments changed after policy review. Transformed host arguments require a reviewed disclosure contract.");
    await this.#agent.refreshPolicy(signal);
    if (this.#approvalControlsJson() !== policy.controlsJson) throw new Error("Approval limits changed. Review a new host call.");
    const checked = await this.#agent.client.agent!.checkHostTool({ name: invocation.tool.name,
      arguments: JSON.parse(policy.inputJson) as Record<string, unknown>, origin: "model_tool", callId: invocation.context.callId,
      phase: "dispatch", prepared: policy.decision, toolMode: narrowestMode(this.#mode, this.#session.effectiveToolMode),
      schemaSha256: await commandSchemaHash(invocation.tool.parameters), conversationId: this.#session.id, turnId: this.#id }, signal);
    const before = policy.decision;
    if (checked.decision === "deny" || checked.profileStamp !== before.profileStamp || checked.argumentsStamp !== before.argumentsStamp
      || checked.decisionStamp !== before.decisionStamp || commandJson(checked.principal) !== commandJson(before.principal)
      || commandJson(checked.principal) !== commandJson(this.#agent.profile.principal))
      throw new Error("The host call's identity or central policy changed. Review it again.");
    signal.throwIfAborted();
    if (commandJson(invocation.arguments) !== policy.inputJson) throw new Error("Host arguments changed after approval.");
  }

  /** The final stage arguments are reviewed, then checked again immediately before the native tool runs. */
  async #invokeCommand(invocation: ToolInvocation, dispatching: () => void): Promise<unknown> {
    const signal = invocation.context.signal;
    signal.throwIfAborted();
    const serialized = commandJson(invocation.arguments);
    // A transformation such as local PII unmasking must not disclose raw values
    // through a new policy endpoint. Such command/module combinations need their
    // own verified disclosure contract; ordinary chat keeps its existing path.
    if (serialized !== this.#commandInputJson) throw new Error("Transformed direct-command arguments are not supported. Use the normal governed conversation.");
    const args = JSON.parse(serialized) as Record<string, unknown>;
    const invalid = checkArguments(invocation.tool.parameters, args);
    if (invalid) throw new Error(invalid);
    const base = { name: invocation.tool.name, arguments: args, toolMode: this.#mode,
      schemaSha256: await commandSchemaHash(invocation.tool.parameters), origin: this.#commandOrigin!,
      conversationId: this.#session.id, turnId: this.#id };
    const resource = this.#agent.client.agent!;
    const prepared = await resource.checkHostTool({ ...base, phase: "prepare" }, signal);
    if (!this.#agent.profile.principal || commandJson(prepared.principal) !== commandJson(this.#agent.profile.principal)) {
      throw new Error("The command's authenticated identity does not match the active agent profile.");
    }
    const toolClass = stricterClass(invocation.toolClass, prepared.toolClass);
    const mode = narrowestMode(this.#mode, prepared.effectiveToolMode);
    const decision = decideTool(mode, toolClass);
    if (prepared.decision === "deny" || decision === "hidden") {
      this.#toolDenied = true;
      await this.#notice({ outcome: "tool_denied", stage: "tool", message: prepared.message });
      throw new CommandDenied(prepared.message);
    }
    if (prepared.decision === "ask" || decision === "ask") {
      const settled = await this.#approve({ callId: invocation.context.callId,
        toolName: invocation.tool.name, toolClass, source: "host", reason: prepared.message,
        arguments: freezeCommand(JSON.parse(serialized) as Record<string, unknown>),
      }, prepared.requiredByRule, undefined, signal,
      invocation.tool.describe ? () => describeTarget(invocation.tool, args, signal) : undefined, true);
      if (!settled.approved) {
        this.#toolDenied = true;
        throw new CommandDenied(`The user declined to run '${invocation.tool.name}'.`);
      }
    }
    if (commandJson(invocation.arguments) !== serialized) throw new Error("The command changed after review.");
    const checked = await resource.checkHostTool({ ...base, phase: "dispatch", prepared }, signal);
    if (checked.decision === "deny" || checked.profileStamp !== prepared.profileStamp
      || checked.argumentsStamp !== prepared.argumentsStamp || checked.decisionStamp !== prepared.decisionStamp
      || commandJson(checked.principal) !== commandJson(prepared.principal)) {
      throw new Error("The command's identity or policy changed. Review it again.");
    }
    signal.throwIfAborted();
    if (commandJson(invocation.arguments) !== serialized) throw new Error("The command changed after review.");
    dispatching();
    return invocation.tool.invoke(JSON.parse(serialized) as Record<string, unknown>, invocation.context);
  }

  /**
   * Settles a call that needs approval, first that applies: an admin's rule asks (once only, even in bypass);
   * bypass mode approves; a destructive or unclassified tool asks (once only); what the user allowed always, then
   * what they allowed for this chat, approves; else the user is asked, and may allow once, for this chat or always.
   * Every outcome goes in the transcript and the server's record, with what let the call through. `target` is read
   * only when the user is asked: what the call acts on, for the card.
   */
  async #approve(base: ApprovalRequest, rule: boolean, timeoutMs: number | undefined, signal: AbortSignal,
    target?: () => Promise<string | undefined>, individual = false, gatewayWait = false): Promise<Settled> {
    // Every request names its session and turn: a screen with several chats hands it to the one that owns it.
    base = { ...base, sessionId: this.#session.id, turnId: this.#id };
    const { toolName: name, toolClass } = base;
    const open = !individual && !rule && !asksEveryTime(toolClass);
    const allowed = (kind: "chat" | "always") => this.#agent.profile.approvals?.standing == null
      || this.#agent.profile.approvals.standing.includes(kind);
    const chatAllowed = open && allowed("chat"), alwaysAllowed = open && allowed("always");
    // A grant the gateway said covers the call (the first line) and the server's current grant holds for it (the second). A
    // destructive or unclassified call only under the conversation's Bypass grant while the turn runs in Bypass; a person's
    // own command, an admin's rule and a tool that asks every time never.
    const marked = this.#grantUsed.get(base.callId);
    let verdict: GrantVerdict = { covered: false };
    if (!rule && !individual && marked?.toolName === name && (!asksEveryTime(toolClass) || this.#mode === "bypass")) {
      verdict = await this.#agent.grants.check(marked.grantId, this.#grantCall({ ...base, requiredByRule: rule }, gatewayWait), signal);
    }
    if (verdict.covered && marked) {
      await this.#record(base, { approved: true, scope: "grant", asked: false, rule, timedOut: false, waitedMs: undefined, grantId: marked.grantId });
      return { approved: true, scope: "grant", grantId: marked.grantId, coveredGrantId: marked.grantId,
        timedOut: false, waitedMs: undefined, reason: undefined };
    }
    const leadsOutside = verdict.leadsOutside;
    // No standing approval in bypass mode: the app's Bypass is the server's (a second sign-in), never a local yes.
    const standing: ApprovalScope | undefined = rule || individual || !open ? undefined
      : alwaysAllowed && (await this.#approvedAlways(name, toolClass)) ? "always"
      : chatAllowed && this.#access.approved.has(name) ? "chat"
      : undefined;
    if (standing) {
      await this.#record(base, { approved: true, scope: standing, asked: false, rule, timedOut: false, waitedMs: undefined });
      return { approved: true, scope: standing, timedOut: false, waitedMs: undefined, reason: undefined };
    }
    const described = target ? await target() : undefined;
    const grantDurations = open && this.#agent.grants.offers("time") && ["read", "write"].includes(toolClass)
      && this.#agent.profile.approvals!.grantClasses.includes(toolClass as "read" | "write") ? this.#agent.grants.choices : [];
    const request: ApprovalRequest = {
      ...base, canAllowForSession: chatAllowed, canAllowAlways: alwaysAllowed,
      ...(grantDurations.length ? { grantDurations } : {}), ...(rule ? { requiredByRule: true } : {}), ...(described ? { target: described } : {}),
      ...(leadsOutside !== undefined ? { leadsOutside } : {}),
    };
    this.#emit({ type: "approval_requested", turnId: this.#id, request });
    const limit = timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const started = performance.now();
    let decision: ApprovalDecision | undefined;
    try {
      // Raced against the signal: a handler that ignores it cannot hold a stopped or timed-out turn.
      decision = await untilAborted((this.#session.approvals ?? this.#agent.settings.approvals).request(request, limit), limit);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (!limit.aborted) throw error;
      decision = undefined; // the time ran out
    }
    const waitedMs = performance.now() - started;
    // What the request offered, and nothing more: a handler cannot widen it.
    let scope: ApprovalScope | undefined = !decision?.approved ? undefined
      : decision.forTime !== undefined && grantDurations.includes(decision.forTime) ? "grant"
      : decision.always && alwaysAllowed ? "always"
      : decision.forSession && chatAllowed ? "chat"
      : "once";
    let grantId: string | undefined;
    let confirmedMinutes: number | undefined;
    if (scope === "grant") {
      try {
        const grant = await untilAborted(this.#agent.grants.grantForTime(name, decision!.forTime!, undefined, undefined, signal), signal);
        grantId = grant.id;
        confirmedMinutes = Math.ceil(grant.remainingS / 60);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        scope = "once";
        await this.#notice({ outcome: "grant_failed", stage: "tool", message: "A time grant could not be confirmed. This call alone was allowed; inspect active grants before requesting another." });
      }
    }
    if (scope === "always" && !(await this.#keepAlways(name, toolClass))) scope = "once";
    if (scope === "chat") this.#access.approved.add(name);
    await this.#record(base, { approved: scope !== undefined, scope, asked: true, rule, timedOut: decision === undefined, waitedMs,
      ...(leadsOutside !== undefined ? { outsideGrant: true } : {}),
      ...(grantId ? { grantId } : {}),
      ...(scope === "grant" ? { grantMinutes: Math.round(decision!.forTime! / 60_000) } : {}),
      ...(confirmedMinutes !== undefined ? { confirmedMinutes } : {}) });
    const decided: ApprovalDecision = !decision ? ApprovalDecision.deny("No answer in time.")
      : scope === "always" ? ApprovalDecision.approveAlways()
      : scope === "chat" ? ApprovalDecision.approveForSession()
      : scope === "grant" ? ApprovalDecision.approveFor(confirmedMinutes! * 60_000)
      : scope === "once" ? ApprovalDecision.approve()
      : decision;
    this.#emit({ type: "approval_decided", turnId: this.#id, request, decision: decided });
    return { approved: scope !== undefined, scope, ...(grantId ? { grantId } : {}), timedOut: decision === undefined, waitedMs, reason: decision?.reason };
  }

  #grantCall(base: Pick<ApprovalRequest, "callId" | "toolName" | "toolClass" | "arguments" | "requiredByRule">, gateway = false): GrantCall {
    return { ...base, requiredByRule: base.requiredByRule === true, conversationId: this.#session.id, turnId: this.#id,
      inBypass: this.#mode === "bypass", gateway };
  }

  /** The approval's transcript entry, and the server's record of it (names only). */
  async #record(request: ApprovalRequest, how: {
    approved: boolean; scope: ApprovalScope | undefined; asked: boolean; rule: boolean; timedOut: boolean; waitedMs: number | undefined;
    grantId?: string; grantMinutes?: number; confirmedMinutes?: number; outsideGrant?: boolean;
  }): Promise<void> {
    await this.#access.append(EntryTypes.approvalDecision, this.#id, {
      call_id: request.callId,
      name: request.toolName,
      source: request.source,
      approved: how.approved,
      for_session: how.asked && how.scope === "chat",
      scope: how.scope ?? null,
      asked: how.asked,
      rule: how.rule,
      // A link or junction led the call's place out of the grant's places: the person was asked.
      outside_grant: how.outsideGrant === true,
      timed_out: how.timedOut,
      wait_ms: Math.round(how.waitedMs ?? 0),
      // The same keys as every SDK's (sdk/43 §6): the time the person picked, and what the server confirmed.
      ...(how.grantId ? { grant_id: how.grantId } : {}),
      ...(how.grantMinutes !== undefined ? { grant_minutes: how.grantMinutes } : {}),
      ...(how.confirmedMinutes !== undefined ? { grant_confirmed_minutes: how.confirmedMinutes } : {}),
    });
    this.#agent.reporter.add({
      type: "approval.decided", conversationId: this.#session.id, tool: request.toolName,
      decision: how.timedOut ? "timeout" : how.approved ? "approved" : "denied",
      ...(how.waitedMs !== undefined ? { waitMs: how.waitedMs } : {}),
      ...(how.scope ? { scope: how.scope } : {}),
      ...(how.grantId ? { grantId: how.grantId } : {}),
    });
  }

  async #approvedAlways(name: string, toolClass: ToolClass): Promise<boolean> {
    try {
      const kept = await this.#agent.approvalStore.list(this.#agent.slug);
      return kept.some((a) => a.tool === name && a.toolClass === toolClass);
    } catch {
      return false; // a store that cannot be read approves nothing
    }
  }

  async #keepAlways(name: string, toolClass: ToolClass): Promise<boolean> {
    try {
      await this.#agent.approvalStore.add(this.#agent.slug, { tool: name, toolClass, approvedAt: new Date().toISOString() });
      return true;
    } catch {
      return false; // not kept: this call runs, the next one asks
    }
  }

  async #notice(notice: GovernanceNotice): Promise<void> {
    this.#notices.push(notice);
    const data: Data = { outcome: notice.outcome, message: notice.message };
    if (notice.stage) data["stage"] = notice.stage;
    if (notice.category) data["category"] = notice.category;
    if (notice.decisionId) data["decision_id"] = notice.decisionId;
    if (notice.retryAfterMs !== undefined) data["retry_after_ms"] = notice.retryAfterMs;
    await this.#access.append(EntryTypes.governanceNotice, this.#id, data);
    this.#emit({ type: "notice", turnId: this.#id, notice });
  }

  async #end(status: string, outcome: ChatOutcome | undefined): Promise<void> {
    await this.#access.append(EntryTypes.turnEnd, this.#id, {
      status,
      outcome: outcome ?? null,
      usage: this.#usage
        ? { input_tokens: this.#usage.promptTokens, output_tokens: this.#usage.completionTokens, total_tokens: this.#usage.totalTokens }
        : null,
    }, status);
    if (outcome) {
      this.#emit({
        type: "turn_completed",
        turnId: this.#id,
        result: {
          turnId: this.#id, outcome, text: this.#text, notices: [...this.#notices], usage: this.#usage, receipts: [...this.#receipts],
        },
      });
    }
  }

  #addUsage(usage: Usage): void {
    this.#usage = this.#usage
      ? {
          promptTokens: this.#usage.promptTokens + usage.promptTokens,
          completionTokens: this.#usage.completionTokens + usage.completionTokens,
          totalTokens: this.#usage.totalTokens + usage.totalTokens,
        }
      : { ...usage };
  }
}

/**
 * What the model is told in the first request after a Bypass of its conversation ended (owner, 2026-11-09): it may say so; it
 * can never switch Bypass on -- only the person can, in the app (sdk/09 L-58).
 */
export const BYPASS_ENDED_NOTE =
  "Bypass has ended in this conversation: tools ask for the person's approval again, as the conversation's mode says. "
  + "You cannot switch Bypass on, and no tool does; only the person can, in the app.";

/** The longest of `choices` not above `picked`: a card cannot widen the offer. */
function within(picked: number, choices: readonly number[]): number {
  const fits = choices.filter((c) => c <= picked);
  return fits.length ? Math.max(...fits) : choices[0]!;
}

/** The SDK's own entry types, which a module cannot write. */
const CORE_ENTRY_TYPES: ReadonlySet<string> = new Set(Object.values(EntryTypes));
/** A module's entry type: its name, a dot, what happened (`provenance.placed`). */
const MODULE_ENTRY_TYPE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;

/**
 * The notice for a model call that ended with no text and no tool call (`empty_answer`); `length` when the model ran
 * out of tokens first, often while thinking. The UI says it in the user's language and offers to try again.
 */
function emptyAnswer(finish: FinishReason | undefined): GovernanceNotice {
  return finish === "length"
    ? { outcome: "empty_answer", stage: "output", category: "length", message: "The model used up its length before it wrote an answer." }
    : { outcome: "empty_answer", stage: "output", message: "The model ended without an answer." };
}

/** A receipt as the transcript keeps it: its id and whether it was signed, never the receipt. */
function receiptData(note: ReceiptNote): Data {
  return { receipt_id: receiptIdOf(note) ?? null, status: note.status, ...(note.status === "unsigned" ? { reason: note.reason } : {}) };
}

/** One call's services: each made by its module's factory on first use, then the same for the rest of the call. */
class CallServices implements ToolServices {
  readonly #factories: AgentSettingsFactories;
  readonly #made = new Map<ToolServiceKey<unknown>, unknown>();
  readonly #call: ToolServiceCall;
  #arguments: Readonly<Record<string, unknown>>;

  constructor(factories: AgentSettingsFactories, call: ToolServiceCall) {
    this.#factories = factories;
    this.#arguments = call.arguments;
    const self = this;
    this.#call = Object.freeze({
      ...call,
      get arguments() {
        return self.#arguments;
      },
    });
  }

  get<T>(key: ToolServiceKey<T>): T | undefined {
    if (this.#made.has(key)) return this.#made.get(key) as T;
    const factory = this.#factories.get(key);
    if (!factory) return undefined;
    const service = factory(this.#call);
    this.#made.set(key, service);
    return service as T;
  }

  /** The tool is about to run with these arguments. */
  ran(args: Record<string, unknown>): void {
    this.#arguments = Object.freeze({ ...args });
  }
}

type AgentSettingsFactories = FadenstackAgent["settings"]["toolServices"];

/**
 * A tool's result as the transcript and the tool card keep it: a string as it is, anything else as JSON, nothing as
 * "". The model gets `NO_TOOL_RESULT` for nothing (`toMessage`).
 */
export function resultText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** `promise`, or the signal's reason once it aborts. */
/** How long a tool may take to say what a call acts on before the card is shown without it. */
const DESCRIBE_TIMEOUT_MS = 3_000;
/** What the card shows of a target at most. */
const MAX_TARGET_CHARS = 300;

/**
 * What the call acts on, as the tool says (one line, clipped), or undefined: a tool that fails or takes too long only
 * leaves the card with the arguments. A stopped turn stops here too.
 */
async function describeTarget(tool: AgentTool, args: Record<string, unknown>, signal: AbortSignal): Promise<string | undefined> {
  const limit = AbortSignal.any([signal, AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)]);
  let text: string | undefined;
  try {
    text = await untilAborted(Promise.resolve().then(() => tool.describe!({ ...args }, limit)), limit);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return undefined;
  }
  const line = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!line) return undefined;
  return line.length > MAX_TARGET_CHARS ? `${line.slice(0, MAX_TARGET_CHARS - 1)}…` : line;
}

/** The places in the round a word of the gateway covers; `byName` when it could only go by the tool's name. */
function aimed(aim: Aim, round: readonly { call: ToolCall; modelId: string; index: number }[]): { places: number[]; byName: boolean } {
  const where = (match: (c: { call: ToolCall; modelId: string; index: number }) => boolean) =>
    round.map((c, i) => (match(c) ? i : -1)).filter((i) => i >= 0);
  if (aim.index !== undefined) return { places: where((c) => c.index === aim.index), byName: false };
  if (aim.callId !== "") {
    const same = where((c) => c.modelId === aim.callId);
    if (same.length <= 1) return { places: same, byName: false };
  }
  return { places: where((c) => aim.toolName === "" || c.call.name === aim.toolName), byName: true };
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(): Error {
  const error = new Error("The turn was stopped.");
  error.name = "AbortError";
  return error;
}
