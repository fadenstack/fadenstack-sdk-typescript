import type { ChatMessage, ContentPart, WireToolCall } from "@fadenstack/client";

import { EntryTypes, TurnStatus, type TranscriptEntry } from "./transcript.js";

type Data = Record<string, unknown>;
const str = (data: Data, key: string): string | undefined => (typeof data[key] === "string" ? (data[key] as string) : undefined);

/**
 * Pictures the history carries at most, the newest: each costs the model about as much as a page of text, and the
 * question is mostly about the last one. Older ones are named in their place.
 */
export const MAX_HISTORY_PICTURES = 4;
/** What a picture counts for in the history budget, in characters (about a thousand tokens). */
const PICTURE_CHARACTERS = 4_000;

/**
 * What the model gets for a tool that returned nothing (`undefined`, `null`, an empty or a blank string): given an
 * empty tool message, some models stop, guess or end the turn without a word. For the model only, so in English; the
 * transcript and the tool card keep what the tool returned.
 */
export const NO_TOOL_RESULT = "The tool returned no result.";

/**
 * White space as .NET's `char.IsWhiteSpace` counts it, not as JavaScript's `\s` (which takes U+FEFF and leaves out
 * U+0085), so both SDKs take the same text for blank.
 */
const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;

/** Empty, or white space only. */
const isBlank = (text: string): boolean => BLANK.test(text);

/**
 * Builds a request's history from the transcript, with the session rule applied on the device: a
 * refused prompt, a failed or cancelled turn is left out whole; of a refused answer only the question stays;
 * consecutive user messages are merged; and the oldest turns go when the history passes the budget. Pictures go
 * with the newest messages only (`MAX_HISTORY_PICTURES`).
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
    const newest = [...entries].reverse().find((e) => e.turnId)?.turnId;
    const included = (entry: TranscriptEntry): boolean => {
      // The newest turn without an end is in progress: all of it. An older one was cut off (the app closed while
      // it ran): left out as a cancelled one is, so no tool call goes without its result.
      const turnStatus = status.get(entry.turnId!) ?? (entry.turnId === newest ? TurnStatus.ok : TurnStatus.cancelled);
      if (turnStatus === TurnStatus.promptBlocked || turnStatus === TurnStatus.error || turnStatus === TurnStatus.cancelled) return false;
      return turnStatus !== TurnStatus.responseBlocked || entry.type === EntryTypes.userMessage;
    };
    const withPictures = newestPictures(entries.filter((e) => e.turnId && included(e)));
    const turns: ChatMessage[][] = [];
    let current: string | null = null;
    for (const entry of entries) {
      if (!entry.turnId || !included(entry)) continue;
      const message = toMessage(entry, { pictures: withPictures.has(entry) });
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

/** The user messages whose pictures still go: the newest, up to `MAX_HISTORY_PICTURES` pictures in all. */
function newestPictures(entries: readonly TranscriptEntry[]): Set<TranscriptEntry> {
  const chosen = new Set<TranscriptEntry>();
  let left = MAX_HISTORY_PICTURES;
  for (let i = entries.length - 1; i >= 0 && left > 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== EntryTypes.userMessage) continue;
    const count = picturesOf(entry.data).length;
    if (count === 0) continue;
    if (count > left && chosen.size > 0) break;
    chosen.add(entry);
    left -= count;
  }
  return chosen;
}

function sizeOf(message: ChatMessage): number {
  const content = typeof message.content === "string" ? message.content.length
    : Array.isArray(message.content) ? message.content.reduce((n, p) => n + ("text" in p ? p.text.length : PICTURE_CHARACTERS), 0) : 0;
  const calls = message.role === "assistant" ? (message.tool_calls ?? []).reduce((n, c) => n + 32 + c.function.arguments.length, 0) : 0;
  return content + calls;
}

/** Strict chat templates refuse roles that do not alternate: adjacent user messages become one. */
function merge(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous?.role === "user" && message.role === "user") {
      merged[merged.length - 1] = typeof previous.content === "string" && typeof message.content === "string"
        ? { role: "user", content: `${previous.content}\n\n${message.content}` }
        : { role: "user", content: joinParts(partsOf(previous.content), partsOf(message.content)) };
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function partsOf(content: string | ContentPart[]): ContentPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** Two messages' parts as one, the text between them kept apart as it is between two messages. */
function joinParts(first: ContentPart[], second: ContentPart[]): ContentPart[] {
  const last = first[first.length - 1];
  const next = second[0];
  if (last?.type === "text" && next?.type === "text") {
    return [...first.slice(0, -1), { type: "text", text: `${last.text}\n\n${next.text}` }, ...second.slice(1)];
  }
  return [...first, ...second];
}

/**
 * One transcript entry as a message for the model, or undefined. A user message's pictures go as image parts
 * unless `pictures` is false (an older message: they are named instead).
 */
export function toMessage(entry: TranscriptEntry, options: { pictures?: boolean } = {}): ChatMessage | undefined {
  const data = entry.data;
  switch (entry.type) {
    case EntryTypes.userMessage: {
      const pictures = options.pictures !== false ? picturesOf(data) : [];
      const text = withAttachments(data, { pictures: options.pictures !== false });
      if (pictures.length === 0) return { role: "user", content: text };
      // The pictures first, then what was said about them: the question comes last, as with the other attachments.
      return {
        role: "user",
        content: [...pictures.map((url): ContentPart => ({ type: "image_url", image_url: { url } })), { type: "text", text }],
      };
    }
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
    case EntryTypes.toolComplete: {
      const result = str(data, "result") ?? "";
      return { role: "tool", tool_call_id: str(data, "call_id") ?? "", content: isBlank(result) ? NO_TOOL_RESULT : result };
    }
    default:
      return undefined;
  }
}

function attachmentsOf(data: Data): Data[] {
  return Array.isArray(data["attachments"]) ? (data["attachments"] as Data[]) : [];
}

const isPictureData = (a: Data): boolean => (str(a, "media_type") ?? "").startsWith("image/");

/** The `data:` URLs of a user message's pictures. */
function picturesOf(data: Data): string[] {
  return attachmentsOf(data).filter(isPictureData).map((a) => str(a, "content") ?? "").filter((url) => url.startsWith("data:image/"));
}

/**
 * The user's text after what they attached, each in an `<attachment>` block the model can tell apart from
 * the question. A picture goes as an image part, not here; one that is no longer sent (`pictures` false) is named.
 */
export function withAttachments(data: Data, options: { pictures?: boolean } = {}): string {
  const text = str(data, "text") ?? "";
  const list = attachmentsOf(data);
  if (list.length === 0) return text;
  let out = "";
  for (const a of list) {
    const picture = isPictureData(a);
    if (picture && options.pictures !== false) continue;
    out += `<attachment title="${attr(str(a, "title"))}"`;
    for (const name of ["kind", "source", "reference"]) {
      const value = str(a, name);
      if (value) out += ` ${name}="${attr(value)}"`;
    }
    const content = picture ? "[A picture the user attached earlier; it is not sent again.]" : str(a, "content") ?? "";
    out += `>\n${content}\n</attachment>\n\n`;
  }
  return out + text;
}

function attr(value: string | undefined): string {
  return (value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
