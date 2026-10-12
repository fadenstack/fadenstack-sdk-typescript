import { ApprovalDecision, type ApprovalRequest } from "@fadenstack/agents";
import type { GovernanceNotice, ToolClass } from "@fadenstack/client";

import type { PendingApproval } from "./approvalBroker.js";
import { formatDuration, preview } from "./format.js";
import { MarkdownDocument } from "./markdown/document.js";
import type { MarkdownBlock } from "./markdown/model.js";
import { tableToTsv, toHtml } from "./markdown/serialize.js";
import { Observable } from "./observable.js";
import { writeClipboard, type Clipboard } from "./services.js";
import type { UiStrings } from "./strings.js";

/** What every part can reach: the texts, the clipboard, the locale, the preview length. */
export interface PartContext {
  strings: UiStrings;
  clipboard: Clipboard;
  locale: string | undefined;
  previewLength: number;
  now: () => Date;
}

/**
 * One piece of an answer, in the order it happened: text, a tool call, an approval, a notice, citations. Skins
 * pick a view by `kind`. Features and modules add their own through the primitives (card, table, progress,
 * diff), so a feature needs no view of its own.
 */
export abstract class ResponsePart extends Observable {
  abstract readonly kind: string;
  /** A stable key for the skin's list. */
  readonly key: string = `p${++partCounter}`;
}

let partCounter = 0;

/** Answer text as Markdown blocks, growing while it streams. */
export class MarkdownPart extends ResponsePart {
  readonly kind = "markdown";
  readonly document: MarkdownDocument;
  #streaming: boolean;
  readonly #context: PartContext;

  constructor(context: PartContext, text?: string, streaming = false) {
    super();
    this.#context = context;
    this.document = new MarkdownDocument(text);
    this.#streaming = streaming;
  }

  get blocks(): readonly MarkdownBlock[] {
    return this.document.blocks;
  }

  get text(): string {
    return this.document.text;
  }

  get isStreaming(): boolean {
    return this.#streaming;
  }

  /** @internal */
  setStreaming(streaming: boolean): void {
    if (this.#streaming === streaming) return;
    this.#streaming = streaming;
    this.notify();
  }

  /** @internal */
  append(text: string): void {
    if (this.document.append(text)) this.notify();
  }

  copyCode(code: string): void {
    void this.#context.clipboard.setText(code);
  }

  /** Copies a table: tab-separated for spreadsheets, and as an HTML table for mail and documents. */
  copyTable(table: Extract<MarkdownBlock, { kind: "table" }>): void {
    void Promise.resolve(writeClipboard(this.#context.clipboard, { text: tableToTsv(table), html: toHtml([table]) })).catch(() => undefined);
  }
}

/** The model's reasoning: collapsed, "Thinking..." while it streams, then "Thought for 4 s". */
export class ReasoningPart extends ResponsePart {
  readonly kind = "reasoning";
  readonly #context: PartContext;
  readonly #started: Date;
  #text = "";
  #streaming = true;
  #expanded = false;
  #title: string;

  constructor(context: PartContext, started: Date) {
    super();
    this.#context = context;
    this.#started = started;
    this.#title = context.strings.thinking;
  }

  get title(): string {
    return this.#title;
  }

  get isStreaming(): boolean {
    return this.#streaming;
  }

  get isExpanded(): boolean {
    return this.#expanded;
  }

  /** The text, once expanded. */
  get text(): string {
    return this.#expanded ? this.#text : "";
  }

  toggle(): void {
    this.#expanded = !this.#expanded;
    this.notify();
  }

  /** @internal */
  append(text: string): void {
    this.#text += text;
    if (this.#expanded) this.notify();
  }

  /** @internal */
  complete(now: Date): void {
    if (!this.#streaming) return;
    this.#streaming = false;
    const seconds = Math.max(1, Math.round((now.getTime() - this.#started.getTime()) / 1000));
    this.#title = this.#context.strings.thoughtFor(seconds);
    this.notify();
  }
}

export type ToolCallState = "running" | "waiting_for_approval" | "succeeded" | "failed" | "denied" | "cancelled";

/** One tool call: a line ("Ran read_page"), expandable to its input and output. */
export class ToolCallPart extends ResponsePart {
  readonly kind = "tool";
  readonly callId: string;
  readonly name: string;
  /** `host`, `mcp` or `gateway`. */
  readonly source: string;
  readonly toolClass: ToolClass;
  readonly #context: PartContext;
  readonly #arguments: Readonly<Record<string, unknown>> | undefined;
  #state: ToolCallState = "running";
  #durationMs: number | undefined;
  #result: string | undefined;
  #expanded = false;

  constructor(context: PartContext, callId: string, name: string, source: string, toolClass: ToolClass,
    args: Readonly<Record<string, unknown>> | undefined) {
    super();
    this.#context = context;
    this.callId = callId;
    this.name = name;
    this.source = source;
    this.toolClass = toolClass;
    this.#arguments = args;
  }

  get state(): ToolCallState {
    return this.#state;
  }

  get isRunning(): boolean {
    return this.#state === "running" || this.#state === "waiting_for_approval";
  }

  get classLabel(): string {
    return this.#context.strings.toolClass[this.toolClass];
  }

  /** What the line says: "Running read_page", "Ran read_page", "read_page was not run". */
  get title(): string {
    const s = this.#context.strings;
    switch (this.#state) {
      case "running":
        return s.toolRunning(this.name);
      case "waiting_for_approval":
        return s.toolWaiting(this.name);
      case "succeeded":
        return s.toolRan(this.name);
      case "failed":
        return s.toolFailed(this.name);
      case "denied":
        return s.toolDenied(this.name);
      default:
        return s.toolStopped(this.name);
    }
  }

  get durationText(): string {
    return this.#durationMs === undefined ? "" : formatDuration(this.#durationMs, this.#context.locale);
  }

  get isExpanded(): boolean {
    return this.#expanded;
  }

  get hasDetails(): boolean {
    return Object.keys(this.#arguments ?? {}).length > 0 || !!this.#result;
  }

  /** Formatted only when expanded. */
  get argumentsText(): string {
    if (!this.#expanded || !this.#arguments || Object.keys(this.#arguments).length === 0) return "";
    return JSON.stringify(this.#arguments, null, 2);
  }

  get resultText(): string {
    return this.#expanded ? preview(this.#result, this.#context.previewLength, this.#context.strings.moreCharacters, this.#context.locale) : "";
  }

  toggle(): void {
    this.#expanded = !this.#expanded;
    this.notify();
  }

  /** @internal */
  setState(state: ToolCallState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.notify();
  }

  /** @internal */
  complete(outcome: string, result: string | undefined, durationMs: number): void {
    this.#result = result;
    this.#durationMs = durationMs;
    this.#state = outcome === "ok" ? "succeeded" : outcome === "denied" ? "denied" : outcome === "cancelled" ? "cancelled" : "failed";
    this.notify();
  }
}

export type ApprovalState = "pending" | "approved" | "approved_for_session" | "approved_always" | "denied" | "expired";

/**
 * "Run delete_page?" with Allow, Allow for this chat, Allow always and Deny -- answered in place, like Copilot.
 * Destructive and unclassified tools, and calls an admin's rule covers, offer Allow and Deny only.
 */
export class ApprovalPart extends ResponsePart {
  readonly kind = "approval";
  readonly request: ApprovalRequest;
  readonly argumentsText: string;
  readonly #context: PartContext;
  readonly #pending: PendingApproval | undefined;
  #state: ApprovalState;

  constructor(context: PartContext, request: ApprovalRequest, state: ApprovalState, pending?: PendingApproval) {
    super();
    this.#context = context;
    this.request = request;
    this.#state = state;
    this.#pending = pending;
    const lines = Object.entries(request.arguments).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    this.argumentsText = preview(lines.join("\n"), context.previewLength, context.strings.moreCharacters, context.locale);
  }

  get toolName(): string {
    return this.request.toolName;
  }

  get title(): string {
    return this.#context.strings.approvalTitle(this.request.toolName);
  }

  /** Destructive or unclassified: the card says so plainly. */
  get isDangerous(): boolean {
    return this.request.toolClass === "destructive" || this.request.toolClass === "unknown";
  }

  get classLabel(): string {
    return this.request.source === "gateway" ? this.#context.strings.serverTool : this.#context.strings.approvalClass[this.request.toolClass];
  }

  /** Why it asks: the admin's message for a gateway tool or a rule; for the agent's own tools, what its class means. */
  get reason(): string {
    return this.request.source === "gateway" || this.request.requiredByRule
      ? this.request.reason
      : this.#context.strings.approvalWhy[this.request.toolClass];
  }

  /** Whether the card offers "Allow for this chat". */
  get canAllowForSession(): boolean {
    return this.request.canAllowForSession === true;
  }

  /** Whether the card offers "Allow always". */
  get canAllowAlways(): boolean {
    return this.request.canAllowAlways === true;
  }

  get state(): ApprovalState {
    return this.#state;
  }

  get isPending(): boolean {
    return this.#state === "pending";
  }

  get stateText(): string {
    const s = this.#context.strings;
    switch (this.#state) {
      case "approved":
        return s.allowed;
      case "approved_for_session":
        return s.allowedForChat;
      case "approved_always":
        return s.allowedAlways;
      case "denied":
        return s.denied;
      case "expired":
        return s.noAnswer;
      default:
        return "";
    }
  }

  allow(): void {
    this.#decide(ApprovalDecision.approve(), "approved");
  }

  allowForSession(): void {
    if (!this.canAllowForSession) return;
    this.#decide(ApprovalDecision.approveForSession(), "approved_for_session");
  }

  allowAlways(): void {
    if (!this.canAllowAlways) return;
    this.#decide(ApprovalDecision.approveAlways(), "approved_always");
  }

  deny(): void {
    this.#decide(ApprovalDecision.deny(), "denied");
  }

  /** @internal */
  setState(state: ApprovalState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.notify();
  }

  #decide(decision: ApprovalDecision, state: ApprovalState): void {
    if (!this.#pending?.resolve(decision)) return;
    this.setState(state);
  }
}

export type NoticeSeverity = "info" | "warning" | "blocked" | "error";

/** A refusal, a limit, an error, or a feature's notice ("3 names masked locally"). */
export class NoticePart extends ResponsePart {
  readonly kind = "notice";

  constructor(
    readonly severity: NoticeSeverity,
    readonly title: string,
    readonly message: string,
    /** For support: the decision id of a refusal. */
    readonly detail?: string,
  ) {
    super();
  }

  static from(notice: GovernanceNotice, strings: UiStrings): NoticePart {
    const severity: NoticeSeverity = notice.outcome === "prompt_blocked" || notice.outcome === "response_blocked" ? "blocked"
      : notice.outcome === "tool_denied" || notice.outcome === "rate_limited" || notice.outcome === "budget_exceeded" ? "warning"
      : "info";
    const title = strings.noticeTitles[notice.outcome] ?? strings.noticeFallback;
    const message = notice.retryAfterMs !== undefined
      ? `${notice.message} ${strings.tryAgainIn(Math.ceil(notice.retryAfterMs / 1000))}`
      : notice.message;
    return new NoticePart(severity, title, message, notice.decisionId ? strings.decision(notice.decisionId) : undefined);
  }
}

export interface Citation {
  title: string;
  detail?: string;
  score?: number;
}

/** "Used 3 references", expandable. */
export class CitationsPart extends ResponsePart {
  readonly kind = "citations";
  readonly #context: PartContext;
  #citations: readonly Citation[];
  #expanded = false;

  constructor(context: PartContext, citations: readonly Citation[]) {
    super();
    this.#context = context;
    this.#citations = citations;
  }

  get citations(): readonly Citation[] {
    return this.#citations;
  }

  get title(): string {
    return this.#context.strings.usedReferences(this.#citations.length);
  }

  get isExpanded(): boolean {
    return this.#expanded;
  }

  toggle(): void {
    this.#expanded = !this.#expanded;
    this.notify();
  }

  /** @internal */
  add(more: readonly Citation[]): void {
    this.#citations = [...this.#citations, ...more];
    this.notify();
  }
}

// -- primitives for features and modules ------------------------------------------

/** A titled card with fields. */
export class CardPart extends ResponsePart {
  readonly kind = "card";

  constructor(readonly title: string, readonly fields: readonly { label: string; value: string }[], readonly subtitle?: string) {
    super();
  }
}

/** A plain table. */
export class TablePart extends ResponsePart {
  readonly kind = "table";

  constructor(readonly headers: readonly string[], readonly rows: readonly (readonly string[])[], readonly title?: string) {
    super();
  }
}

/** Progress: a value from 0 to 1, or none for "working". */
export class ProgressPart extends ResponsePart {
  readonly kind = "progress";
  #label: string;
  #value: number | undefined;

  constructor(label: string, value?: number) {
    super();
    this.#label = label;
    this.#value = value;
  }

  get label(): string {
    return this.#label;
  }

  get value(): number | undefined {
    return this.#value;
  }

  update(label: string, value?: number): void {
    this.#label = label;
    this.#value = value;
    this.notify();
  }
}

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

/** A change, line by line (e.g. what a write tool would do). */
export class DiffPart extends ResponsePart {
  readonly kind = "diff";

  constructor(readonly title: string, readonly lines: readonly DiffLine[]) {
    super();
  }
}

export type AnyPart =
  | MarkdownPart
  | ReasoningPart
  | ToolCallPart
  | ApprovalPart
  | NoticePart
  | CitationsPart
  | CardPart
  | TablePart
  | ProgressPart
  | DiffPart;
