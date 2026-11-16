// AG-UI event shapes the adapter writes, as our own types. They follow AG-UI 1.0.4 (`@ag-ui/core`): same field names and
// optionality, `type` the plain string. This package has no run-time or type-level dependency on `@ag-ui/*`; the test
// suite checks the shapes against `@ag-ui/core` (a dev dependency) so drift fails the typecheck.

/** Fields every AG-UI event may carry (AG-UI 1.0.4). */
export interface AgUiBaseEvent {
  /** Milliseconds since the Unix epoch. */
  timestamp?: number;
  rawEvent?: unknown;
  metadata?: Record<string, unknown>;
}

/** The base fields plus the subagent a message or tool event belongs to (AG-UI 1.0.4). */
export interface AgUiSubagentEvent extends AgUiBaseEvent {
  subagentRunId?: string;
}

/** Token counts of one provider and model (AG-UI 1.0.4). */
export interface TokenUsage {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/** What a run that stopped for the user waits for (AG-UI 1.0.4). */
export interface Interrupt {
  subagentRunId?: string;
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  responseSchema?: Record<string, unknown>;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/** Why a run ended (AG-UI 1.0.4). */
export type RunFinishedOutcome =
  | { type: "success"; pendingToolCallIds?: string[] }
  | { type: "interrupt"; interrupts: Interrupt[] }
  | { type: "cancelled" };

export interface RunStartedEvent extends AgUiBaseEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  protocolVersion?: string;
  parentRunId?: string;
}

export interface RunFinishedEvent extends AgUiBaseEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  result?: unknown;
  outcome?: RunFinishedOutcome;
  usage?: TokenUsage[];
}

export interface RunErrorEvent extends AgUiBaseEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
  usage?: TokenUsage[];
}

export interface TextMessageStartEvent extends AgUiSubagentEvent {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role?: "developer" | "system" | "assistant" | "user";
  name?: string;
}

export interface TextMessageContentEvent extends AgUiSubagentEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

export interface TextMessageEndEvent extends AgUiSubagentEvent {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}

export interface ReasoningStartEvent extends AgUiSubagentEvent {
  type: "REASONING_START";
  messageId: string;
}

export interface ReasoningMessageStartEvent extends AgUiSubagentEvent {
  type: "REASONING_MESSAGE_START";
  messageId: string;
  role: "reasoning";
}

export interface ReasoningMessageContentEvent extends AgUiSubagentEvent {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

export interface ReasoningMessageEndEvent extends AgUiSubagentEvent {
  type: "REASONING_MESSAGE_END";
  messageId: string;
}

export interface ReasoningEndEvent extends AgUiSubagentEvent {
  type: "REASONING_END";
  messageId: string;
}

export interface ToolCallStartEvent extends AgUiSubagentEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface ToolCallArgsEvent extends AgUiSubagentEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
}

export interface ToolCallEndEvent extends AgUiSubagentEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
}

export interface ToolCallResultEvent extends AgUiSubagentEvent {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  /** The adapter writes text; AG-UI also allows content parts, which this package never emits. */
  content: string;
  role?: "tool";
}

export interface CustomEvent extends AgUiSubagentEvent {
  type: "CUSTOM";
  name: string;
  value: unknown;
}

/** An AG-UI event in the JSON a third-party AG-UI client reads (shapes of AG-UI 1.0.4). */
export type AgUiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | CustomEvent;
