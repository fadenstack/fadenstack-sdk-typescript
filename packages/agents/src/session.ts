import {
  FadenstackRateLimitedError,
  decideTool,
  eventKind,
  narrowestMode,
  parseToolClass,
  parseToolMode,
  receiptIdOf,
  type ChatMessage,
  type ChatOptions,
  type ChatOutcome,
  type FadenstackEvent,
  type FinishReason,
  type GovernanceNotice,
  type ReceiptNote,
  type ToolCall,
  type ToolClass,
  type ToolMode,
  type Usage,
} from "@fadenstack/client";

import type { FadenstackAgent } from "./agent.js";
import { ApprovalDecision, type ApprovalRequest, type ApprovalScope } from "./approvals.js";
import { attachmentData, type MessageAttachment } from "./attachments.js";
import { ContextBuilder, isBlank } from "./contextBuilder.js";
import { EventQueue } from "./eventQueue.js";
import type { AgentEvent, AgentResult, ToolOutcome } from "./events.js";
import type { ToolInvocation, ToolInvoker, ToolServiceCall } from "./stages.js";
import { checkArguments, type AgentTool, type ToolServiceKey, type ToolServices } from "./tools.js";
import { EntryTypes, TurnStatus, newId, type TranscriptEntry } from "./transcript.js";

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

/** The stricter of two classes; unclassified when either is. */
function stricterClass(own: ToolClass, other: ToolClass | undefined): ToolClass {
  if (!other || other === own) return own;
  if (own === "unknown" || other === "unknown") return "unknown";
  const rank: Record<ToolClass, number> = { read: 0, write: 1, destructive: 2, unknown: 3 };
  return rank[other] > rank[own] ? other : own;
}

/** Destructive and unclassified tools ask every time: never for the chat, never always. */
const asksEveryTime = (toolClass: ToolClass): boolean => toolClass === "destructive" || toolClass === "unknown";

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

  /** The mode turns run in: the user's pick, narrowed by the ceiling the server sets, if any. */
  get effectiveToolMode(): ToolMode {
    return narrowestMode(this.toolMode, this.agent.ceiling);
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

  /** Sends a message and waits for the turn to end. */
  async send(message: string, options: SendOptions = {}): Promise<AgentResult> {
    let result: AgentResult | undefined;
    for await (const event of this.stream(message, options)) {
      if (event.type === "turn_completed") result = event.result;
    }
    return result!;
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
        const mode = parseToolMode(str(e.data, "tool_mode"));
        if (mode) return mode;
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
    await this.agent.settings.sessions.append(this.agent.slug, this.id, entry);
    this.#entries.push(entry);
  }
}

/** How a call that needed approval was settled. */
interface Settled {
  approved: boolean;
  /** Nobody answered in time. */
  timedOut: boolean;
  /** How long the user took; undefined when nobody was asked. */
  waitedMs: number | undefined;
  /** The user's reason for declining. */
  reason: string | undefined;
}

/** One turn: the loop of model calls and tool runs, and its record. */
class Turn {
  readonly #session: AgentSession;
  readonly #id: string;
  readonly #emit: (event: AgentEvent) => void;
  readonly #access: SessionAccess;
  readonly #notices: GovernanceNotice[] = [];
  readonly #deniedByGateway = new Set<string>();
  readonly #marks = new Map<string, GatewayMark>();
  readonly #receipts: ReceiptNote[] = [];
  #text = "";
  #usage: Usage | undefined;
  #blocked: GovernanceNotice | undefined;
  #toolDenied = false;
  #mode: ToolMode = "ask";
  #skills: string[] = [];

  constructor(session: AgentSession, id: string, emit: (event: AgentEvent) => void, access: SessionAccess) {
    this.#session = session;
    this.#id = id;
    this.#emit = emit;
    this.#access = access;
  }

  get #agent(): FadenstackAgent {
    return this.#session.agent;
  }

  async run(message: string, attachments: readonly MessageAttachment[], skills: readonly PickedSkill[], signal: AbortSignal): Promise<void> {
    await Promise.resolve(); // the caller gets the stream before the first request goes out
    this.#mode = this.#session.effectiveToolMode;
    this.#skills = [...new Set(skills.map((s) => s.slug).filter(Boolean))];
    const user: Data = { text: message };
    if (attachments.length) user["attachments"] = attachments.map(attachmentData);
    if (skills.length) user["skills"] = skills.map((s) => ({ slug: s.slug, name: s.name ?? s.slug }));
    await this.#access.append(EntryTypes.userMessage, this.#id, user);
    await this.#access.append(EntryTypes.turnStart, this.#id, {
      tool_mode: this.#session.toolMode,
      effective_tool_mode: this.#mode,
    });
    this.#emit({ type: "turn_started", turnId: this.#id, toolMode: this.#mode });
    try {
      for (let round = 0; ; round++) {
        if (round === this.#agent.settings.maxRounds) {
          await this.#notice({ outcome: "round_limit", stage: "tool", message: `Stopped after ${round} rounds of tool calls.` });
          break;
        }
        signal.throwIfAborted();
        const calls = await this.#request(signal);
        if (this.#blocked || calls.length === 0) break;
        for (const call of calls) await this.#runTool(call, signal);
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
  async #request(signal: AbortSignal): Promise<ToolCall[]> {
    const options: ChatOptions = {
      conversationId: this.#session.id,
      turnId: this.#id,
      toolMode: this.#mode,
      signal,
    };
    const tools = this.#agent.offer(this.#mode);
    if (tools.length) options.tools = tools;
    // On every call of the turn, not the first only: the gateway gives a request the skills it names.
    if (this.#skills.length) options.skills = this.#skills;
    if (this.#agent.settings.reasoning) options.reasoningEffort = this.#agent.settings.reasoning;
    let text = "";
    let finish: FinishReason | undefined;
    const calls: ToolCall[] = [];
    const receipts: ReceiptNote[] = [];
    for await (const update of this.#agent.settings.chat.stream(this.#session.history, options)) {
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
    this.#text += text;
    this.#receipts.push(...receipts);
    if (text || calls.length) {
      await this.#access.append(EntryTypes.assistantMessage, this.#id, {
        text,
        tool_calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.argumentsJson || "{}" })),
        origin: "model",
        // What made the answer, by the receipts' ids: never more of them than that.
        ...(receipts.length ? { receipts: receipts.map(receiptData) } : {}),
      });
    }
    if (this.#blocked) await this.#notice(this.#blocked);
    // A model that thought and then wrote nothing would leave the user with nothing at all on screen.
    else if (calls.length === 0 && isBlank(text) && !signal.aborted) await this.#notice(emptyAnswer(finish));
    return calls;
  }

  async #onGatewayEvent(event: FadenstackEvent, signal: AbortSignal): Promise<void> {
    const value = event.value;
    switch (eventKind(event)) {
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
        const callId = str(value, "toolCallId");
        if (callId) this.#deniedByGateway.add(callId);
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

  /** A gateway tool held for the user: ask, and answer the gateway while it waits. */
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
    const settled = await this.#approve(request, rule, typeof timeoutS === "number" ? timeoutS * 1000 : 5 * 60_000, signal);
    if (settled.timedOut) return; // the gateway expires it on its own
    await this.#agent.client.agent!.answerApproval(approvalId, settled.approved, signal);
    if (!settled.approved) this.#toolDenied = true;
  }

  /** The gateway's word on a call of the agent's own tool, kept until the call runs. */
  #mark(value: unknown): void {
    const callId = str(value, "toolCallId");
    if (!callId) return;
    const toolClass = str(value, "toolClass");
    this.#marks.set(callId, {
      rule: (value as Data)["rule"] !== false,
      toolClass: toolClass === undefined ? undefined : parseToolClass(toolClass),
      message: str(value, "message") ?? "",
    });
  }

  async #runTool(call: ToolCall, signal: AbortSignal): Promise<void> {
    const tool = this.#agent.find(call.name);
    const source = tool?.source ?? "host";
    const mark = this.#marks.get(call.id);
    const toolClass: ToolClass = tool ? stricterClass(tool.toolClass, mark?.toolClass) : "unknown";
    const args = call.arguments ?? {};
    await this.#access.append(EntryTypes.toolStart, this.#id, { call_id: call.id, name: call.name, source, tool_class: toolClass });
    this.#emit({ type: "tool_started", turnId: this.#id, callId: call.id, name: call.name, toolClass, source, arguments: args });
    const started = performance.now();
    let result: string;
    let outcome: ToolOutcome;
    let waited = 0;
    if (!tool) {
      [result, outcome] = [`Tool '${call.name}' does not exist here.`, "error"];
    } else if (this.#deniedByGateway.has(call.id)) {
      [result, outcome] = [`Tool '${call.name}' is not allowed here.`, "denied"];
    } else if (call.argumentsError !== undefined) {
      [result, outcome] = [`Error: the arguments are not valid JSON (${call.argumentsError}).`, "error"];
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
    const decision = decideTool(this.#mode, toolClass);
    if (decision === "hidden") {
      this.#toolDenied = true;
      const why = `the tool mode is ${this.#mode}`;
      await this.#notice({ outcome: "tool_denied", stage: "tool", category: "mode", message: `'${tool.name}' is not allowed: ${why}.` });
      return { result: `Tool '${tool.name}' is not allowed here: ${why}.`, outcome: "denied", waited: 0 };
    }
    const invalid = checkArguments(tool.parameters, args);
    if (invalid) return { result: `Error: ${invalid}`, outcome: "error", waited: 0 };
    let waited = 0;
    const rule = mark?.rule === true;
    if (rule || decision === "ask") {
      const settled = await this.#approve({
        callId: call.id,
        toolName: tool.name,
        toolClass,
        source: tool.source,
        reason: rule ? mark.message
          : toolClass === "unknown" ? "Nobody has said what this tool does."
          : `'${tool.name}' is ${toolClass}; the tool mode is ${this.#mode}.`,
        arguments: args,
        ...(tool.openWorld ? { openWorld: true } : {}),
      }, rule, undefined, signal, tool.describe ? () => describeTarget(tool, args, signal) : undefined);
      waited = settled.waitedMs ?? 0;
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
      const value = await this.#invoker(services)(invocation);
      return { result: resultText(value), outcome: "ok", waited };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
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

  #invoker(services: CallServices): ToolInvoker {
    let invoker: ToolInvoker = async (i) => {
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

  /**
   * Settles a call that needs approval, first that applies: an admin's rule asks (once only, even in bypass);
   * bypass mode approves; a destructive or unclassified tool asks (once only); what the user allowed always, then
   * what they allowed for this chat, approves; else the user is asked, and may allow once, for this chat or always.
   * Every outcome goes in the transcript and the server's record, with what let the call through. `target` is read
   * only when the user is asked: what the call acts on, for the card.
   */
  async #approve(base: ApprovalRequest, rule: boolean, timeoutMs: number | undefined, signal: AbortSignal,
    target?: () => Promise<string | undefined>): Promise<Settled> {
    const { toolName: name, toolClass } = base;
    const open = !rule && !asksEveryTime(toolClass);
    const standing: ApprovalScope | undefined = rule ? undefined
      : this.#agent.permissionMode === "bypass" ? "bypass"
      : !open ? undefined
      : (await this.#approvedAlways(name, toolClass)) ? "always"
      : this.#access.approved.has(name) ? "chat"
      : undefined;
    if (standing) {
      await this.#record(base, { approved: true, scope: standing, asked: false, rule, timedOut: false, waitedMs: undefined });
      return { approved: true, timedOut: false, waitedMs: undefined, reason: undefined };
    }
    const described = target ? await target() : undefined;
    const request: ApprovalRequest = {
      ...base, canAllowForSession: open, canAllowAlways: open, ...(rule ? { requiredByRule: true } : {}), ...(described ? { target: described } : {}),
    };
    this.#emit({ type: "approval_requested", turnId: this.#id, request });
    const limit = timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const started = performance.now();
    let decision: ApprovalDecision | undefined;
    try {
      // Raced against the signal: a handler that ignores it cannot hold a stopped or timed-out turn.
      decision = await untilAborted(this.#agent.settings.approvals.request(request, limit), limit);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (!limit.aborted) throw error;
      decision = undefined; // the time ran out
    }
    const waitedMs = performance.now() - started;
    // What the request offered, and nothing more: a handler cannot widen it.
    let scope: ApprovalScope | undefined = !decision?.approved ? undefined
      : decision.always && open ? "always"
      : decision.forSession && open ? "chat"
      : "once";
    if (scope === "always" && !(await this.#keepAlways(name, toolClass))) scope = "once";
    if (scope === "chat") this.#access.approved.add(name);
    await this.#record(base, { approved: scope !== undefined, scope, asked: true, rule, timedOut: decision === undefined, waitedMs });
    const decided: ApprovalDecision = !decision ? ApprovalDecision.deny("No answer in time.")
      : scope === "always" ? ApprovalDecision.approveAlways()
      : scope === "chat" ? ApprovalDecision.approveForSession()
      : scope === "once" ? ApprovalDecision.approve()
      : decision;
    this.#emit({ type: "approval_decided", turnId: this.#id, request, decision: decided });
    return { approved: scope !== undefined, timedOut: decision === undefined, waitedMs, reason: decision?.reason };
  }

  /** The approval's transcript entry, and the server's record of it (names only). */
  async #record(request: ApprovalRequest, how: {
    approved: boolean; scope: ApprovalScope | undefined; asked: boolean; rule: boolean; timedOut: boolean; waitedMs: number | undefined;
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
      timed_out: how.timedOut,
      wait_ms: Math.round(how.waitedMs ?? 0),
    });
    this.#agent.reporter.add({
      type: "approval.decided", conversationId: this.#session.id, tool: request.toolName,
      decision: how.timedOut ? "timeout" : how.approved ? "approved" : "denied",
      ...(how.waitedMs !== undefined ? { waitMs: how.waitedMs } : {}),
      ...(how.scope ? { scope: how.scope } : {}),
    });
  }

  async #approvedAlways(name: string, toolClass: ToolClass): Promise<boolean> {
    try {
      const kept = await this.#agent.settings.approvalStore.list(this.#agent.slug);
      return kept.some((a) => a.tool === name && a.toolClass === toolClass);
    } catch {
      return false; // a store that cannot be read approves nothing
    }
  }

  async #keepAlways(name: string, toolClass: ToolClass): Promise<boolean> {
    try {
      await this.#agent.settings.approvalStore.add(this.#agent.slug, { tool: name, toolClass, approvedAt: new Date().toISOString() });
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
