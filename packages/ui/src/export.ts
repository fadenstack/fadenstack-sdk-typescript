import { MarkdownPart, ToolCallPart } from "./parts.js";
import type { UiStrings } from "./strings.js";
import type { TurnViewModel } from "./turn.js";

/** What a chat's Markdown export is made of. */
export interface ChatExportInput {
  /** The chat's title (the first message, or the one the history shows); empty when it has none. */
  title: string;
  /** The agent's name, over each answer. */
  agent: string;
  /** The date under the title: when the chat began. */
  date: Date;
  /** For the date; the texts' language by default. */
  locale: string | undefined;
  strings: UiStrings;
  turns: readonly TurnViewModel[];
}

/** One line of text: line breaks and runs of white space become single spaces. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Each line as a Markdown quote, so a message that holds `#` or `---` cannot change the document's structure. */
const quoted = (text: string): string => text.replace(/\r\n?/g, "\n").split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");

/**
 * A chat as one Markdown document: the title, the date, then each turn in order -- the person's message under their label,
 * the titles (never the content) of the skills and attachments that went with it, and the agent's answer under its name,
 * with one line for every tool call. Reasoning and approval cards are left out.
 */
export function chatToMarkdown(input: ChatExportInput): string {
  const { strings: s, turns } = input;
  const lines: string[] = [`# ${oneLine(input.title) || s.exportChatTitle}`, "", formatDate(input.date, input.locale ?? s.language), ""];
  for (const turn of turns) {
    lines.push(`## ${s.exportYou}`, "", quoted(turn.userText), "");
    const skills = turn.attachments.filter((a) => a.skill).map((a) => oneLine(a.title)).filter(Boolean);
    const others = turn.attachments.filter((a) => !a.skill).map((a) => oneLine(a.title)).filter(Boolean);
    if (skills.length > 0) lines.push(`_${s.exportSkills(skills.join(", "))}_`, "");
    if (others.length > 0) lines.push(`_${s.exportAttachments(others.join(", "))}_`, "");
    const body: string[] = [];
    for (const part of turn.parts) {
      if (part instanceof MarkdownPart) {
        if (part.text.trim()) body.push(part.text.trim());
      } else if (part instanceof ToolCallPart) {
        body.push(`- ${oneLine(part.title)}`);
      }
    }
    if (body.length > 0) lines.push(`## ${oneLine(input.agent) || s.exportChatTitle}`, "", ...joinBlocks(body), "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Blocks of text with a blank line between them, except a run of tool lines, which stays one list. */
function joinBlocks(blocks: readonly string[]): string[] {
  const out: string[] = [];
  blocks.forEach((block, i) => {
    const list = block.startsWith("- ");
    const after = blocks[i - 1];
    if (i > 0 && !(list && after?.startsWith("- "))) out.push("");
    out.push(block);
  });
  return out;
}

function formatDate(date: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * A safe file name for a chat: the title's letters and digits with spaces as hyphens, at most 60 characters, `.md`.
 * `chat.md` when nothing is left (or the name is one Windows keeps for devices).
 */
export function chatFileName(title: string): string {
  const base = title
    .normalize("NFC")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return base && !RESERVED.test(base) ? `${base}.md` : "chat.md";
}
