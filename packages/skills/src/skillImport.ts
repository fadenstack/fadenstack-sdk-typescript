import {
  SkillIssueCode,
  SkillLimits,
  SkillSeverity,
  createExtensionFields,
  importAnalysis,
  parseSkillMarkdown,
  skillIssue,
  writeExtensionYaml,
  writeSkillMarkdown,
  type ImportAnalysis,
  type SkillDocument,
  type SkillExtensionParse,
  type SkillFile,
  type SkillIssue,
} from "@fadenstack/agents";

import { checkSkillDocument, pathProblem, validName } from "./skillValidator.js";
import { inflateEntry, readZip, writeZip, type ZipEntry } from "./zip.js";

// Import of a zip, and export of a skill as a zip (sdk/51 F04). What comes in is untrusted: a zip is checked entry by entry before
// any byte is expanded (path traversal and zip-slip, absolute and drive paths, backslashes, links, the number of files, each file's
// size and the total, the expansion ratio), and read through a counter that stops at the limit whatever the zip claims. Nothing is
// written here: the result is a document in memory, checked by the validator, which the person confirms before the store writes it.
// There are no folders in a browser: a zip is the only way in. .NET: SkillImport.cs.

const BOMB_FLOOR = 64 * 1024;
const JUNK = [".git", "__macosx", ".ds_store", "thumbs.db", "desktop.ini"];

export interface ImportServices {
  /** Reads the text of a faden.yaml (the workshop's `parseExtension`). */
  extension(text: string): SkillExtensionParse;
  /** Whether a skill of the person's has this name. */
  exists(name: string): Promise<boolean>;
  /** The bundled names an own skill may not take. */
  reserved: ReadonlySet<string>;
}

function refuse(source: string, code: SkillIssueCode, subject?: string, extra: { limit?: number; actual?: number; detail?: string } = {}): ImportAnalysis {
  return importAnalysis(source, undefined, [skillIssue(code, SkillSeverity.Error, subject, extra)], false, 0, 0);
}

const shorten = (text: string): string => (text.length > 60 ? text.slice(0, 60) : text);

const isJunk = (path: string): boolean => path.split("/").some((part) => JUNK.includes(part.toLowerCase()));

/** Checks a zip and reads the skill in it. Writes nothing. */
export async function analyzeZip(zip: Uint8Array, source: string, services: ImportServices): Promise<ImportAnalysis> {
  if (!(zip instanceof Uint8Array)) return refuse(source, SkillIssueCode.NotAZip, source);
  if (zip.length > SkillLimits.zipMaxBytes) return refuse(source, SkillIssueCode.FileTooLarge, source, { limit: SkillLimits.zipMaxBytes, actual: Math.min(zip.length, 2147483647) });
  const read = readZip(zip, SkillLimits.filesMax * 2);
  if (!read.ok) {
    return read.problem === "tooManyEntries"
      ? refuse(source, SkillIssueCode.TooManyFiles, undefined, { limit: SkillLimits.filesMax, actual: SkillLimits.filesMax * 2 + 1 })
      : refuse(source, SkillIssueCode.NotAZip, source);
  }
  const issues: SkillIssue[] = [];
  // The entries first: names and the sizes the zip says, before a byte is expanded.
  let declared = 0;
  const files: { entry: ZipEntry; path: string }[] = [];
  const names = new Set<string>();
  for (const entry of read.entries) {
    const name = entry.name;
    if (name === undefined) {
      issues.push(skillIssue(SkillIssueCode.UnsafePath, SkillSeverity.Error, "", { detail: "a name that is not text" }));
      continue;
    }
    const trimmed = entry.isDirectory ? name.replace(/\/+$/, "") : name;
    if (trimmed.length === 0) continue;
    if (isJunk(trimmed)) continue;
    const problem = pathProblem(trimmed);
    if (problem !== undefined && problem !== "reserved") {
      issues.push(skillIssue(SkillIssueCode.UnsafePath, SkillSeverity.Error, shorten(name), { detail: problem }));
      continue;
    }
    if (entry.isLink) {
      issues.push(skillIssue(SkillIssueCode.LinkEntry, SkillSeverity.Error, shorten(name)));
      continue;
    }
    if (entry.isDirectory) continue;
    if (names.has(trimmed.toLowerCase())) {
      issues.push(skillIssue(SkillIssueCode.DuplicatePath, SkillSeverity.Error, shorten(name)));
      continue;
    }
    names.add(trimmed.toLowerCase());
    files.push({ entry, path: name });
    declared += entry.size;
    if (entry.size > SkillLimits.fileMaxBytes) {
      issues.push(skillIssue(SkillIssueCode.FileTooLarge, SkillSeverity.Error, shorten(name), { limit: SkillLimits.fileMaxBytes, actual: Math.min(entry.size, 2147483647) }));
    } else if (entry.size > BOMB_FLOOR && entry.compressedSize * SkillLimits.expansionRatioMax < entry.size) {
      issues.push(skillIssue(SkillIssueCode.ZipBomb, SkillSeverity.Error, shorten(name), { limit: SkillLimits.expansionRatioMax }));
    }
  }
  if (files.length > SkillLimits.filesMax) issues.push(skillIssue(SkillIssueCode.TooManyFiles, SkillSeverity.Error, undefined, { limit: SkillLimits.filesMax, actual: files.length }));
  if (declared > SkillLimits.totalMaxBytes) {
    issues.push(skillIssue(declared > zip.length * SkillLimits.expansionRatioMax ? SkillIssueCode.ZipBomb : SkillIssueCode.TotalTooLarge, SkillSeverity.Error, undefined,
      { limit: SkillLimits.totalMaxBytes, actual: Math.min(declared, 2147483647) }));
  } else if (declared > BOMB_FLOOR && declared > zip.length * SkillLimits.expansionRatioMax) {
    issues.push(skillIssue(SkillIssueCode.ZipBomb, SkillSeverity.Error, undefined, { limit: SkillLimits.expansionRatioMax }));
  }
  if (issues.length > 0) return importAnalysis(source, undefined, issues, false, files.length, declared); // nothing was expanded

  // Then the content, through a counter that stops at the limit whatever the zip claims.
  const bag: { path: string; bytes: Uint8Array }[] = [];
  const budget = { used: 0, max: SkillLimits.totalMaxBytes };
  for (const { entry, path } of files) {
    const read = await inflateEntry(zip, entry, Math.min(entry.size, SkillLimits.fileMaxBytes), budget);
    if (!read.ok) {
      return read.problem === "tooLarge"
        ? refuse(source, SkillIssueCode.ZipBomb, shorten(path), { limit: SkillLimits.expansionRatioMax })
        : refuse(source, SkillIssueCode.NotAZip, shorten(path));
    }
    bag.push({ path, bytes: read.bytes });
  }
  return assemble(bag, source, services);
}

/**
 * The files as a skill: SKILL.md at the root (or under the one folder every entry shares), its faden.yaml, the rest as resources. The
 * whole is checked as a save would check it; a zip's top folder that is not the skill's name is said, not refused (the skill is kept
 * under its name).
 */
async function assemble(input: { path: string; bytes: Uint8Array }[], source: string, services: ImportServices): Promise<ImportAnalysis> {
  let bag = input;
  let top: string | undefined;
  if (!bag.some((f) => f.path === "SKILL.md")) {
    const firsts = [...new Set(bag.map((f) => f.path.split("/")[0]!))];
    if (firsts.length === 1 && bag.every((f) => f.path.includes("/"))) {
      top = firsts[0]!;
      const prefix = top.length + 1;
      bag = bag.map((f) => ({ path: f.path.slice(prefix), bytes: f.bytes }));
    }
  }
  const total = bag.reduce((sum, f) => sum + f.bytes.length, 0);
  const head = bag.find((f) => f.path === "SKILL.md");
  if (!head) return importAnalysis(source, undefined, [skillIssue(SkillIssueCode.SkillMdMissing, SkillSeverity.Error, source)], false, bag.length, total);
  const issues: SkillIssue[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const parsed = parseSkillMarkdown(decoder.decode(head.bytes));
  if (!parsed.ok) {
    issues.push(skillIssue(SkillIssueCode.SkillMdUnreadable, SkillSeverity.Error, "SKILL.md", { detail: parsed.error }));
    return importAnalysis(source, undefined, issues, false, bag.length, total);
  }
  let fields = createExtensionFields();
  const yamlFile = bag.find((f) => f.path === "faden.yaml");
  if (yamlFile) {
    const read = services.extension(decoder.decode(yamlFile.bytes));
    issues.push(...read.issues);
    if (read.fields) fields = read.fields;
  }
  const resources: SkillFile[] = bag.filter((f) => f.path !== "SKILL.md" && f.path !== "faden.yaml").map((f) => ({ path: f.path, bytes: f.bytes }));
  const document: SkillDocument = { ...parsed.document, extension: fields, resources };
  issues.push(...checkSkillDocument(document, undefined, services.reserved).issues);
  if (top !== undefined && document.name.length > 0 && top !== document.name) {
    issues.push(skillIssue(SkillIssueCode.NameNotFolder, SkillSeverity.Warning, "name", { detail: top }));
  }
  const replace = document.name.length > 0 && validName(document.name) && (await services.exists(document.name));
  return importAnalysis(source, document, dedupe(issues), replace, bag.length, total);
}

function dedupe(issues: SkillIssue[]): SkillIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = JSON.stringify([i.code, i.severity, i.subject, i.limit, i.actual, i.detail]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The skill as a zip: `<name>/SKILL.md`, `faden.yaml` and the resources. */
export async function skillToZip(document: SkillDocument): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const files: { path: string; bytes: Uint8Array }[] = [{ path: `${document.name}/SKILL.md`, bytes: encoder.encode(writeSkillMarkdown(document)) }];
  const yaml = writeExtensionYaml(document.extension);
  if (yaml !== undefined) files.push({ path: `${document.name}/faden.yaml`, bytes: encoder.encode(yaml) });
  for (const file of document.resources) files.push({ path: `${document.name}/${file.path}`, bytes: file.bytes });
  return writeZip(files);
}
