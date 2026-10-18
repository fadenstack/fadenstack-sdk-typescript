import type { AgentClientEvent, AgentProfile, ChatStreamer, FadenstackClient, GovernanceNotice, ToolClass } from "@fadenstack/client";

import type { AgentTool, ToolCallContext } from "./tools.js";

/**
 * Where a stage sits: the builder owns the order. Outgoing: context → local PII masking → provenance (the turn's
 * receipts) → transport. A tool call: approval (the loop) → unmask arguments → provenance (did declared content go
 * through `place()`) → run → mask the result. A lower number is further from the transport; modules pick their
 * slot, not their call order.
 */
export const StageOrder = {
  context: 100,
  pii: 200,
  provenance: 300,
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
  readonly client: FadenstackClient;
  readonly profile: AgentProfile;
  /** Reports an event to the server (names and counts, never content). */
  report(event: AgentClientEvent): Promise<void>;
}

/** What a tool service's factory knows about the call it serves (`AgentBuilder.addToolService`). */
export interface ToolServiceCall {
  readonly tool: AgentTool;
  /** The class the call runs under: the stricter of the tool's own and the server's. */
  readonly toolClass: ToolClass;
  /** The arguments the tool gets (after the stages that change them, once the tool runs). */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly callId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Aborted when the turn is stopped. */
  readonly signal: AbortSignal;
  /** The running agent: its client and profile. */
  readonly agent: AgentContext;
  /**
   * Adds an entry of the module's own type (`provenance.placed`) to the session's transcript, under this call's turn.
   * Ids, names and counts, never content. A type of the SDK's own (`EntryTypes`) is refused: the transcript is what
   * requests are built from.
   */
  record(type: string, data: Record<string, unknown>): Promise<void>;
  /** Raises a notice on the turn, for the user (the provenance module's `provenance_refused`), as the gateway's are. */
  notice(notice: GovernanceNotice): Promise<void>;
}

/** Makes a module's service for one call; called on the call's first `services.get(key)`. */
export type ToolServiceFactory<T> = (call: ToolServiceCall) => T;

/** Adds tools once the agent's profile is known, e.g. MCP servers under the agent's policy. */
export interface ToolSource {
  getTools(context: AgentContext, signal?: AbortSignal): Promise<readonly AgentTool[]>;
  dispose?(): void | Promise<void>;
}

/**
 * A package that plugs into the agent. It is active only when added to the builder, never by being installed.
 */
export interface FadenstackModule {
  /** The name an agent profile's `required_client_modules` uses (`pii.local`, `provenance`), or undefined. */
  readonly name?: string;
  configure(builder: import("./builder.js").AgentBuilder): void;
}
