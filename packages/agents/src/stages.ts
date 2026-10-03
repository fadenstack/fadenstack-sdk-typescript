import type { AgentClientEvent, AgentProfile, ChatStreamer, FadenClient, ToolClass } from "@fadenstack/client";

import type { AgentTool, ToolCallContext } from "./tools.js";

/**
 * Where a stage sits (01-design §4, "the builder owns the order"). Outgoing: context → local PII masking →
 * transport. A tool call: approval (the loop) → unmask arguments → run → mask the result. A lower number is
 * further from the transport; modules pick their slot, not their call order.
 */
export const StageOrder = {
  context: 100,
  pii: 200,
  custom: 500,
} as const;

/** Wraps the chat (e.g. to mask what goes out). */
export type ChatStage = (inner: ChatStreamer) => ChatStreamer;

/** One tool call on its way to the tool. */
export interface ToolInvocation {
  readonly tool: AgentTool;
  /** The arguments the tool gets; a stage may replace them (e.g. put masked values back). */
  arguments: Record<string, unknown>;
  readonly toolClass: ToolClass;
  readonly context: ToolCallContext;
}

export type ToolInvoker = (invocation: ToolInvocation) => Promise<unknown>;

/** Wraps a tool call: sees the arguments before, the result after. */
export interface ToolStage {
  invoke(invocation: ToolInvocation, next: ToolInvoker): Promise<unknown>;
}

/** What a tool source or module can see of the running agent. */
export interface AgentContext {
  readonly client: FadenClient;
  readonly profile: AgentProfile;
  /** Reports an event to the server (names and counts, never content: 06 §5). */
  report(event: AgentClientEvent): Promise<void>;
}

/** Adds tools once the agent's profile is known, e.g. MCP servers under the agent's policy. */
export interface ToolSource {
  getTools(context: AgentContext, signal?: AbortSignal): Promise<readonly AgentTool[]>;
  dispose?(): void | Promise<void>;
}

/**
 * A package that plugs into the agent. It is active only when added to the builder, never by being installed.
 */
export interface FadenModule {
  /** The name an agent profile's `required_client_modules` uses (`pii.local`), or undefined. */
  readonly name?: string;
  configure(builder: import("./builder.js").AgentBuilder): void;
}
