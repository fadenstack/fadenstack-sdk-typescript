/**
 * How a turn ended. A refusal is part of the result, not an error: the user sees the notice on the
 * turn and goes on in the same session.
 */
export type ChatOutcome =
  | "completed"
  /** An input check refused the prompt; nothing of it reached a model. */
  | "prompt_blocked"
  /** An output check stopped the answer; tool calls in it are never run. */
  | "response_blocked"
  /** At least one tool call was refused (the answer may still be complete). */
  | "tool_denied"
  /** A limit applied (429); the notice carries the server's message. */
  | "rate_limited";

/** What the user is told about a refusal, and what an auditor finds it by. */
export interface GovernanceNotice {
  /** `prompt_blocked`, `response_blocked`, `tool_denied`, `rate_limited`, `round_limit`, ... */
  outcome: string;
  /** `input`, `output`, `tool`. */
  stage?: string;
  category?: string;
  /** The admin's message for the policy: what the user is told. */
  message: string;
  decisionId?: string;
  requestId?: string;
  /** For a limit (429): when to try again. */
  retryAfterMs?: number;
}

/** A notice from the gateway's `governance` object (snake_case on the wire). */
export function readNotice(value: unknown, retryAfterMs?: number): GovernanceNotice {
  const g = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const s = (key: string) => (typeof g[key] === "string" ? (g[key] as string) : undefined);
  const notice: GovernanceNotice = { outcome: s("outcome") ?? "", message: s("message") ?? "" };
  const stage = s("stage");
  const category = s("category");
  const decisionId = s("decision_id");
  const requestId = s("request_id");
  if (stage !== undefined) notice.stage = stage;
  if (category !== undefined) notice.category = category;
  if (decisionId !== undefined) notice.decisionId = decisionId;
  if (requestId !== undefined) notice.requestId = requestId;
  if (retryAfterMs !== undefined) notice.retryAfterMs = retryAfterMs;
  return notice;
}
