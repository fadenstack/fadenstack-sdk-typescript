import type { ToolServiceCall } from "./stages.js";

/**
 * An answer the person copies out of the chat: its Markdown as text, and the same as HTML when the host has it. The chat's
 * own Copy and an app's own view of answers both hand it to `agent.markCopy`. .NET: `AnswerCopy`.
 */
export interface AnswerCopy {
  /** The answer's Markdown, or a table as tab-separated values. */
  text: string;
  /** The same as HTML; absent for text only. */
  html?: string;
  /** The id of the chat the answer is in, for the transcript entry. */
  chat?: string;
  /** The id of the turn the answer came from, to link the record to the turn's receipt. */
  turn?: string;
  /** The text is code (a code block): code is exempt from marking. */
  code?: boolean;
  /**
   * The text is a Markdown file the person saves (the chat's export), not a copy: it is marked in its front matter, and
   * `MarkedCopy.text` is the file with it. `html` is not used. .NET: `IsFile`.
   */
  file?: boolean;
}

/** What goes on the clipboard: the text as it was, and the HTML with its mark when it was marked. .NET: `MarkedCopy`. */
export interface MarkedCopy {
  /** The text to copy: the text as it was given (for a `file`, the file with its front matter). */
  text: string;
  /** The HTML to copy, marked when `marked`; absent when none was given (or the copy was refused). */
  html?: string;
  /** The id of the record signed for this copy. */
  recordId?: string;
  /** The HTML carries the mark. */
  marked: boolean;
  /** The agent's policy refuses a copy that cannot be marked, and this one could not be: nothing is to be copied, and the chat says so. */
  refused?: boolean;
  /** Why the copy needs no mark (a short label, code, an exempt kind of edit); absent when it was not exempt. */
  exemptBecause?: string;
}

/**
 * What a copy marker needs of the agent that made it: a call that is no tool call, to place content with. The tool is
 * `copy`, the chat and turn are the copy's, and its transcript entries go into the chat when the agent gave that chat out.
 */
export interface AnswerCopyHost {
  call(copy: AnswerCopy, signal: AbortSignal): ToolServiceCall;
}

/**
 * Marks what is copied out of a chat. `@fadenstack/provenance` registers one when its module is on the builder
 * (`AgentBuilder.useAnswerCopyMarker`). .NET: `IAnswerCopyMarker`.
 */
export interface AnswerCopyMarker {
  /** Marks `copy`, with the same policy, record and report as a tool's placement. */
  mark(copy: AnswerCopy, signal?: AbortSignal): Promise<MarkedCopy>;
}
