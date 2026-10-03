import type { ChatMessage, WireToolCall } from "@fadenstack/client";

import { EntryTypes, TurnStatus, type TranscriptEntry } from "./transcript.js";

type Data = Record<string, unknown>;
const str = (data: Data, key: string): string | undefined => (typeof data[key] === "string" ? (data[key] as string) : undefined);

/**
 * Builds a request's history from the transcript, with the session rule of 04 §8 applied on the device: a
 * refused prompt, a failed or cancelled turn is left out whole; of a refused answer only the question stays;
 * consecutive user messages are merged; and the oldest turns go when the history passes the budget.
 */
export class ContextBuilder {
  /** About this many tokens of history (4 characters a token); the newest turns are kept. */
  tokenBudget: number;

  constructor(tokenBudget = 24_000) {
    this.tokenBudget = tokenBudget;
  }

  build(entries: readonly TranscriptEntry[]): ChatMessage[] {
    const status = new Map<string, string>();
    for (const e of entries) if (e.type === EntryTypes.turnEnd && e.turnId) status.set(e.turnId, e.status ?? TurnStatus.ok);
    const turns: ChatMessage[][] = [];
    let current: string | null = null;
    for (const entry of entries) {
      if (!entry.turnId) continue;
      const turnStatus = status.get(entry.turnId) ?? TurnStatus.ok; // in progress: all of it
      if (turnStatus === TurnStatus.promptBlocked || turnStatus === TurnStatus.error || turnStatus === TurnStatus.cancelled) continue;
      if (turnStatus === TurnStatus.responseBlocked && entry.type !== EntryTypes.userMessage) continue;
      const message = toMessage(entry);
      if (!message) continue;
      if (entry.turnId !== current) {
        turns.push([]);
        current = entry.turnId;
      }
      turns[turns.length - 1]!.push(message);
    }
    return merge(this.#trim(turns));
  }

  #trim(turns: ChatMessage[][]): ChatMessage[] {
    const kept: ChatMessage[][] = [];
    let budget = this.tokenBudget * 4;
    for (let i = turns.length - 1; i >= 0; i--) {
      const size = turns[i]!.reduce((sum, m) => sum + sizeOf(m), 0);
      if (kept.length > 0 && size > budget) break; // the newest turn always goes, whatever its size
      budget -= size;
      kept.unshift(turns[i]!);
    }
    return kept.flat();
  }
}

function sizeOf(message: ChatMessage): number {
  const content = typeof message.content === "string" ? message.content.length
    : Array.isArray(message.content) ? message.content.reduce((n, p) => n + ("text" in p ? p.text.length : 0), 0) : 0;
  const calls = message.role === "assistant" ? (message.tool_calls ?? []).reduce((n, c) => n + 32 + c.function.arguments.length, 0) : 0;
  return content + calls;
}

/** Strict chat templates refuse roles that do not alternate: adjacent user messages become one. */
function merge(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous?.role === "user" && message.role === "user") {
      merged[merged.length - 1] = { role: "user", content: `${textOf(previous)}\n\n${textOf(message)}` };
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((p) => ("text" in p ? p.text : "")).join("");
  return "";
}

/** One transcript entry as a message for the model, or undefined. */
export function toMessage(entry: TranscriptEntry): ChatMessage | undefined {
  const data = entry.data;
  switch (entry.type) {
    case EntryTypes.userMessage:
      return { role: "user", content: withAttachments(data) };
    case EntryTypes.assistantMessage: {
      const text = str(data, "text") ?? "";
      const calls: WireToolCall[] = Array.isArray(data["tool_calls"])
        ? (data["tool_calls"] as Data[]).map((c) => ({
            id: str(c, "id") ?? "",
            type: "function" as const,
            function: { name: str(c, "name") ?? "", arguments: str(c, "arguments") ?? "{}" },
          }))
        : [];
      if (!text && calls.length === 0) return undefined;
      return calls.length ? { role: "assistant", content: text || null, tool_calls: calls } : { role: "assistant", content: text };
    }
    case EntryTypes.toolComplete:
      return { role: "tool", tool_call_id: str(data, "call_id") ?? "", content: str(data, "result") ?? "" };
    default:
      return undefined;
  }
}

/**
 * The user's text after what they attached, each in an `<attachment>` block the model can tell apart from
 * the question.
 */
export function withAttachments(data: Data): string {
  const text = str(data, "text") ?? "";
  const list = Array.isArray(data["attachments"]) ? (data["attachments"] as Data[]) : [];
  if (list.length === 0) return text;
  let out = "";
  for (const a of list) {
    out += `<attachment title="${attr(str(a, "title"))}"`;
    for (const name of ["kind", "source", "reference"]) {
      const value = str(a, name);
      if (value) out += ` ${name}="${attr(value)}"`;
    }
    out += `>\n${str(a, "content") ?? ""}\n</attachment>\n\n`;
  }
  return out + text;
}

function attr(value: string | undefined): string {
  return (value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
