import type { SkillOption } from "@fadenstack/client";

// What the skill editor and the skills module share (sdk/51 F04, the third slice). The layers keep `@fadenstack/ui` from importing a
// module and a module from importing `@fadenstack/ui` (the architecture test), so the contracts sit here, in the core, as .NET puts
// them in Fadenstack.Agents (Fadenstack.SkillAuthoring): `@fadenstack/ui` builds its view models on `SkillWorkshop`, and
// `@fadenstack/skills` implements it over the person's skills in IndexedDB. .NET: SkillAuthoring.cs.

/** The limits of a skill (core's `NAME_MAX` and `DESCRIPTION_MAX`, and the editor's own for sizes). */
export const SkillLimits = Object.freeze({
  /** The name: 1 to 64 characters. */
  nameMax: 64,
  descriptionMax: 1024,
  compatibilityMax: 500,
  /** The body's advisory size in tokens (a warning, not a refusal); a token is counted as 4 characters. */
  bodyAdvisoryTokens: 5000,
  charactersPerToken: 4,
  /** A file of a skill, in bytes. */
  fileMaxBytes: 1024 * 1024,
  /** All the files of a skill, in bytes (what a zip may expand to). */
  totalMaxBytes: 5 * 1024 * 1024,
  /** The files of a skill, SKILL.md and faden.yaml included. */
  filesMax: 100,
  /** A zip that expands to more than this many times its size is refused. */
  expansionRatioMax: 100,
  /** The longest path of a resource, and of one of its parts. */
  pathMax: 200,
  pathPartMax: 100,
  /** The longest zip taken in (the compressed file). */
  zipMaxBytes: 6 * 1024 * 1024,
} as const);

/** Where a skill comes from. */
export const SkillOrigin = Object.freeze({
  /** Inside the app, signed with it: read only. */
  Bundled: "bundled",
  /** The person's own, kept in their browser's database: not reviewed by anyone. */
  Own: "own",
  /** The organisation's, from the server (governed mode): read only, never its instructions. */
  Organisation: "organisation",
} as const);
export type SkillOrigin = (typeof SkillOrigin)[keyof typeof SkillOrigin];

/** One skill in the library. */
export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly origin: SkillOrigin;
  readonly enabled: boolean;
  /** The record breaks a rule: the module does not list it; the person can open it to fix or delete it. */
  readonly isBroken: boolean;
  /** Why it is broken, as a check's finding, when the library knows (undefined otherwise); the view model says it in words. */
  readonly brokenIssue: SkillIssue | undefined;
  /** Not the person's own: bundled and organisation skills are read only. */
  readonly isReadOnly: boolean;
  /** The on/off switch is the person's for bundled and own skills; the organisation decides its own. */
  readonly canSwitch: boolean;
  /** Own skills carry the label "not reviewed". */
  readonly notReviewed: boolean;
}

export function createSkillEntry(name: string, description: string, origin: SkillOrigin, enabled: boolean, isBroken = false, brokenIssue?: SkillIssue): SkillEntry {
  return {
    name,
    description,
    origin,
    enabled,
    isBroken,
    brokenIssue: isBroken ? brokenIssue : undefined,
    isReadOnly: origin !== SkillOrigin.Own,
    canSwitch: origin !== SkillOrigin.Organisation,
    notReviewed: origin === SkillOrigin.Own,
  };
}

/** A file of a skill (a resource): its path relative to the skill, with forward slashes, and its content. */
export interface SkillFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The content as UTF-8 text when it is text (no NUL byte, valid UTF-8); undefined for a binary file. */
export function skillFileText(file: SkillFile): string | undefined {
  if (file.bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
  } catch {
    return undefined;
  }
}

export function skillFileFromText(path: string, text: string): SkillFile {
  return { path, bytes: new TextEncoder().encode(text) };
}

export const DEFAULT_SKILL_PRIORITY = 50;

/** What a skill's `faden.yaml` says (Fadenstack's extras: filter, rank, pre-load, preferred tools). The defaults are what no file says. */
export interface SkillExtensionFields {
  title: string;
  tags: readonly string[];
  /** 0 to 100. */
  priority: number;
  /** `auto` (when the message matches), `always`, `manual` (only when named). */
  activation: string;
  keywords: readonly string[];
  fileTypes: readonly string[];
  /** A hint in the prompt, nothing else: it grants nothing. */
  preferredTools: readonly string[];
  /** Read and kept, never used (core's fields). */
  allowedTools: readonly string[];
  forbiddenTools: readonly string[];
  knowledgeSources: readonly string[];
  /** Keys of the file this editor does not know: a Save would drop them. */
  unknownKeys: readonly string[];
}

export function createExtensionFields(changes: Partial<SkillExtensionFields> = {}): SkillExtensionFields {
  return {
    title: "",
    tags: [],
    priority: DEFAULT_SKILL_PRIORITY,
    activation: "auto",
    keywords: [],
    fileTypes: [],
    preferredTools: [],
    allowedTools: [],
    forbiddenTools: [],
    knowledgeSources: [],
    unknownKeys: [],
    ...changes,
  };
}

/** Whether the fields say nothing (no `faden.yaml` is written). The unknown keys are not said, so they do not count. */
export function extensionFieldsAreEmpty(fields: SkillExtensionFields): boolean {
  return fields.title.length === 0 && fields.tags.length === 0 && fields.priority === DEFAULT_SKILL_PRIORITY && fields.activation === "auto"
    && fields.keywords.length === 0 && fields.fileTypes.length === 0 && fields.preferredTools.length === 0 && fields.allowedTools.length === 0
    && fields.forbiddenTools.length === 0 && fields.knowledgeSources.length === 0;
}

/** A skill as the editor works on it: the six standard fields, the instructions, the `faden.yaml` fields and the resource files. */
export interface SkillDocument {
  name: string;
  description: string;
  license: string;
  compatibility: string;
  metadata: Readonly<Record<string, string>>;
  /** The experimental `allowed-tools` field, as written (space-separated). */
  allowedTools: string;
  /** The SKILL.md's body: the instructions, Markdown. */
  instructions: string;
  extension: SkillExtensionFields;
  /** The files beside SKILL.md and faden.yaml. */
  resources: readonly SkillFile[];
  /** Frontmatter keys beyond the six: a document that has any cannot be saved (claude.ai rejects them, and a clean SKILL.md moves to any agent). */
  unknownKeys: readonly string[];
}

export function createSkillDocument(changes: Partial<SkillDocument> = {}): SkillDocument {
  return {
    name: "",
    description: "",
    license: "",
    compatibility: "",
    metadata: {},
    allowedTools: "",
    instructions: "",
    extension: createExtensionFields(),
    resources: [],
    unknownKeys: [],
    ...changes,
  };
}

export const SkillSeverity = Object.freeze({
  /** Saving is refused. */
  Error: "error",
  /** Said, not refused. */
  Warning: "warning",
} as const);
export type SkillSeverity = (typeof SkillSeverity)[keyof typeof SkillSeverity];

/** What a check found. */
export const SkillIssueCode = Object.freeze({
  NameMissing: "NameMissing",
  NameForm: "NameForm",
  NameTooLong: "NameTooLong",
  NameNotFolder: "NameNotFolder",
  NameReserved: "NameReserved",
  DescriptionMissing: "DescriptionMissing",
  DescriptionTooLong: "DescriptionTooLong",
  CompatibilityTooLong: "CompatibilityTooLong",
  UnknownKey: "UnknownKey",
  InvisibleCharacter: "InvisibleCharacter",
  ControlCharacter: "ControlCharacter",
  BodyEmpty: "BodyEmpty",
  BodyLarge: "BodyLarge",
  TotalTooLarge: "TotalTooLarge",
  FileTooLarge: "FileTooLarge",
  TooManyFiles: "TooManyFiles",
  ScriptFile: "ScriptFile",
  UnsafePath: "UnsafePath",
  DuplicatePath: "DuplicatePath",
  LinkEntry: "LinkEntry",
  ZipBomb: "ZipBomb",
  NotAZip: "NotAZip",
  SkillMdMissing: "SkillMdMissing",
  SkillMdUnreadable: "SkillMdUnreadable",
  FadenYamlUnreadable: "FadenYamlUnreadable",
  FadenYamlUnknownKey: "FadenYamlUnknownKey",
  ReadFailed: "ReadFailed",
  /** TypeScript only (a skill is text in a browser's database, with no file system): a resource that is not text. */
  BinaryFile: "BinaryFile",
} as const);
export type SkillIssueCode = (typeof SkillIssueCode)[keyof typeof SkillIssueCode];

/** One finding of a check: what, how bad, where (a field or a file), and the numbers or text that go with it. */
export interface SkillIssue {
  readonly code: SkillIssueCode;
  readonly severity: SkillSeverity;
  readonly subject?: string | undefined;
  readonly limit: number;
  readonly actual: number;
  readonly detail?: string | undefined;
  readonly isError: boolean;
}

export function skillIssue(
  code: SkillIssueCode,
  severity: SkillSeverity,
  subject?: string,
  extra: { limit?: number; actual?: number; detail?: string } = {},
): SkillIssue {
  return { code, severity, subject, limit: extra.limit ?? 0, actual: extra.actual ?? 0, detail: extra.detail, isError: severity === SkillSeverity.Error };
}

/** The result of the checks before saving (one validator, used by the editor, the import and the draft). */
export interface SkillCheck {
  readonly issues: readonly SkillIssue[];
  readonly hasErrors: boolean;
  readonly ok: boolean;
}

export function skillCheck(issues: readonly SkillIssue[]): SkillCheck {
  const hasErrors = issues.some((i) => i.isError);
  return { issues, hasErrors, ok: !hasErrors };
}

export const SkillSaveStatus = Object.freeze({
  Saved: "saved",
  /** A skill of that name exists and the person has not confirmed replacing it. */
  Exists: "exists",
  /** The checks found errors; nothing was written. */
  Refused: "refused",
  /** A bundled or organisation skill, or a name that is not the person's to write. */
  NotAllowed: "notAllowed",
  /** The skill could not be written; nothing was changed. */
  Failed: "failed",
} as const);
export type SkillSaveStatus = (typeof SkillSaveStatus)[keyof typeof SkillSaveStatus];

export interface SkillSaveResult {
  readonly status: SkillSaveStatus;
  readonly issues: readonly SkillIssue[];
  readonly name?: string | undefined;
  readonly saved: boolean;
}

export function skillSaveResult(status: SkillSaveStatus, issues: readonly SkillIssue[] = [], name?: string): SkillSaveResult {
  return { status, issues, name, saved: status === SkillSaveStatus.Saved };
}

/** A skill read from the library, or why it could not be. */
export interface SkillReadResult {
  readonly document: SkillDocument | undefined;
  readonly origin: SkillOrigin;
  readonly issues: readonly SkillIssue[];
}

/** What an import found; nothing is written until `SkillWorkshop.commitImport`, after the person confirms. */
export interface ImportAnalysis {
  readonly source: string;
  readonly document: SkillDocument | undefined;
  readonly issues: readonly SkillIssue[];
  readonly wouldReplace: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** The import can go ahead (it may still need the person's confirmation to replace). */
  readonly ok: boolean;
}

export function importAnalysis(
  source: string,
  document: SkillDocument | undefined,
  issues: readonly SkillIssue[],
  wouldReplace: boolean,
  fileCount: number,
  totalBytes: number,
): ImportAnalysis {
  return { source, document, issues, wouldReplace, fileCount, totalBytes, ok: document !== undefined && issues.every((i) => !i.isError) };
}

/** A zip the person chose to import: its name and bytes. */
export interface SkillZipFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** A `faden.yaml`, read. */
export interface SkillExtensionParse {
  readonly fields: SkillExtensionFields | undefined;
  readonly issues: readonly SkillIssue[];
}

/** One skill the test step found for a prompt, and why. */
export interface SkillTestMatch {
  readonly name: string;
  readonly matchedBy: string;
  readonly score: number;
}

/** What the pre-selection does for a prompt (the module's own resolver, over the edited skill and the person's others). */
export interface SkillTestResult {
  readonly listed: readonly string[];
  readonly matches: readonly SkillTestMatch[];
  readonly preloaded: readonly string[];
  /** What the model is told for the prompt (the module's instructions); undefined when no skill is listed. */
  readonly modelInstructions: string | undefined;
  readonly editedListed: boolean;
}

/** The name of `load_skill`, the one tool the optional model call is offered. */
export const LOAD_SKILL_TOOL = "load_skill";

/** The organisation's skills in governed mode (the agent's `listSkills`). */
export type OrganisationSkills = (signal?: AbortSignal) => Promise<readonly SkillOption[]>;

/**
 * The person's skills for the editor: list, read, check, save, delete, switch on and off, import, export and test. A module implements
 * it; nothing here saves on its own: `save` is only called when the person pressed Save. .NET: `ISkillWorkshop` (a folder or a zip
 * there; here a zip only, as a browser has no folders).
 */
export interface SkillWorkshop {
  /** The bundled, own and (governed mode) organisation skills. */
  list(signal?: AbortSignal): Promise<readonly SkillEntry[]>;
  read(name: string, signal?: AbortSignal): Promise<SkillReadResult>;
  /** The checks before saving. `folderName`: the name the skill is kept under, when it already is. */
  check(document: SkillDocument, folderName?: string): SkillCheck;
  /** Checks, then writes the skill as one record. `previousName`: the skill it was renamed from. */
  save(document: SkillDocument, previousName?: string, replaceExisting?: boolean, signal?: AbortSignal): Promise<SkillSaveResult>;
  /** Deletes an own skill; false when there is none or it is not the person's. */
  delete(name: string, signal?: AbortSignal): Promise<boolean>;
  /** Switches a bundled or own skill on or off in the person's settings; the module does not list an off skill. */
  setEnabled(name: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  /** Reads and checks a zip; writes nothing. */
  analyzeZip(zip: Uint8Array, source: string, signal?: AbortSignal): Promise<ImportAnalysis>;
  /** Writes what `analyzeZip` found, checking it again; an existing skill of the name is replaced only when `replaceExisting`. */
  commitImport(analysis: ImportAnalysis, replaceExisting: boolean, signal?: AbortSignal): Promise<SkillSaveResult>;
  /** One skill as a zip (`<name>/SKILL.md`, `faden.yaml` and the resources); undefined when there is none. */
  exportZip(name: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
  /** Reads the text of a `faden.yaml` into fields. */
  parseExtension(text: string): SkillExtensionParse;
  /** For a prompt: which skills the pre-selection lists and pre-loads, with `edited` in place of the saved skill it came from (`editedFrom`, when it was renamed). */
  test(prompt: string, edited?: SkillDocument, editedFrom?: string): Promise<SkillTestResult>;
}
