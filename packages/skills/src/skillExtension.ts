import { FadenYamlError, parseFadenYaml, type YamlValue } from "./fadenYaml.js";

export const DEFAULT_PRIORITY = 50;
export const TITLE_MAX = 255;
/** More than core has, for a file that is read on every turn: a keyword list a person writes is a few dozen words. */
export const MAX_KEYWORDS = 200;
export const MAX_KEYWORD_LENGTH = 100;

export type Activation = "always" | "auto" | "manual";

/** What .NET's `\w` is: letters, non-spacing marks, decimal digits and connector punctuation (underscore). */
export const WORD = "\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}";

/** The text as a regular expression's literal characters. */
export function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * What a skill's `faden.yaml` says (sdk/51 F04, D16), read by the rules of core's `skills/faden_skills/services/bundle.py`
 * (`split_extension`, `normalize_manifest`): `title`, `tags`, `priority` (a whole number from 0 to 100, default 50), `activation`
 * (`always`, `auto`, `manual`; default `auto`), `trigger_rules` with `keywords`, `file_types` and `intents`, and `preferred_tools`.
 * `allowed_tools`, `forbidden_tools` and `knowledge_sources` are checked as core checks them and then left alone: a skill's text
 * never changes a tool's class, a mode or a grant, so no field narrows or widens the tools. A field of the wrong type refuses the
 * whole file (as core refuses the bundle). .NET: `SkillExtension`.
 */
export class SkillExtension {
  static readonly empty = new SkillExtension();

  title: string | undefined;
  tags: readonly string[] = [];
  priority = DEFAULT_PRIORITY;
  activation: Activation = "auto";
  keywords: readonly string[] = [];
  fileTypes: readonly string[] = [];
  preferredTools: readonly string[] = [];
  /** One matcher per keyword (built once, with the file): the keyword as a whole word or phrase, any case. A keyword is escaped text. */
  keywordMatchers: readonly RegExp[] = [];

  private constructor() {}

  /** Reads the text of a `faden.yaml`; throws `FadenYamlError` when it is not accepted. */
  static parse(text: string): SkillExtension {
    const data = parseFadenYaml(text);
    if (data === null) return SkillExtension.empty;
    if (!(data instanceof Map)) throw new FadenYamlError("faden.yaml must be a mapping of fields.");
    const extension = new SkillExtension();
    for (const key of ["allowed_tools", "forbidden_tools", "knowledge_sources"]) {
      const value = valueOf(data, key);
      if (value !== null && truthy(value)) stringList(value, key); // checked, never used
    }
    const preferred = valueOf(data, "preferred_tools");
    if (preferred !== null && truthy(preferred)) extension.preferredTools = stringList(preferred, "preferred_tools");
    const rules = valueOf(data, "trigger_rules");
    if (rules !== null && truthy(rules)) {
      if (!(rules instanceof Map)) throw new FadenYamlError("trigger_rules is a mapping (keywords, file_types).");
      for (const key of ["keywords", "file_types", "intents"]) {
        const value = valueOf(rules, key);
        if (value !== null && truthy(value)) {
          const list = stringList(value, "trigger_rules." + key);
          if (key === "keywords") extension.keywords = list;
          else if (key === "file_types") extension.fileTypes = list;
        }
      }
    }
    const title = valueOf(data, "title");
    if (title !== null) {
      const trimmed = textOf(title).trim();
      extension.title = trimmed.length > TITLE_MAX ? trimmed.slice(0, TITLE_MAX) : trimmed;
    }
    const tags = valueOf(data, "tags");
    if (tags !== null) extension.tags = stringList(tags, "tags");
    const priority = valueOf(data, "priority");
    if (priority !== null) {
      if (typeof priority !== "bigint" || priority < 0n || priority > 100n) throw new FadenYamlError("priority is a whole number from 0 to 100.");
      extension.priority = Number(priority);
    }
    const activation = valueOf(data, "activation");
    if (activation !== null) {
      const name = textOf(activation).trim();
      if (name !== "always" && name !== "auto" && name !== "manual") throw new FadenYamlError("activation is one of always, auto, manual.");
      extension.activation = name;
    }
    if (extension.keywords.length > MAX_KEYWORDS || extension.keywords.some((k) => k.length > MAX_KEYWORD_LENGTH)) {
      throw new FadenYamlError(`keywords are at most ${MAX_KEYWORDS} words of ${MAX_KEYWORD_LENGTH} characters.`);
    }
    extension.keywordMatchers = extension.keywords.map((k) => new RegExp(`(?<![${WORD}])${escapeRegex(k)}(?![${WORD}])`, "iu"));
    return extension;
  }
}

function valueOf(map: Map<string, YamlValue>, key: string): YamlValue {
  return map.get(key) ?? null;
}

/** Python's truth: what `if manifest.get(key)` skips. */
function truthy(value: YamlValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  return true;
}

function textOf(value: YamlValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "bigint") return value.toString();
  return ""; // a list or a map is no title and no activation
}

/** core's `_string_list`: a list of strings, or one string split at commas and white space; each stripped, empties dropped. */
function stringList(value: YamlValue, what: string): string[] {
  if (typeof value === "string") return value.split(/[,\s]+/).filter((p) => p.length > 0);
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new FadenYamlError(`${what} is a list of strings.`);
  return (value as string[]).map((v) => v.trim()).filter((v) => v.length > 0);
}
