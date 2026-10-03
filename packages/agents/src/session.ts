import {
  FadenRateLimitedError,
  decideTool,
  eventKind,
  narrowestMode,
  parseToolMode,
  type ChatMessage,
  type ChatOptions,
  type ChatOutcome,
  type FadenEvent,
  type GovernanceNotice,
  type ToolCall,
  type ToolClass,
  type ToolMode,
  type Usage,
} from "@fadenstack/client";

import type { FadenAgent } from "./agent.js";
import { ApprovalDecision, type ApprovalRequest } from "./approvals.js";
import { attachmentData, type MessageAttachment } from "./attachments.js";
import { ContextBuilder } from "./contextBuilder.js";
import { EventQueue } from "./eventQueue.js";
import type { AgentEvent, AgentResult, ToolOutcome } from "./events.js";
import type { ToolInvocation, ToolInvoker } from "./stages.js";
import { checkArguments, type AgentTool } from "./tools.js";
import { EntryTypes, TurnStatus, newId, type TranscriptEntry } from "./transcript.js";

export interface SendOptions {
  /** Context the user attached (a selection, the page). */
  attachments?: readonly MessageAttachment[];
  /** Stops the turn: it is recorded as cancelled and the stream throws the reason. */
  signal?: AbortSignal;
}

type Data = Record<string, unknown>;
const str = (data: unknown, key: string): string | undefined => {
  const v = data && typeof data === "object" ? (data as Data)[key] : undefined;
  return typeof v === "string" ? v : undefined;
};

/**
 * One conversation with the agent, kept on this device (06). A turn sends the history the session rule allows,
 * streams the answer, runs the agent's tools under the session's tool mode -- asking the user where the mode
 * says so -- and ends with a typed outcome. Refusals are outcomes; the session goes on.
 */
export class AgentSession {
  readonly id: string;
  /** The mode the user picked for this session (sdk/07). New sessions start in `ask`. */
  toolMode: ToolMode;
  readonly agent: FadenAgent;
  readonly #entries: TranscriptEntry[];
  readonly #approvedForSession: Set<string>;
  readonly #context: ContextBuilder;
  #running = false;

  constructor(agent: FadenAgent, id: string, entries: TranscriptEntry[], toolMode: ToolMode) {
    this.agent = agent;
    this.id = id;
    this.#entries = entries;
    this.toolMode = toolMode;
    this.#context = new ContextBuilder(agent.settings.historyTokens);
    this.#approvedForSession = new Set(
      entries
        .filter((e) => e.type === EntryTypes.approvalDecision && e.data["for_session"] === true && e.data["approved"] === true)
        .map((e) => str(e.data, "name") ?? ""),
    );
  }

  /** The mode turns run in: the user's pick, narrowed by the agent's ceiling (EE). */
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

  /** Tools the user approved for the rest of this session. */
  get approvedForSession(): ReadonlySet<string> {
    return this.#approvedForSession;
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
    const turn = new Turn(this, newId(), (e) => queue.push(e));
    const run = turn
      .run(message, options.attachments ?? [], stop.signal)
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
    return this.append(EntryTypes.sessionStart, null, {
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

  /** @internal Adds an entry to the transcript and the store. A stopped turn is still recorded. */
  async append(type: string, turnId: string | null, data: Data, status: string | null = null): Promise<void> {
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

  /** @internal */
  historyNow(): ChatMessage[] {
    return this.#context.build(this.#entries);
  }

  /** @internal */
  isApprovedForSession(name: string): boolean {
    return this.#approvedForSession.has(name);
  }

  /** @internal */
  approveForSession(name: string): void {
    this.#approvedForSession.add(name);
  }
}

/** One turn: the loop of model calls and tool runs, and its record. */
class Turn {
  readonly #session: AgentSession;
  readonly #id: string;
  readonly #emit: (event: AgentEvent) => void;
  readonly #notices: GovernanceNotice[] = [];
  readonly #deniedByGateway = new Set<string>();
  #text = "";
  #usage: Usage | undefined;
  #blocked: GovernanceNotice | undefined;
  #toolDenied = false;
  #mode: ToolMode = "ask";

  constructor(session: AgentSession, id: string, emit: (event: AgentEvent) => void) {
    this.#session = session;
    this.#id = id;
    this.#emit = emit;
  }

  get #agent(): FadenAgent {
    return this.#session.agent;
  }

  async run(message: string, attachments: readonly MessageAttachment[], signal: AbortSignal): Promise<void> {
    await Promise.resolve(); // the caller gets the stream before the first request goes out
    this.#mode = this.#session.effectiveToolMode;
    const user: Data = { text: message };
    if (attachments.length) user["attachments"] = attachments.map(attachmentData);
    await this.#session.append(EntryTypes.userMessage, this.#id, user);
    await this.#session.append(EntryTypes.turnStart, this.#id, {
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
      if (error instanceof FadenRateLimitedError) {
        const notice: GovernanceNotice = { outcome: error.isBudget ? "budget_exceeded" : "rate_limited", message: error.message };
        if (error.retryAfterMs !== undefined) notice.retryAfterMs = error.retryAfterMs;
        await this.#notice(notice);
        await this.#end(TurnStatus.error, error.isBudget ? "budget_exceeded" : "rate_limited");
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
    if (this.#agent.settings.reasoning) options.reasoningEffort = this.#agent.settings.reasoning;
    let text = "";
    const calls: ToolCall[] = [];
    for await (const update of this.#agent.settings.chat.stream(this.#session.historyNow(), options)) {
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
        case "finish":
          if (update.reason === "content_filter" && !this.#blocked) {
            this.#blocked = { outcome: "response_blocked", stage: "output", message: "The answer was stopped." };
          }
          break;
      }
    }
    if (this.#blocked) calls.length = 0; // a refused answer's tool calls never run
    this.#text += text;
    if (text || calls.length) {
      await this.#session.append(EntryTypes.assistantMessage, this.#id, {
        text,
        tool_calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.argumentsJson || "{}" })),
        origin: "model",
      });
    }
    if (this.#blocked) await this.#notice(this.#blocked);
    return calls;
  }

  async #onGatewayEvent(event: FadenEvent, signal: AbortSignal): Promise<void> {
    const value = event.value;
    switch (eventKind(event)) {
      case "faden.gateway_round":
        await this.#keepRound(value);
        break;
      case "faden.approval_required":
        await this.#answerGatewayApproval(value, signal);
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

  /** The gateway's own tool round, kept so the model still knows what it searched (02 §7). */
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
        await this.#session.append(EntryTypes.assistantMessage, this.#id, { text: str(m, "content") ?? "", tool_calls: calls, origin: "gateway" });
      } else if (role === "tool") {
        const callId = str(m, "tool_call_id") ?? "";
        await this.#session.append(EntryTypes.toolComplete, this.#id, {
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
      toolClass: "unknown",
      source: "gateway",
      reason: str(value, "message") ?? "",
      arguments: {},
    };
    const timeoutS = value && typeof value === "object" ? (value as Data)["timeoutS"] : undefined;
    const { decision } = await this.#ask(request, typeof timeoutS === "number" ? timeoutS * 1000 : 5 * 60_000, signal);
    if (!decision) return; // timed out: the gateway expires it on its own
    await this.#agent.client.agent!.answerApproval(approvalId, decision.approved, signal);
    if (!decision.approved) this.#toolDenied = true;
  }

  async #runTool(call: ToolCall, signal: AbortSignal): Promise<void> {
    const tool = this.#agent.find(call.name);
    const source = tool?.source ?? "host";
    const toolClass: ToolClass = tool?.toolClass ?? "unknown";
    const args = call.arguments ?? {};
    await this.#session.append(EntryTypes.toolStart, this.#id, { call_id: call.id, name: call.name, source, tool_class: toolClass });
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
      ({ result, outcome, waited } = await this.#decideAndRun(tool, call, args, signal));
    }
    // The tool's own time: the user's time on the approval card is reported apart (approval.decided).
    const ran = Math.max(0, performance.now() - started - waited);
    await this.#session.append(EntryTypes.toolComplete, this.#id, {
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

  /** Asks if the mode says so, then runs the tool; also returns how long the asking took. */
  async #decideAndRun(tool: AgentTool, call: ToolCall, args: Record<string, unknown>, signal: AbortSignal):
    Promise<{ result: string; outcome: ToolOutcome; waited: number }> {
    const decision = decideTool(this.#mode, tool.toolClass);
    if (decision === "hidden") {
      this.#toolDenied = true;
      const why = `the tool mode is ${this.#mode}`;
      await this.#notice({ outcome: "tool_denied", stage: "tool", category: "mode", message: `'${tool.name}' is not allowed: ${why}.` });
      return { result: `Tool '${tool.name}' is not allowed here: ${why}.`, outcome: "denied", waited: 0 };
    }
    const invalid = checkArguments(tool.parameters, args);
    if (invalid) return { result: `Error: ${invalid}`, outcome: "error", waited: 0 };
    let waited = 0;
    if (decision === "ask") {
      const asked = await this.#ask({
        callId: call.id,
        toolName: tool.name,
        toolClass: tool.toolClass,
        source: tool.source,
        reason: tool.toolClass === "unknown"
          ? "Nobody has said what this tool does."
          : `'${tool.name}' is ${tool.toolClass}; the tool mode is ${this.#mode}.`,
        arguments: args,
      }, undefined, signal);
      waited = asked.waitedMs ?? 0;
      if (asked.waitedMs !== undefined) {
        this.#agent.reporter.add({
          type: "approval.decided", conversationId: this.#session.id, tool: tool.name, waitMs: asked.waitedMs,
          decision: !asked.decision ? "timeout" : asked.decision.approved ? "approved" : "denied",
        });
      }
      if (!asked.decision?.approved) {
        this.#toolDenied = true;
        const reason = asked.decision?.reason ? ` (${asked.decision.reason})` : "";
        return { result: `The user declined to run '${tool.name}'${reason}.`, outcome: "denied", waited };
      }
    }
    try {
      const invocation: ToolInvocation = {
        tool,
        arguments: { ...args },
        toolClass: tool.toolClass,
        context: { signal, callId: call.id, sessionId: this.#session.id, turnId: this.#id },
      };
      const value = await this.#invoker()(invocation);
      return { result: resultText(value), outcome: "ok", waited };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return { result: `Error: ${error instanceof Error ? error.message : String(error)}`, outcome: "error", waited };
    }
  }

  #invoker(): ToolInvoker {
    let invoker: ToolInvoker = async (i) => i.tool.invoke(i.arguments, i.context);
    const stages = this.#agent.settings.toolStages;
    for (let s = stages.length - 1; s >= 0; s--) {
      const stage = stages[s]!;
      const next = invoker;
      invoker = (i) => stage.invoke(i, next);
    }
    return invoker;
  }

  /**
   * Asks the user, unless they approved this tool for the session. `decision` is undefined when the time ran
   * out; `waitedMs` is how long the user took (undefined when nobody was asked).
   */
  async #ask(request: ApprovalRequest, timeoutMs: number | undefined, signal: AbortSignal):
    Promise<{ decision: ApprovalDecision | undefined; waitedMs: number | undefined }> {
    if (this.#session.isApprovedForSession(request.toolName)) return { decision: ApprovalDecision.approve(), waitedMs: undefined };
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
    await this.#session.append(EntryTypes.approvalDecision, this.#id, {
      call_id: request.callId,
      name: request.toolName,
      source: request.source,
      approved: decision?.approved ?? false,
      for_session: decision?.forSession ?? false,
      timed_out: decision === undefined,
      wait_ms: Math.round(waitedMs),
    });
    if (decision?.approved && decision.forSession) this.#session.approveForSession(request.toolName);
    this.#emit({ type: "approval_decided", turnId: this.#id, request, decision: decision ?? ApprovalDecision.deny("No answer in time.") });
    return { decision, waitedMs };
  }

  async #notice(notice: GovernanceNotice): Promise<void> {
    this.#notices.push(notice);
    const data: Data = { outcome: notice.outcome, message: notice.message };
    if (notice.stage) data["stage"] = notice.stage;
    if (notice.category) data["category"] = notice.category;
    if (notice.decisionId) data["decision_id"] = notice.decisionId;
    if (notice.retryAfterMs !== undefined) data["retry_after_ms"] = notice.retryAfterMs;
    await this.#session.append(EntryTypes.governanceNotice, this.#id, data);
    this.#emit({ type: "notice", turnId: this.#id, notice });
  }

  async #end(status: string, outcome: ChatOutcome | undefined): Promise<void> {
    await this.#session.append(EntryTypes.turnEnd, this.#id, {
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
        result: { turnId: this.#id, outcome, text: this.#text, notices: [...this.#notices], usage: this.#usage },
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

/** A tool's result as the model gets it: a string as it is, anything else as JSON. */
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
