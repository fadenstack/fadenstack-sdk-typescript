import type { AgentEvent, AgentResult, ApprovalDecision, ApprovalRequest } from "@fadenstack/agents";
import type { ChatOutcome, GovernanceNotice, ToolClass } from "@fadenstack/client";

import type { PendingApproval } from "./approvalBroker.js";
import type { AttachmentChip } from "./attachments.js";
import { formatNumber } from "./format.js";
import { Observable } from "./observable.js";
import {
  ApprovalPart,
  MarkdownPart,
  NoticePart,
  ReasoningPart,
  ToolCallPart,
  type ApprovalState,
  type PartContext,
  type ResponsePart,
} from "./parts.js";

export type TurnState = "running" | "waiting_for_approval" | "completed" | "blocked" | "stopped" | "failed";

/** What a turn can ask of its chat (edit, retry). */
export interface TurnHost {
  edit(text: string): void;
  retry(turn: TurnViewModel): Promise<void>;
  copy(text: string): void;
}

type ToolStarted = Extract<AgentEvent, { type: "tool_started" }>;
type ToolCompleted = Extract<AgentEvent, { type: "tool_completed" }>;

/**
 * One exchange: the user's message and the answer's parts in the order they happened. The chat is a list of
 * turns, so a skin virtualizes whole exchanges.
 */
export class TurnViewModel extends Observable {
  readonly key = `t${++counter}`;
  readonly userText: string;
  readonly timestamp: Date;
  readonly attachments: readonly AttachmentChip[];
  readonly #context: PartContext;
  readonly #host: TurnHost | undefined;
  readonly #tools = new Map<string, ToolCallPart>();
  #id: string | undefined;
  #parts: readonly ResponsePart[] = [];
  #text: MarkdownPart | undefined;
  #reasoning: ReasoningPart | undefined;
  #state: TurnState;
  #outcome: ChatOutcome | undefined;
  #error: string | undefined;
  #usageText = "";
  #durationText = "";

  constructor(context: PartContext, host: TurnHost | undefined, userText: string, timestamp: Date,
    attachments: readonly AttachmentChip[] = [], state: TurnState = "running") {
    super();
    this.#context = context;
    this.#host = host;
    this.userText = userText;
    this.timestamp = timestamp;
    this.attachments = attachments;
    this.#state = state;
  }

  get id(): string | undefined {
    return this.#id;
  }

  get parts(): readonly ResponsePart[] {
    return this.#parts;
  }

  get state(): TurnState {
    return this.#state;
  }

  get isRunning(): boolean {
    return this.#state === "running" || this.#state === "waiting_for_approval";
  }

  /** The user's message was refused: shown with a mark and "Edit and resend". */
  get isPromptBlocked(): boolean {
    return this.#state === "blocked";
  }

  get outcome(): ChatOutcome | undefined {
    return this.#outcome;
  }

  /** The turn's own line, for what no part shows: nothing while tools run or a card waits. */
  get statusText(): string {
    const s = this.#context.strings;
    switch (this.#state) {
      case "running":
        return this.#parts.length === 0 ? s.working : "";
      case "stopped":
        return s.stopped;
      case "failed":
        return s.failed;
      default:
        return "";
    }
  }

  get errorMessage(): string | undefined {
    return this.#error;
  }

  get usageText(): string {
    return this.#usageText;
  }

  get durationText(): string {
    return this.#durationText;
  }

  /** The answer's Markdown, for copying. */
  get answerText(): string {
    return this.#parts.filter((p): p is MarkdownPart => p instanceof MarkdownPart).map((p) => p.text).filter(Boolean).join("\n\n");
  }

  get canRetry(): boolean {
    return this.#host !== undefined && (this.#state === "failed" || this.#state === "stopped");
  }

  copy(): void {
    this.#host?.copy(this.answerText);
  }

  /** Puts the message back into the composer (e.g. to rephrase a refused prompt). */
  edit(): void {
    if (!this.isRunning) this.#host?.edit(this.userText);
  }

  retry(): Promise<void> {
    return this.canRetry ? this.#host!.retry(this) : Promise.resolve();
  }

  /** Adds a part (renderers and modules use this for their primitives). */
  addPart(part: ResponsePart): void {
    this.#closeText();
    this.#parts = [...this.#parts, part];
    this.notify();
  }

  // -- applied in the order the agent reported them --------------------------------------------------

  /** @internal */
  setId(id: string): void {
    this.#id = id;
  }

  /** @internal */
  appendText(text: string): void {
    if (!this.#text) {
      this.#text = new MarkdownPart(this.#context, undefined, true);
      this.#parts = [...this.#parts, this.#text];
      this.notify();
    }
    this.#text.append(text);
  }

  /** @internal */
  appendReasoning(text: string): void {
    if (!this.#reasoning) {
      this.#reasoning = new ReasoningPart(this.#context, this.#context.now());
      this.#parts = [...this.#parts, this.#reasoning];
      this.notify();
    }
    this.#reasoning.append(text);
  }

  /** @internal */
  toolStarted(e: ToolStarted): void {
    this.#closeText();
    const part = new ToolCallPart(this.#context, e.callId, e.name, e.source, e.toolClass, e.arguments);
    this.#tools.set(key(e.callId, e.name), part);
    this.#parts = [...this.#parts, part];
    this.notify();
  }

  /** @internal */
  toolCompleted(e: ToolCompleted): void {
    let part = this.#tools.get(key(e.callId, e.name));
    if (!part) {
      part = new ToolCallPart(this.#context, e.callId, e.name, e.source, "unknown", undefined);
      this.#tools.set(key(e.callId, e.name), part);
      this.#parts = [...this.#parts, part];
      this.notify();
    }
    part.complete(e.outcome, e.result, e.durationMs);
  }

  /** @internal */
  addApproval(pending: PendingApproval): void {
    this.#closeText();
    this.addApprovalPart(new ApprovalPart(this.#context, pending.request, "pending", pending));
    this.#tools.get(key(pending.request.callId, pending.request.toolName))?.setState("waiting_for_approval");
    this.#setState("waiting_for_approval");
  }

  /** @internal The card goes above its tool's row, so the turn reads in order: asked, allowed, ran. */
  addApprovalPart(card: ApprovalPart): void {
    const tool = this.#tools.get(key(card.request.callId, card.toolName));
    const at = tool ? this.#parts.indexOf(tool) : -1;
    this.#parts = at >= 0 ? [...this.#parts.slice(0, at), card, ...this.#parts.slice(at)] : [...this.#parts, card];
    this.notify();
  }

  /** @internal */
  approvalDecided(request: ApprovalRequest, decision: ApprovalDecision): void {
    const card = [...this.#parts].reverse().find((p): p is ApprovalPart =>
      p instanceof ApprovalPart && p.request.callId === request.callId && p.toolName === request.toolName);
    if (card?.isPending) {
      const state: ApprovalState = decision.approved ? (decision.forSession ? "approved_for_session" : "approved")
        : decision.reason === "No answer in time." ? "expired" : "denied";
      card.setState(state);
    }
    const tool = this.#tools.get(key(request.callId, request.toolName));
    if (tool?.state === "waiting_for_approval") tool.setState("running");
    if (this.#state === "waiting_for_approval" && !this.#parts.some((p) => p instanceof ApprovalPart && p.isPending)) {
      this.#setState("running");
    }
  }

  /** @internal */
  addNotice(notice: GovernanceNotice): void {
    if (notice.outcome === "prompt_blocked") this.#setState("blocked");
    this.addPart(NoticePart.from(notice, this.#context.strings));
  }

  /** @internal */
  complete(result: AgentResult): void {
    this.#id = result.turnId;
    this.#outcome = result.outcome;
    if (result.usage && result.usage.totalTokens > 0) {
      this.#usageText = this.#context.strings.tokens(formatNumber(result.usage.totalTokens, this.#context.locale));
    }
    this.#finish(result.outcome === "prompt_blocked" ? "blocked" : "completed");
  }

  /** @internal */
  stop(): void {
    this.#finish("stopped");
  }

  /** @internal */
  fail(message: string): void {
    this.#error = message;
    this.#finish("failed");
  }

  /** @internal For a turn read back from the transcript. */
  restore(state: TurnState, outcome: ChatOutcome | undefined, usageText: string): void {
    this.#state = state;
    this.#outcome = outcome;
    this.#usageText = usageText;
  }

  /** @internal */
  addRestoredText(text: string): void {
    this.#parts = [...this.#parts, new MarkdownPart(this.#context, text)];
  }

  /** @internal */
  addRestoredTool(callId: string, name: string, source: string, toolClass: ToolClass): ToolCallPart {
    const part = new ToolCallPart(this.#context, callId, name, source, toolClass, undefined);
    this.#tools.set(key(callId, name), part);
    this.#parts = [...this.#parts, part];
    return part;
  }

  /** @internal */
  findTool(callId: string, name: string): ToolCallPart | undefined {
    return this.#tools.get(key(callId, name));
  }

  /** @internal */
  addRestoredPart(part: ResponsePart): void {
    this.#parts = [...this.#parts, part];
  }

  #finish(state: TurnState): void {
    this.#closeText();
    for (const part of this.#parts) {
      if (part instanceof ApprovalPart && part.isPending) part.setState("expired");
    }
    for (const tool of this.#tools.values()) if (tool.isRunning) tool.setState("cancelled");
    const elapsed = this.#context.now().getTime() - this.timestamp.getTime();
    this.#durationText = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)} s` : "";
    this.#state = state;
    this.notify();
  }

  #setState(state: TurnState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.notify();
  }

  /** Text after a tool call starts a new block of text, below it (as Copilot shows it). */
  #closeText(): void {
    if (this.#text) {
      this.#text.setStreaming(false);
      this.#text = undefined;
    }
    if (this.#reasoning?.isStreaming) this.#reasoning.complete(this.#context.now());
  }
}

let counter = 0;

function key(callId: string, name: string): string {
  return `${callId}\u0001${name}`;
}
