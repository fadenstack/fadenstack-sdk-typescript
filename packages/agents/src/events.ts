import type { ChatOutcome, FadenstackEvent, GovernanceNotice, ToolClass, ToolMode, Usage } from "@fadenstack/client";

import type { ApprovalDecision, ApprovalRequest } from "./approvals.js";

/**
 * What happens during a turn, in order, for a UI to render (AG-UI's vocabulary in our own types).
 * Every event names its turn.
 */
export type AgentEvent =
  | { type: "turn_started"; turnId: string; toolMode: ToolMode }
  | { type: "text"; turnId: string; text: string }
  | { type: "reasoning"; turnId: string; text: string }
  /** A tool starts: one of the agent's (`host`, `mcp`) or one the gateway runs (`gateway`). */
  | {
      type: "tool_started";
      turnId: string;
      callId: string;
      name: string;
      toolClass: ToolClass;
      source: string;
      arguments: Readonly<Record<string, unknown>>;
    }
  /** A tool ended: `ok`, `error`, `denied` or `cancelled`. Its duration leaves out the wait for an approval. */
  | {
      type: "tool_completed";
      turnId: string;
      callId: string;
      name: string;
      source: string;
      outcome: ToolOutcome;
      result: string | undefined;
      durationMs: number;
    }
  /** A call waits for the user; the approval handler is asked right after. */
  | { type: "approval_requested"; turnId: string; request: ApprovalRequest }
  | { type: "approval_decided"; turnId: string; request: ApprovalRequest; decision: ApprovalDecision }
  /** A refusal or a limit, to show on the turn. */
  | { type: "notice"; turnId: string; notice: GovernanceNotice }
  /** Any other gateway event (citations, a PII notice, events core does not know yet). */
  | { type: "gateway_event"; turnId: string; event: FadenstackEvent }
  | { type: "turn_completed"; turnId: string; result: AgentResult };

export type ToolOutcome = "ok" | "error" | "denied" | "cancelled";

/** How a turn ended. A refusal is a result, not an error. */
export interface AgentResult {
  turnId: string;
  outcome: ChatOutcome;
  /** The answer's text (what was shown before a refusal, for a refused answer). */
  text: string;
  notices: readonly GovernanceNotice[];
  usage: Usage | undefined;
}
