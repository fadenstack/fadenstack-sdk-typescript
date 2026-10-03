import type { GovernanceNotice } from "../governance.js";
import type { ToolMode } from "../tools/toolModes.js";

/** A chat message in the OpenAI shape the gateway speaks. */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[]; name?: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A tool the model may call: its name, what it does, and its parameters as JSON Schema. */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: JsonSchema;
}

/** JSON Schema, as far as tool parameters use it. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
}

/** A tool call the model made, assembled whole. */
export interface ToolCall {
  id: string;
  name: string;
  /** The arguments as the model wrote them. */
  argumentsJson: string;
  /** The parsed arguments; undefined when they are not a JSON object (see `argumentsError`). */
  arguments: Record<string, unknown> | undefined;
  argumentsError?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
}

/**
 * One of the gateway's events (AG-UI vocabulary, 02 §7): a gateway tool starting or ending, citations, a PII
 * notice, a gateway round to keep, an approval the gateway waits for, a refused tool.
 */
export interface FadenEvent {
  /** AG-UI type: `TOOL_CALL_START`, `TOOL_CALL_END`, `CUSTOM`. */
  type: string;
  /** For `CUSTOM`: `faden.gateway_round`, `faden.approval_required`, ... */
  name?: string;
  value?: unknown;
  /** The whole event, as the gateway sent it. */
  raw: Record<string, unknown>;
}

/** `type`, or `name` for a custom event. */
export function eventKind(event: FadenEvent): string {
  return event.type === "CUSTOM" && event.name ? event.name : event.type;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | (string & {});

/** One step of a streamed answer, in order. */
export type ChatUpdate =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** Tool calls, whole, once the model finished writing them. */
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "usage"; usage: Usage }
  | { type: "event"; event: FadenEvent }
  /** The gateway refused the prompt (`prompt_blocked`) or stopped the answer (`response_blocked`). */
  | { type: "refused"; notice: GovernanceNotice }
  | { type: "finish"; reason: FinishReason; responseId?: string; model?: string };

/** A whole answer. */
export interface ChatResponse {
  id?: string;
  model?: string;
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason?: FinishReason;
  usage?: Usage;
  events: FadenEvent[];
  /** Set when the gateway refused the prompt or the answer. */
  refused?: GovernanceNotice;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** What one request asks for, beside its messages. */
export interface ChatOptions {
  /** The plain routes' model; an agent's model is the agent's, whatever this says. */
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  stop?: string[];
  /** How much a reasoning model thinks first; `none` answers at once. The gateway maps it per model. */
  reasoningEffort?: ReasoningEffort;
  responseFormat?: { type: "json_object" } | { type: "json_schema"; name?: string; schema: JsonSchema };
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  /** Groups usage per conversation without the server keeping it (`X-Faden-Conversation-Id`). */
  conversationId?: string;
  /** `X-Faden-Turn-Id`. */
  turnId?: string;
  /** The tool mode for this request (`X-Faden-Tool-Mode`); the client's default otherwise. */
  toolMode?: ToolMode;
  /** A server session, for the plain routes (web chat and API sessions); agents have none. */
  sessionId?: string;
  /** Skills picked by slug for this message (plain routes). */
  skills?: string[];
  /** More request fields, sent as they are. */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Anything that streams answers like the gateway: the chat client, or a stage wrapped around it. */
export interface ChatStreamer {
  stream(messages: readonly ChatMessage[], options?: ChatOptions): AsyncIterable<ChatUpdate>;
}
