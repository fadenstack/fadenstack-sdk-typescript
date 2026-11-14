import {
  DEFAULT_SKILL_PRIORITY,
  SkillLimits,
  createSkillDocument,
  extensionFieldsAreEmpty,
  type SkillDocument,
  type SkillExtensionFields,
} from "./skillAuthoring.js";

// SKILL.md as text (sdk/51 F04). .NET: SkillMarkdown.cs. Reads the frontmatter and the body, and writes them back with the six
// standard fields only. The frontmatter is untrusted input, so the reader is small and strict: top-level `key: value` lines,
// plain, quoted and block scalars, the `metadata` map and a list for `allowed-tools`; no anchors, aliases or tags, and nothing
// is expanded. Keys beyond the six are listed in `SkillDocument.unknownKeys`, never dropped silently.

const KEY = /^([\p{L}\p{Mn}\p{Nd}\p{Pc}][\p{L}\p{Mn}\p{Nd}\p{Pc}.-]*)\s*:(?:\s+(.*)|(.*))$/u;
const NAME_FORM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLAIN_SAFE = /^[A-Za-z][A-Za-z0-9 ._,/()+=-]*$/;
const WORDS = new Set(["true", "false", "yes", "no", "on", "off", "null", "y", "n"]);

/** A skill name made from any text: lower case, letters and digits with single hyphens, up to 64 characters, else `new-skill` (core's `slugify`). */
export function slugifySkillName(text: string | undefined | null): string {
  let slug = "";
  let hyphen = false;
  for (const c of (text ?? "").toLowerCase()) {
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) {
      slug += c;
      hyphen = false;
    } else if (!hyphen && slug.length > 0) {
      slug += "-";
      hyphen = true;
    }
  }
  slug = slug.replace(/^-+|-+$/g, "");
  if (slug.length > SkillLimits.nameMax) slug = slug.slice(0, SkillLimits.nameMax).replace(/-+$/, "");
  return NAME_FORM.test(slug) ? slug : "new-skill";
}

export type SkillMarkdownParse = { ok: true; document: SkillDocument } | { ok: false; error: string };

function shorten(text: string): string {
  return text.length > 40 ? text.slice(0, 40) : text;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function startsWithSpace(line: string): boolean {
  return line.length > 0 && /\s/.test(line[0]!);
}

/** Reads a SKILL.md. Not `ok` (with `error`) when there is no frontmatter or it is not readable. */
export function parseSkillMarkdown(input: string | undefined | null): SkillMarkdownParse {
  let text = input ?? "";
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let start = 0;
  while (start < lines.length && isBlank(lines[start]!)) start++;
  if (start >= lines.length || lines[start]!.trimEnd() !== "---") return { ok: false, error: "There is no frontmatter (the file must begin with ---)." };
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { ok: false, error: "The frontmatter is not closed with ---." };

  let name = "";
  let description = "";
  let license = "";
  let compatibility = "";
  let allowed = "";
  const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
  const unknown: string[] = [];
  const seen = new Set<string>();
  let index = start + 1;
  while (index < end) {
    const line = lines[index]!;
    if (isBlank(line) || line.trimStart().startsWith("#")) {
      index++;
      continue;
    }
    const match = line.length > 0 && !startsWithSpace(line) ? KEY.exec(line) : null;
    if (!match) return { ok: false, error: "A line of the frontmatter is not a key: " + shorten(line.trim()) };
    const key = match[1]!;
    const inline = (match[2] ?? match[3] ?? "").trim();
    const children: string[] = [];
    index++;
    while (index < end && (isBlank(lines[index]!) || startsWithSpace(lines[index]!) || lines[index]!.startsWith("- "))) {
      children.push(lines[index]!);
      index++;
    }
    if (seen.has(key)) return { ok: false, error: "The key " + shorten(key) + " is there twice." };
    seen.add(key);
    if (key === "metadata") {
      if (inline.length > 0 && inline !== "{}") return { ok: false, error: "metadata is a map of text to text." };
      for (const child of children.filter((c) => c.trim().length > 0 && !c.trim().startsWith("#"))) {
        const entry = KEY.exec(child.trim());
        if (!entry) return { ok: false, error: "metadata is a map of text to text." };
        const value = scalar((entry[2] ?? entry[3] ?? "").trim());
        if (value === undefined) return { ok: false, error: "A value in metadata is not readable." };
        metadata[entry[1]!] = value;
      }
      continue;
    }
    const value = readValue(inline, children);
    if (typeof value !== "string") return { ok: false, error: value.error };
    switch (key) {
      case "name": name = value; break;
      case "description": description = value; break;
      case "license": license = value; break;
      case "compatibility": compatibility = value; break;
      case "allowed-tools": allowed = value; break;
      default: unknown.push(shorten(key)); break;
    }
  }
  const body = lines.slice(end + 1).join("\n");
  const document = createSkillDocument({
    name: name.trim(),
    description: description.trim(),
    license: license.trim(),
    compatibility: compatibility.trim(),
    metadata: { ...metadata },
    allowedTools: allowed.trim(),
    instructions: body.replace(/^[\n \t]+|[\n \t]+$/g, "").length === 0 ? "" : body.replace(/^\n+/, "").trimEnd(),
    unknownKeys: unknown,
  });
  return { ok: true, document };
}

/** The value of a key: an inline scalar (with continuation lines for a plain one), a block scalar, or a list (joined with spaces). */
function readValue(inline: string, children: readonly string[]): string | { error: string } {
  if (inline.length > 0 && (inline[0] === "|" || inline[0] === ">") && inline.slice(1).replace(/^[-+ ]+|[-+ ]+$/g, "").length === 0) {
    const literal = inline[0] === "|";
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const child of children) {
      const trimmed = child.trim();
      if (trimmed.length === 0) {
        if (current.length > 0) {
          paragraphs.push(current.join(literal ? "\n" : " "));
          current = [];
        }
        continue;
      }
      current.push(trimmed);
    }
    if (current.length > 0) paragraphs.push(current.join(literal ? "\n" : " "));
    return paragraphs.join(literal ? "\n\n" : "\n");
  }
  const parts: string[] = [];
  if (inline.length > 0) parts.push(inline);
  for (const child of children.map((c) => c.trim()).filter((c) => c.length > 0 && !c.startsWith("#"))) {
    parts.push(child.startsWith("- ") ? child.slice(2).trim() : child);
  }
  if (parts.length === 0) return "";
  if (inline.length > 0 && (inline[0] === '"' || inline[0] === "'")) {
    if (parts.length > 1) return { error: "A quoted value runs over several lines." };
    const value = scalar(inline);
    return value === undefined ? { error: "A quoted value is not closed." } : value;
  }
  const items: string[] = [];
  for (const part of parts) {
    const item = scalar(part);
    if (item === undefined) return { error: "A value is not readable." };
    items.push(item);
  }
  return items.join(" ");
}

function restIsEnd(rest: string): boolean {
  const trimmed = rest.trim();
  return trimmed.length === 0 || rest.trimStart().startsWith("#");
}

/** A scalar's text; undefined when a quote is not closed, has something after it, or an escape is not one. */
function scalar(text: string): string | undefined {
  if (text.length === 0) return "";
  if (text[0] === '"') {
    let value = "";
    for (let i = 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === '"') return restIsEnd(text.slice(i + 1)) ? value : undefined;
      if (c !== "\\") {
        value += c;
        continue;
      }
      if (++i >= text.length) return undefined;
      switch (text[i]) {
        case "n": value += "\n"; break;
        case "t": value += "\t"; break;
        case "r": value += "\r"; break;
        case "0": value += "\0"; break;
        case '"': value += '"'; break;
        case "\\": value += "\\"; break;
        case "/": value += "/"; break;
        case "u": {
          const hex = text.slice(i + 1, i + 5);
          if (i + 4 < text.length && /^[0-9a-fA-F]{4}$/.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
            break;
          }
          return undefined;
        }
        default: return undefined;
      }
    }
    return undefined;
  }
  if (text[0] === "'") {
    let value = "";
    for (let i = 1; i < text.length; i++) {
      if (text[i] !== "'") value += text[i];
      else if (i + 1 < text.length && text[i + 1] === "'") {
        value += "'";
        i++;
      } else return restIsEnd(text.slice(i + 1)) ? value : undefined;
    }
    return undefined;
  }
  const hash = text.indexOf(" #");
  return (hash >= 0 ? text.slice(0, hash) : text).trim();
}

/** The document as a SKILL.md: the six standard fields (those that are set), then the instructions. Never any other key. */
export function writeSkillMarkdown(document: SkillDocument): string {
  let out = "---\n";
  out += `name: ${yamlScalar(document.name)}\n`;
  out += `description: ${yamlScalar(document.description)}\n`;
  if (document.license.length > 0) out += `license: ${yamlScalar(document.license)}\n`;
  if (document.compatibility.length > 0) out += `compatibility: ${yamlScalar(document.compatibility)}\n`;
  const metadata = Object.entries(document.metadata);
  if (metadata.length > 0) {
    out += "metadata:\n";
    for (const [key, value] of metadata.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out += `  ${yamlScalar(key)}: ${yamlScalar(value)}\n`;
  }
  if (document.allowedTools.length > 0) out += `allowed-tools: ${yamlScalar(document.allowedTools)}\n`;
  out += "---\n";
  const body = (document.instructions ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/^\n+|\n+$/g, "");
  if (body.length > 0) out += `\n${body}\n`;
  return out;
}

/** The `faden.yaml` for the fields; undefined when they say nothing (the file is left out). */
export function writeExtensionYaml(fields: SkillExtensionFields): string | undefined {
  if (extensionFieldsAreEmpty(fields)) return undefined;
  let out = "";
  if (fields.title.length > 0) out += `title: ${yamlScalar(fields.title)}\n`;
  out += list("tags", fields.tags, 0);
  if (fields.priority !== DEFAULT_SKILL_PRIORITY) out += `priority: ${String(fields.priority)}\n`;
  if (fields.activation !== "auto") out += `activation: ${yamlScalar(fields.activation)}\n`;
  if (fields.keywords.length > 0 || fields.fileTypes.length > 0) {
    out += "trigger_rules:\n";
    out += list("keywords", fields.keywords, 2);
    out += list("file_types", fields.fileTypes, 2);
  }
  out += list("preferred_tools", fields.preferredTools, 0);
  out += list("allowed_tools", fields.allowedTools, 0);
  out += list("forbidden_tools", fields.forbiddenTools, 0);
  out += list("knowledge_sources", fields.knowledgeSources, 0);
  return out;
}

function list(key: string, items: readonly string[], indent: number): string {
  if (items.length === 0) return "";
  const pad = " ".repeat(indent);
  let out = `${pad}${key}:\n`;
  for (const item of items) out += `${pad}  - ${yamlScalar(item)}\n`;
  return out;
}

/** A text as a YAML scalar: plain when that reads back as the same text, else double-quoted. */
export function yamlScalar(input: string | undefined | null): string {
  const text = input ?? "";
  if (text.length > 0 && text.length <= 2000 && PLAIN_SAFE.test(text) && text === text.trim() && !text.includes(" #") && !WORDS.has(text.toLowerCase())) return text;
  let out = '"';
  for (const c of text) {
    switch (c) {
      case '"': out += '\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default: {
        const code = c.charCodeAt(0);
        if (c.length === 1 && (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) || code === 0x2028 || code === 0x2029)) {
          out += "\\u" + code.toString(16).toUpperCase().padStart(4, "0");
        } else out += c;
      }
    }
  }
  return out + '"';
}
