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
  /**
   * Whether "Allow for this chat" may be offered. Never for a destructive or unclassified tool, nor for a call an
   * admin's "Ask first" rule covers: those ask every time.
   */
  canAllowForSession?: boolean;
  /** Whether "Allow always" may be offered: where "Allow for this chat" may. */
  canAllowAlways?: boolean;
  /** An admin's "Ask first" rule covers the call: `reason` is the admin's message. It asks every time. */
  requiredByRule?: boolean;
}

/** What the user decided. */
export interface ApprovalDecision {
  approved: boolean;
  /**
   * Approve this tool for the rest of this session (in memory: not when the session is opened again). Taken only
   * where the request offers it (`canAllowForSession`); otherwise it approves this call only.
   */
  forSession?: boolean;
  /**
   * Approve this tool on this device for good, until the approvals are reset. Taken only where the request offers
   * it (`canAllowAlways`); otherwise it approves this call only.
   */
  always?: boolean;
  reason?: string;
}

export const ApprovalDecision = {
  approve: (): ApprovalDecision => ({ approved: true }),
  approveForSession: (): ApprovalDecision => ({ approved: true, forSession: true }),
  approveAlways: (): ApprovalDecision => ({ approved: true, always: true }),
  deny: (reason?: string): ApprovalDecision => (reason === undefined ? { approved: false } : { approved: false, reason }),
};

/** What let a call that needed approval through: the user for this call, this chat, always, or bypass mode. */
export type ApprovalScope = "once" | "chat" | "always" | "bypass";

/**
 * Whether the SDK asks (`ask`, the default) or approves every call it would ask about (`bypass`), destructive ones
 * too. Bypass is for development and trusted automation, set in the app's code, never by a user; an admin's
 * "Ask first" rule still asks.
 */
export type PermissionMode = "ask" | "bypass";

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
