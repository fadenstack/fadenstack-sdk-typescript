import type { GovernanceNotice, Usage } from "@fadenstack/client";

import type { AgentEvent } from "./events.js";
import type { AgUiEvent, Interrupt, TokenUsage } from "./aguiTypes.js";

export type * from "./aguiTypes.js";

/** What {@link agUiEvents} needs to know besides the events. */
export interface AgUiOptions {
  /** AG-UI's `threadId`: the conversation. Pass the session's `ChatSession.id`. Left out, the first turn's id stands in. */
  threadId?: string;
  /** Milliseconds since the Unix epoch for each event's `timestamp`. Left out, the system clock (tests pass a fixed one). */
  clock?: () => number;
}

/** The AG-UI JSON of an event: compact, `type` first, `metadata` last (the same text as the .NET SDK writes). */
export function agUiJson(event: AgUiEvent): string {
  return JSON.stringify(event);
}

// Governance words the SDK keeps for itself (the gateway round it sends back as history, the approval it turns into a card).
const PASSED_THROUGH = new Set(["faden.citations", "faden.pii", "faden.attachment_left_out", "faden.provenance"]);

/**
 * An adapter from the agent's own event stream to AG-UI events, so a third-party AG-UI client can render a Fadenstack
 * agent. The SDK's own view models keep using the native {@link AgentEvent}s.
 *
 * ```ts
 * for await (const e of agUiEvents(session.stream("Hello"), { threadId: session.id })) {
 *   res.write(`data: ${agUiJson(e)}\n\n`);
 * }
 * ```
 *
 * An error of the source (a stopped turn) ends the stream with `RUN_ERROR` (an abort is thrown on). A tool call that
 * waits for the user ends the run with `RUN_FINISHED` and an `interrupt` outcome; the events after the user's answer are
 * a new run (`RUN_STARTED` with the id `{turnId}.2`) on the same thread. No secret and no header goes into an event: the
 * arguments and results of tool calls are what the native events carry; a call's pictures are not sent.
 */
export async function* agUiEvents(events: AsyncIterable<AgentEvent>, options: AgUiOptions = {}): AsyncGenerator<AgUiEvent> {
  const translator = new Translator(options);
  const iterator = events[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      let next: IteratorResult<AgentEvent>;
      try {
        next = await iterator.next();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        yield* translator.fail(error);
        finished = true;
        return;
      }
      if (next.done) break;
      yield* translator.translate(next.value);
    }
    finished = true;
    yield* translator.end();
  } finally {
    if (!finished) await iterator.return?.();
  }
}

class Translator {
  readonly #options: AgUiOptions;
  #turn = "";
  #thread: string;
  #run = 0;
  #open = false;
  #messages = 0;
  #text: string | undefined;
  #reasoning: string | undefined;
  #resolved: { callId: string; approved: boolean } | undefined;
  #done = false;

  constructor(options: AgUiOptions) {
    this.#options = options;
    this.#thread = options.threadId ?? "";
  }

  #now(): number {
    return this.#options.clock ? this.#options.clock() : Date.now();
  }

  get #runId(): string {
    return this.#run <= 1 ? this.#turn : `${this.#turn}.${this.#run}`;
  }

  translate(e: AgentEvent): AgUiEvent[] {
    const out: AgUiEvent[] = [];
    if (this.#done) return out;
    if (this.#turn === "") {
      this.#turn = e.turnId;
      if (this.#thread === "") this.#thread = this.#turn;
    }
    switch (e.type) {
      case "turn_started":
        this.#start(out, { toolMode: e.toolMode });
        break;
      case "text":
        this.#start(out);
        this.#closeReasoning(out);
        if (e.text.length > 0) {
          if (this.#text === undefined) {
            this.#text = this.#nextMessage();
            out.push({ type: "TEXT_MESSAGE_START", timestamp: this.#now(), messageId: this.#text, role: "assistant" });
          }
          out.push({ type: "TEXT_MESSAGE_CONTENT", timestamp: this.#now(), messageId: this.#text, delta: e.text });
        }
        break;
      case "reasoning":
        this.#start(out);
        this.#closeText(out);
        if (e.text.length > 0) {
          if (this.#reasoning === undefined) {
            this.#reasoning = this.#nextMessage();
            out.push({ type: "REASONING_START", timestamp: this.#now(), messageId: this.#reasoning });
            out.push({ type: "REASONING_MESSAGE_START", timestamp: this.#now(), messageId: this.#reasoning, role: "reasoning" });
          }
          out.push({ type: "REASONING_MESSAGE_CONTENT", timestamp: this.#now(), messageId: this.#reasoning, delta: e.text });
        }
        break;
      case "tool_started":
        this.#start(out);
        this.#closeMessages(out);
        out.push({
          type: "TOOL_CALL_START",
          timestamp: this.#now(),
          toolCallId: e.callId,
          toolCallName: e.name,
          metadata: { toolClass: e.toolClass, source: e.source },
        });
        out.push({ type: "TOOL_CALL_ARGS", timestamp: this.#now(), toolCallId: e.callId, delta: JSON.stringify(e.arguments) });
        out.push({ type: "TOOL_CALL_END", timestamp: this.#now(), toolCallId: e.callId });
        break;
      case "tool_completed":
        this.#start(out);
        this.#closeMessages(out);
        out.push({
          type: "TOOL_CALL_RESULT",
          timestamp: this.#now(),
          messageId: `${this.#turn}-result-${e.callId}`,
          toolCallId: e.callId,
          content: e.result ?? "",
          role: "tool",
          metadata: { outcome: e.outcome, durationMs: Math.trunc(e.durationMs) },
        });
        break;
      case "approval_requested": {
        this.#start(out);
        this.#closeMessages(out);
        const r = e.request;
        const interrupt: Interrupt = {
          id: r.callId,
          reason: "approval_required",
          ...(r.reason.length > 0 ? { message: r.reason } : {}),
          toolCallId: r.callId,
          metadata: { toolName: r.toolName, toolClass: r.toolClass, source: r.source },
        };
        out.push({
          type: "RUN_FINISHED",
          timestamp: this.#now(),
          threadId: this.#thread,
          runId: this.#runId,
          outcome: { type: "interrupt", interrupts: [interrupt] },
        });
        this.#open = false;
        break;
      }
      case "approval_decided":
        this.#closeMessages(out);
        this.#resolved = { callId: e.request.callId, approved: e.decision.approved };
        break;
      case "notice":
        this.#start(out);
        this.#closeMessages(out);
        out.push({ type: "CUSTOM", timestamp: this.#now(), name: "faden.notice", value: noticeValue(e.notice) });
        break;
      case "gateway_event":
        if (e.event.type === "CUSTOM" && e.event.name !== undefined && PASSED_THROUGH.has(e.event.name)) {
          this.#start(out);
          this.#closeMessages(out);
          out.push({ type: "CUSTOM", timestamp: this.#now(), name: e.event.name, value: e.event.value ?? null });
        }
        break;
      case "turn_completed": {
        this.#start(out);
        this.#closeMessages(out);
        const usage = usageOf(e.result.usage);
        out.push({
          type: "RUN_FINISHED",
          timestamp: this.#now(),
          threadId: this.#thread,
          runId: this.#runId,
          result: { outcome: e.result.outcome },
          outcome: { type: "success" },
          ...(usage ? { usage } : {}),
        });
        this.#open = false;
        this.#done = true;
        break;
      }
    }
    return out;
  }

  fail(error: unknown): AgUiEvent[] {
    const out: AgUiEvent[] = [];
    if (this.#done) return out;
    this.#start(out);
    this.#closeMessages(out);
    out.push({ type: "RUN_ERROR", timestamp: this.#now(), message: error instanceof Error ? error.message : String(error) });
    this.#open = false;
    this.#done = true;
    return out;
  }

  end(): AgUiEvent[] {
    const out: AgUiEvent[] = [];
    this.#closeMessages(out);
    return out;
  }

  #nextMessage(): string {
    return `${this.#turn}-m${++this.#messages}`;
  }

  // A run is open from its RUN_STARTED to its RUN_FINISHED. The first event of a run after an interrupt opens the next one.
  #start(out: AgUiEvent[], metadata?: Record<string, unknown>): void {
    if (this.#open) return;
    this.#run++;
    this.#open = true;
    if (this.#resolved && this.#run > 1) {
      metadata = { resumes: { interruptId: this.#resolved.callId, approved: this.#resolved.approved } };
    }
    this.#resolved = undefined;
    out.push({ type: "RUN_STARTED", timestamp: this.#now(), threadId: this.#thread, runId: this.#runId, metadata });
  }

  #closeText(out: AgUiEvent[]): void {
    if (this.#text !== undefined) {
      out.push({ type: "TEXT_MESSAGE_END", timestamp: this.#now(), messageId: this.#text });
      this.#text = undefined;
    }
  }

  #closeReasoning(out: AgUiEvent[]): void {
    if (this.#reasoning !== undefined) {
      out.push({ type: "REASONING_MESSAGE_END", timestamp: this.#now(), messageId: this.#reasoning });
      out.push({ type: "REASONING_END", timestamp: this.#now(), messageId: this.#reasoning });
      this.#reasoning = undefined;
    }
  }

  #closeMessages(out: AgUiEvent[]): void {
    this.#closeReasoning(out);
    this.#closeText(out);
  }
}

function noticeValue(notice: GovernanceNotice): Record<string, unknown> {
  const value: Record<string, unknown> = { outcome: notice.outcome };
  if (notice.stage !== undefined) value.stage = notice.stage;
  if (notice.category !== undefined) value.category = notice.category;
  value.message = notice.message;
  if (notice.decisionId !== undefined) value.decisionId = notice.decisionId;
  if (notice.requestId !== undefined) value.requestId = notice.requestId;
  if (notice.retryAfterMs !== undefined) value.retryAfterMs = Math.trunc(notice.retryAfterMs);
  return value;
}

function usageOf(usage: Usage | undefined): TokenUsage[] | undefined {
  if (!usage) return undefined;
  return [{ inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, totalTokens: usage.totalTokens }];
}
