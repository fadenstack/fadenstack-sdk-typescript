/**
 * A skill as the module reads it: the standard fields of a SKILL.md frontmatter, the body (the text after the frontmatter) and
 * the resource files by their listed name. Bundled skills (`SkillsOptions.bundled`) and the person's own (`SkillStore`) have this
 * shape; nothing else is a field of a skill (see `checkSkill`).
 */
export interface SkillDefinition {
  /** 1 to 64 characters: lowercase letters, digits and single hyphens. For a stored skill it is the key it is stored under. */
  name: string;
  /** Up to 1,024 characters. */
  description: string;
  /** What `load_skill` returns: the skill's instructions (its SKILL.md without the frontmatter). */
  body: string;
  /** Resource files by relative name (`references/style.md`) and their text: what `read_skill_resource` returns. */
  resources?: Readonly<Record<string, string>>;
  /**
   * The text of the skill's `faden.yaml` (keywords, preferred tools, priority, activation), or none: the skill is then listed as
   * before and never pre-loaded. Text that cannot be read is ignored (and logged); the skill still works.
   */
  fadenYaml?: string;
  /** The standard field `license`. */
  license?: string;
  /** The standard field `compatibility`, up to 500 characters. */
  compatibility?: string;
  /** The standard field `metadata`: a string-to-string map. */
  metadata?: Readonly<Record<string, string>>;
  /** The standard field `allowed-tools` (experimental in the standard); a skill's text never changes a tool's class, mode or grant, so nothing reads it. */
  allowedTools?: string;
}

/** A skill that breaks the six-field rule is refused where it is saved (`SkillStore.add`); read, it is skipped and logged. */
export class SkillRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRuleError";
  }
}

export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;

/** The six standard frontmatter fields (sdk/51 F04, H6), as a SKILL.md spells them. */
export const STANDARD_FIELDS: readonly string[] = Object.freeze(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

/** What a skill record holds: the six standard fields (`allowed-tools` as `allowedTools`), the body, the resources and the `faden.yaml`. */
const RECORD_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowedTools", "body", "resources", "fadenYaml"]);

const NAME_FORM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The six-field rule (sdk/51 F04, H6): SKILL.md keeps the standard fields `name`, `description`, `license`, `compatibility`,
 * `metadata` and `allowed-tools`; the name is the skill's own (the folder's, here the key the skill is stored under) and
 * `[a-z0-9]+(-[a-z0-9]+)*` up to 64 characters; the description is up to 1,024; the compatibility up to 500. A skill that breaks
 * it is skipped (and logged), never repaired.
 *
 * Returns why `raw` is no skill, or undefined when it is one. `expectedName` is the name it is kept under; .NET: Microsoft Agent
 * Framework checks the name, the description and the compatibility itself, and `SkillRules.ExtraKey` the keys.
 */
export function checkSkill(raw: unknown, expectedName?: string): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "it is not a skill record";
  const skill = raw as Record<string, unknown>;
  for (const key of Object.keys(skill)) {
    if (!RECORD_FIELDS.has(key)) return `it has a field the standard does not have (${cut(key, 40)})`;
  }
  const name = skill["name"];
  if (typeof name !== "string" || !NAME_FORM.test(name) || name.length > NAME_MAX) {
    return "its name is not lowercase letters, digits and single hyphens, up to 64 characters";
  }
  if (expectedName !== undefined && name !== expectedName) return "its name is not the name it is kept under";
  const description = skill["description"];
  if (typeof description !== "string" || description.trim().length === 0) return "it has no description";
  if (description.length > DESCRIPTION_MAX) return "its description is over 1,024 characters";
  if (typeof skill["body"] !== "string") return "it has no instructions";
  const compatibility = skill["compatibility"];
  if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length > COMPATIBILITY_MAX)) {
    return "its compatibility is not text of up to 500 characters";
  }
  for (const key of ["license", "allowedTools", "fadenYaml"]) {
    if (skill[key] !== undefined && typeof skill[key] !== "string") return `its ${key === "allowedTools" ? "allowed-tools" : key} is not text`;
  }
  const metadata = skill["metadata"];
  if (metadata !== undefined && !isStringMap(metadata)) return "its metadata is not a map of text to text";
  const resources = skill["resources"];
  if (resources !== undefined) {
    if (!isStringMap(resources)) return "its resources are not a map of file names to text";
    for (const resource of Object.keys(resources)) {
      if (!resourceNameOk(resource)) return "a resource has a name that leaves the skill";
    }
  }
  return undefined;
}

/** Whether `name` is a relative name inside the skill: no empty part, no `.` or `..`, no backslash, no drive and no leading slash. */
function resourceNameOk(name: string): boolean {
  if (name.length === 0 || name.length > 255 || name.includes("\\") || name.includes(":") || name.includes("\0")) return false;
  return name.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function cut(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The first top-level key of a SKILL.md's frontmatter that is not one of the six; undefined when there is none or the text has
 * no frontmatter. For the editor and the import, which hold SKILL.md text: a key beyond the six is refused where it is saved.
 * .NET: `SkillRules.ExtraKey`.
 */
export function extraFrontmatterKey(skillMd: string): string | undefined {
  const lines = skillMd.split(/\r\n|\r|\n/);
  const start = lines.findIndex((l) => l.trim().length > 0);
  if (start < 0 || lines[start]!.trim() !== "---") return undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimEnd() === "---") return undefined;
    // A key at the left edge (a nested one is indented, a list item starts with '-', a comment with '#').
    if (line.length === 0 || /\s/.test(line[0]!) || line[0] === "-" || line[0] === "#") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().replace(/^["']+|["']+$/g, "");
    if (!STANDARD_FIELDS.includes(key)) return cut(key, 40);
  }
  return undefined;
}
