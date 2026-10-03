import type { ToolClass } from "@fadenstack/client";

/** A tool call that waits for the user. */
export interface ApprovalRequest {
  callId: string;
  toolName: string;
  toolClass: ToolClass;
  /** `host`, `mcp`, or `gateway` (a gateway tool the gateway holds for the user). */
  source: string;
  /** Why it asks: the tool mode, or the admin's message for a tool rule. */
  reason: string;
  /** The call's arguments, for the prompt (empty for gateway tools: the gateway keeps them). */
  arguments: Readonly<Record<string, unknown>>;
}

/** What the user decided. */
export interface ApprovalDecision {
  approved: boolean;
  /** Approve this tool for the rest of the session without asking again. */
  forSession?: boolean;
  reason?: string;
}

export const ApprovalDecision = {
  approve: (): ApprovalDecision => ({ approved: true }),
  approveForSession: (): ApprovalDecision => ({ approved: true, forSession: true }),
  deny: (reason?: string): ApprovalDecision => (reason === undefined ? { approved: false } : { approved: false, reason }),
};

/** Shows the prompt (a dialog, a card in the chat) and returns what the user decided. */
export interface ApprovalHandler {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

/** Nobody to ask: every call that needs approval is declined. The default. */
export const denyAllApprovals: ApprovalHandler = {
  request: () => Promise.resolve(ApprovalDecision.deny("Nobody is here to approve it.")),
};

/** An approval handler from a function. */
export function approvalsFrom(ask: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>): ApprovalHandler {
  return { request: ask };
}
