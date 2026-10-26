/**
 * One line of a local session's transcript. The entry types and the `data` keys are the same in every
 * SDK. The transcript is the truth about a session: requests are built from it, and nothing of it is kept on
 * the server.
 */
export interface TranscriptEntry {
  id: string;
  parentId: string | null;
  /** ISO 8601. */
  timestamp: string;
  /** One of `EntryTypes`. */
  type: string;
  turnId: string | null;
  /** For a turn's end: one of `TurnStatus`. */
  status: string | null;
  /** The entry's content: text, tool calls, results, notices (snake_case keys, as in every SDK). */
  data: Record<string, unknown>;
}

export const EntryTypes = {
  sessionStart: "session.start",
  userMessage: "user.message",
  userCommand: "user.command",
  turnStart: "assistant.turn_start",
  assistantMessage: "assistant.message",
  toolStart: "tool.execution_start",
  toolComplete: "tool.execution_complete",
  approvalDecision: "approval.decision",
  governanceNotice: "governance.notice",
  compaction: "compaction",
  turnEnd: "assistant.turn_end",
} as const;

/** How a turn ended; blocked, failed and cancelled turns are not sent to the model again. */
export const TurnStatus = {
  ok: "ok",
  promptBlocked: "prompt_blocked",
  responseBlocked: "response_blocked",
  error: "error",
  cancelled: "cancelled",
} as const;

/** A local session, as listed. Times in ISO 8601. */
export interface SessionInfo {
  id: string;
  agent: string;
  started: string;
  lastActivity: string;
  title: string | null;
}

/** A new id: 32 hex characters (fits the gateway's id rules). */
export function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

/** A session's list entry from its entries: the first user message is its title. */
export function sessionInfo(agent: string, id: string, entries: readonly TranscriptEntry[]): SessionInfo {
  const first = entries[0]!;
  const user = entries.find((e) => e.type === EntryTypes.userMessage);
  const command = entries.find((e) => e.type === EntryTypes.userCommand);
  const text = typeof user?.data["text"] === "string" ? user.data["text"] : typeof command?.data["name"] === "string" ? command.data["name"] : null;
  return { id, agent, started: first.timestamp, lastActivity: entries[entries.length - 1]!.timestamp, title: titleOf(text) };
}

/** A session title from its first message: one line, up to 60 characters. */
export function titleOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}...`;
}
