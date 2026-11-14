import type { SkillDefinition } from "./skillRules.js";

/** A skill that passed the six-field rule, ready to be loaded. */
export interface LoadedSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  /** The files `read_skill_resource` may read, by the name the skill lists. */
  readonly resources: ReadonlyMap<string, string>;
  readonly fadenYaml: string | undefined;
}

export function loadedFrom(definition: SkillDefinition): LoadedSkill {
  return {
    name: definition.name,
    description: definition.description,
    body: definition.body,
    resources: new Map(Object.entries(definition.resources ?? {})),
    fadenYaml: definition.fadenYaml,
  };
}

/** XML text as Microsoft Agent Framework writes it into a skill's content (and `SecurityElement.Escape` writes the list). */
export function xmlEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/**
 * The two tools' behaviour, the loader this SDK has where .NET runs Microsoft Agent Framework's `AgentSkillsProvider`: the
 * answers are MAF's (a skill's content with its name, description, instructions and the resources it lists; `Error: ...` text for
 * an empty or unknown name), and a resource is only what the skill lists, by the name it lists, so a path that leaves the skill
 * (`../../secret.md`, an absolute path, a backslash) is a name nothing has. There is no script: nothing is read from a disk.
 */
export class SkillSet {
  readonly #skills = new Map<string, LoadedSkill>();

  constructor(skills: readonly LoadedSkill[]) {
    for (const skill of skills) this.#skills.set(skill.name, skill);
  }

  get skills(): readonly LoadedSkill[] {
    return [...this.#skills.values()];
  }

  /** `load_skill`: the skill's content, or `Error: ...`. */
  load(name: unknown): string {
    if (typeof name !== "string" || name.trim().length === 0) return "Error: Skill name cannot be empty.";
    const skill = this.#skills.get(name);
    return skill ? contentOf(skill) : `Error: Skill '${name}' not found.`;
  }

  /** `read_skill_resource`: the resource's text, or `Error: ...`. */
  readResource(skillName: unknown, resourceName: unknown): string {
    if (typeof skillName !== "string" || skillName.trim().length === 0) return "Error: Skill name cannot be empty.";
    if (typeof resourceName !== "string" || resourceName.trim().length === 0) return "Error: Resource name cannot be empty.";
    const skill = this.#skills.get(skillName);
    if (!skill) return `Error: Skill '${skillName}' not found.`;
    const text = skill.resources.get(resourceName);
    return text !== undefined ? text : `Error: Resource '${resourceName}' not found in skill '${skillName}'.`;
  }
}

/** What `load_skill` answers for a skill (the shape of MAF's content of a skill made in code). */
function contentOf(skill: LoadedSkill): string {
  let content = `<name>${xmlEscape(skill.name)}</name>\n<description>${xmlEscape(skill.description)}</description>\n\n<instructions>\n${skill.body}\n</instructions>`;
  if (skill.resources.size === 0) return `${content}\n<available_resources />`;
  content += "\n<available_resources>\n";
  for (const name of skill.resources.keys()) content += `  <resource name="${xmlEscape(name)}"/>\n`;
  return `${content}</available_resources>`;
}
