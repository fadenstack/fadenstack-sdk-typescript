import type { ToolClass, ToolMode } from "@fadenstack/client";

/**
 * Every text the chat shows, in one place: a host passes its own (another language, its own words) through
 * `AgentChatOptions.strings`. English by default.
 */
export interface UiStrings {
  // the turn
  working: string;
  stopped: string;
  failed: string;
  tokens(count: string): string;
  notAttached(title: string): string;
  // tools
  toolRunning(name: string): string;
  toolWaiting(name: string): string;
  toolRan(name: string): string;
  toolFailed(name: string): string;
  toolDenied(name: string): string;
  toolStopped(name: string): string;
  toolClass: Record<ToolClass, string>;
  moreCharacters(count: string): string;
  // approvals
  approvalTitle(name: string): string;
  approvalClass: Record<ToolClass, string>;
  serverTool: string;
  allow: string;
  allowForChat: string;
  deny: string;
  allowed: string;
  allowedForChat: string;
  denied: string;
  noAnswer: string;
  // notices
  noticeTitles: Record<string, string>;
  noticeFallback: string;
  tryAgainIn(seconds: number): string;
  decision(id: string): string;
  piiTitle: string;
  piiMessage(total: number, list: string): string;
  // reasoning and references
  thinking: string;
  thoughtFor(seconds: number): string;
  usedReferences(count: number): string;
  part(number: number): string;
  // the chat
  greetingFallback(agent: string): string;
  newChat: string;
  yesterday: string;
  modes: Record<ToolMode, { label: string; description: string }>;
  limitedTo(description: string, mode: string): string;
  // the skin's controls
  send: string;
  stop: string;
  history: string;
  noHistory: string;
  deleteSession: string;
  toolMode: string;
  showEarlier: string;
  copy: string;
  copyCode: string;
  copied: string;
  edit: string;
  editAndResend: string;
  retry: string;
  notSent: string;
  composerPlaceholder: string;
  removeAttachment: string;
  includeAttachment: string;
  arguments: string;
  result: string;
}

export const englishStrings: UiStrings = {
  working: "Working...",
  stopped: "Stopped",
  failed: "Something went wrong",
  tokens: (count) => `${count} tokens`,
  notAttached: (title) => `${title} was not attached`,
  toolRunning: (name) => `Running ${name}`,
  toolWaiting: (name) => `${name} is waiting for your approval`,
  toolRan: (name) => `Ran ${name}`,
  toolFailed: (name) => `${name} failed`,
  toolDenied: (name) => `${name} was not run`,
  toolStopped: (name) => `${name} was stopped`,
  toolClass: { read: "Read", write: "Write", destructive: "Destructive", unknown: "Unclassified" },
  moreCharacters: (count) => `... (${count} more characters)`,
  approvalTitle: (name) => `Run ${name}?`,
  approvalClass: { read: "Read", write: "Changes data", destructive: "Cannot be undone", unknown: "Unclassified" },
  serverTool: "Server tool",
  allow: "Allow",
  allowForChat: "Allow for this chat",
  deny: "Deny",
  allowed: "Allowed",
  allowedForChat: "Allowed for this chat",
  denied: "Denied",
  noAnswer: "No answer in time",
  noticeTitles: {
    prompt_blocked: "Your message was not sent",
    response_blocked: "The answer was stopped",
    tool_denied: "A tool was not allowed",
    rate_limited: "Too many requests",
    budget_exceeded: "Budget used up",
    round_limit: "Stopped",
  },
  noticeFallback: "Notice",
  tryAgainIn: (seconds) => `Try again in ${seconds} s.`,
  decision: (id) => `Decision ${id}`,
  piiTitle: "Personal data protected",
  piiMessage: (total, list) => `${total} value${total === 1 ? "" : "s"} kept from the model: ${list}`,
  thinking: "Thinking...",
  thoughtFor: (seconds) => `Thought for ${seconds} s`,
  usedReferences: (count) => (count === 1 ? "Used 1 reference" : `Used ${count} references`),
  part: (n) => `Part ${n}`,
  greetingFallback: (agent) => `Ask ${agent} anything.`,
  newChat: "New chat",
  yesterday: "Yesterday",
  modes: {
    off: { label: "Off", description: "No tools: the agent only answers." },
    read_only: { label: "Read only", description: "Only tools that change nothing." },
    ask: { label: "Ask", description: "Asks before anything that changes something." },
    auto: { label: "Auto", description: "Runs tools that change things; still asks before anything that cannot be undone." },
  },
  limitedTo: (description, mode) => `${description} Limited to ${mode} by your organisation.`,
  send: "Send",
  stop: "Stop",
  history: "Chat history",
  noHistory: "No chats yet.",
  deleteSession: "Delete chat",
  toolMode: "Tool mode",
  showEarlier: "Show earlier messages",
  copy: "Copy",
  copyCode: "Copy code",
  copied: "Copied",
  edit: "Edit",
  editAndResend: "Edit and resend",
  retry: "Retry",
  notSent: "Not sent",
  composerPlaceholder: "Ask anything",
  removeAttachment: "Remove",
  includeAttachment: "Include in the next message",
  arguments: "Input",
  result: "Output",
};

/** The English strings with the host's changes on top. */
export function withStrings(changes: Partial<UiStrings> | undefined): UiStrings {
  if (!changes) return englishStrings;
  return {
    ...englishStrings,
    ...changes,
    toolClass: { ...englishStrings.toolClass, ...changes.toolClass },
    approvalClass: { ...englishStrings.approvalClass, ...changes.approvalClass },
    noticeTitles: { ...englishStrings.noticeTitles, ...changes.noticeTitles },
    modes: { ...englishStrings.modes, ...changes.modes },
  };
}
