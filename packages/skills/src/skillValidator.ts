import {
  SkillIssueCode,
  SkillLimits,
  SkillSeverity,
  createExtensionFields,
  skillCheck,
  skillFileText,
  skillIssue,
  writeExtensionYaml,
  writeSkillMarkdown,
  type SkillCheck,
  type SkillDocument,
  type SkillIssue,
} from "@fadenstack/agents";

import { SkillExtension } from "./skillExtension.js";

// The checks before a skill is saved (sdk/51 F04): one validator, used by the editor, the import and the draft. A skill's text is
// untrusted input (a zip, a model's draft, a person's paste), so every rule here is about what may come in: the six standard
// fields only, the name as the key it is kept under, the lengths, invisible and control characters, the sizes and the number of
// files, safe resource paths, no script kept as runnable (scripts never run here), and a `faden.yaml` that the module's own reader
// accepts. .NET: SkillValidator.cs.

const NAME_FORM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Files that are, or look like, programs or scripts: refused, since no script ever runs here and a kept one invites running it by hand. */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ps1", ".psm1", ".bat", ".cmd", ".sh", ".bash", ".zsh", ".fish", ".vbs", ".vbe", ".wsf", ".wsh", ".js", ".mjs", ".cjs", ".jse", ".py", ".pyw",
  ".rb", ".pl", ".php", ".lua", ".exe", ".dll", ".com", ".msi", ".scr", ".so", ".dylib", ".jar", ".app", ".lnk", ".reg", ".hta", ".cpl",
]);
const SCRIPT_FOLDERS: readonly string[] = ["scripts"];

/** Characters the eye does not see: zero width, direction controls, soft hyphen, invisible operators, line and paragraph separators. */
function isInvisible(c: number): boolean {
  return c === 0x200b || c === 0x200c || c === 0x200d || c === 0x2060 || c === 0xfeff || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
    || c === 0x200e || c === 0x200f || c === 0x061c || c === 0x00ad || c === 0x180e || (c >= 0x2061 && c <= 0x2064) || c === 0x2028 || c === 0x2029
    || c === 0x034f || (c >= 0xfff9 && c <= 0xfffb) || (c >= 0xe0000 && c <= 0xe007f);
}

function isControl(c: number): boolean {
  return (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || (c >= 0x80 && c <= 0x9f);
}

/** Notes the invisible and control characters of `text` (each distinct one once, at most five). */
export function scanCharacters(text: string | undefined, subject: string, issues: SkillIssue[], allowLeadingBom = false): void {
  if (!text) return;
  const seen = new Set<number>();
  let first = true;
  for (let i = 0; i < text.length && seen.size < 5;) {
    const c = text.codePointAt(i)!;
    const atStart = first;
    i += c > 0xffff ? 2 : 1;
    first = false;
    if (atStart && c === 0xfeff && allowLeadingBom) continue;
    if (!seen.has(c) && (isInvisible(c) || isControl(c))) {
      seen.add(c);
      issues.push(skillIssue(isInvisible(c) ? SkillIssueCode.InvisibleCharacter : SkillIssueCode.ControlCharacter, SkillSeverity.Error, subject,
        { detail: "U+" + c.toString(16).toUpperCase().padStart(4, "0") }));
    }
  }
}

/** Why a resource path is not safe (undefined when it is): relative, forward slashes, no `..`, no drive, no empty or hidden-by-dots part, not a name SKILL.md or faden.yaml keeps. */
export function pathProblem(path: string | undefined): string | undefined {
  if (!path) return "empty";
  if (path.length > SkillLimits.pathMax) return "too long";
  if (path.includes("\\") || path[0] === "/" || path.includes(":") || path.includes("\0")) return "absolute or not a forward-slash relative path";
  const parts = path.split("/");
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === ".." || part.length > SkillLimits.pathPartMax || /[ .]$/.test(part)) return "has an empty, dot or too long part";
    for (const ch of part) {
      const c = ch.codePointAt(0)!;
      if (isInvisible(c) || isControl(c) || "*?\"<>|".includes(ch)) return "has a character a file name may not have";
    }
  }
  if (parts.length === 1 && (path.toLowerCase() === "skill.md" || path.toLowerCase() === "faden.yaml")) return "reserved";
  return undefined;
}

export function isScript(path: string): boolean {
  const parts = path.split("/");
  const last = parts[parts.length - 1]!;
  const dot = last.lastIndexOf(".");
  const extension = dot >= 0 && dot < last.length - 1 ? last.slice(dot).toLowerCase() : "";
  return SCRIPT_EXTENSIONS.has(extension) || (parts.length > 1 && SCRIPT_FOLDERS.includes(parts[0]!.toLowerCase()));
}

export function validName(name: string | undefined): boolean {
  return !!name && name.length <= SkillLimits.nameMax && NAME_FORM.test(name);
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The checks; `folderName` is the name the skill is kept under (undefined for a new one), `reserved` the bundled names a skill of the
 * person's may not take.
 */
export function checkSkillDocument(document: SkillDocument, folderName?: string, reserved?: ReadonlySet<string>): SkillCheck {
  const issues: SkillIssue[] = [];
  const name = document.name ?? "";
  if (name.length === 0) {
    issues.push(skillIssue(SkillIssueCode.NameMissing, SkillSeverity.Error, "name"));
  } else {
    if (name.length > SkillLimits.nameMax) issues.push(skillIssue(SkillIssueCode.NameTooLong, SkillSeverity.Error, "name", { limit: SkillLimits.nameMax, actual: name.length }));
    if (!NAME_FORM.test(name)) issues.push(skillIssue(SkillIssueCode.NameForm, SkillSeverity.Error, "name"));
    else if (folderName !== undefined && name !== folderName) issues.push(skillIssue(SkillIssueCode.NameNotFolder, SkillSeverity.Error, "name", { detail: folderName }));
    if (reserved?.has(name)) issues.push(skillIssue(SkillIssueCode.NameReserved, SkillSeverity.Error, "name"));
  }
  const description = document.description ?? "";
  if (description.trim().length === 0) issues.push(skillIssue(SkillIssueCode.DescriptionMissing, SkillSeverity.Error, "description"));
  else if (description.length > SkillLimits.descriptionMax) {
    issues.push(skillIssue(SkillIssueCode.DescriptionTooLong, SkillSeverity.Error, "description", { limit: SkillLimits.descriptionMax, actual: description.length }));
  }
  if ((document.compatibility ?? "").length > SkillLimits.compatibilityMax) {
    issues.push(skillIssue(SkillIssueCode.CompatibilityTooLong, SkillSeverity.Error, "compatibility", { limit: SkillLimits.compatibilityMax, actual: document.compatibility.length }));
  }
  for (const key of document.unknownKeys ?? []) issues.push(skillIssue(SkillIssueCode.UnknownKey, SkillSeverity.Error, "SKILL.md", { detail: key }));

  scanCharacters(name, "name", issues);
  scanCharacters(description, "description", issues);
  scanCharacters(document.license, "license", issues);
  scanCharacters(document.compatibility, "compatibility", issues);
  scanCharacters(document.allowedTools, "allowed-tools", issues);
  for (const [key, value] of Object.entries(document.metadata ?? {})) {
    scanCharacters(key, "metadata", issues);
    scanCharacters(value, "metadata", issues);
  }
  scanCharacters(document.instructions, "instructions", issues);

  const body = (document.instructions ?? "").trim();
  if (body.length === 0) issues.push(skillIssue(SkillIssueCode.BodyEmpty, SkillSeverity.Warning, "instructions"));
  else if (Math.trunc(body.length / SkillLimits.charactersPerToken) > SkillLimits.bodyAdvisoryTokens) {
    issues.push(skillIssue(SkillIssueCode.BodyLarge, SkillSeverity.Warning, "instructions",
      { limit: SkillLimits.bodyAdvisoryTokens, actual: Math.trunc(body.length / SkillLimits.charactersPerToken) }));
  }

  checkExtension(document.extension ?? createExtensionFields(), issues);
  checkFiles(document, issues);
  return skillCheck(issues);
}

function checkExtension(fields: SkillDocument["extension"], issues: SkillIssue[]): void {
  for (const key of fields.unknownKeys) issues.push(skillIssue(SkillIssueCode.FadenYamlUnknownKey, SkillSeverity.Warning, "faden.yaml", { detail: key }));
  const yaml = writeExtensionYaml(fields);
  if (yaml === undefined) return;
  scanCharacters(yaml, "faden.yaml", issues);
  if (issues.some((i) => i.subject === "faden.yaml" && i.isError)) return;
  try {
    SkillExtension.parse(yaml);
  } catch (error) {
    issues.push(skillIssue(SkillIssueCode.FadenYamlUnreadable, SkillSeverity.Error, "faden.yaml", { detail: error instanceof Error ? error.message : "it cannot be read" }));
  }
}

function checkFiles(document: SkillDocument, issues: SkillIssue[]): void {
  const yaml = writeExtensionYaml(document.extension ?? createExtensionFields());
  let total = utf8Length(writeSkillMarkdown(document)) + (yaml === undefined ? 0 : utf8Length(yaml));
  let count = 1 + (yaml === undefined ? 0 : 1);
  const paths = new Set<string>();
  for (const file of document.resources ?? []) {
    count++;
    total += file.bytes.length;
    const problem = pathProblem(file.path);
    if (problem !== undefined) {
      issues.push(skillIssue(SkillIssueCode.UnsafePath, SkillSeverity.Error, shorten(file.path), { detail: problem }));
      continue;
    }
    if (paths.has(file.path.toLowerCase())) issues.push(skillIssue(SkillIssueCode.DuplicatePath, SkillSeverity.Error, file.path));
    paths.add(file.path.toLowerCase());
    if (file.bytes.length > SkillLimits.fileMaxBytes) {
      issues.push(skillIssue(SkillIssueCode.FileTooLarge, SkillSeverity.Error, file.path, { limit: SkillLimits.fileMaxBytes, actual: file.bytes.length }));
    } else {
      const text = skillFileText(file);
      if (text !== undefined) scanCharacters(text, file.path, issues, true);
      else issues.push(skillIssue(SkillIssueCode.BinaryFile, SkillSeverity.Error, file.path));
    }
    if (isScript(file.path)) issues.push(skillIssue(SkillIssueCode.ScriptFile, SkillSeverity.Error, file.path));
  }
  if (count > SkillLimits.filesMax) issues.push(skillIssue(SkillIssueCode.TooManyFiles, SkillSeverity.Error, undefined, { limit: SkillLimits.filesMax, actual: count }));
  if (total > SkillLimits.totalMaxBytes) {
    issues.push(skillIssue(SkillIssueCode.TotalTooLarge, SkillSeverity.Error, undefined, { limit: SkillLimits.totalMaxBytes, actual: Math.min(total, 2147483647) }));
  }
}

function shorten(path: string | undefined): string {
  return path === undefined ? "" : path.length > 60 ? path.slice(0, 60) : path;
}
