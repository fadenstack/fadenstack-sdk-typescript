import {
  SkillIssueCode,
  SkillOrigin,
  SkillSaveStatus,
  SkillSeverity,
  createExtensionFields,
  createSkillDocument,
  createSkillEntry,
  skillFileFromText,
  skillFileText,
  skillIssue,
  skillSaveResult,
  writeExtensionYaml,
  type ImportAnalysis,
  type OrganisationSkills,
  type SkillCheck,
  type SkillDocument,
  type SkillEntry,
  type SkillExtensionParse,
  type SkillIssue,
  type SkillReadResult,
  type SkillSaveResult,
  type SkillTestResult,
  type SkillWorkshop,
} from "@fadenstack/agents";

import { FadenYamlError, parseFadenYaml } from "./fadenYaml.js";
import { render, type BundledSkill } from "./module.js";
import { SkillExtension } from "./skillExtension.js";
import { analyzeZip, skillToZip } from "./skillImport.js";
import { SkillCandidate, select } from "./skillResolver.js";
import { checkSkill, type SkillDefinition } from "./skillRules.js";
import { MemorySkillSwitches, type SkillSwitches } from "./skillSwitches.js";
import { checkSkillDocument, validName } from "./skillValidator.js";
import type { SkillStore } from "./store.js";

/** What the workshop works over. `SkillsModule.workshop()` fills it from the module's own options, so the two agree. */
export interface SkillWorkshopOptions {
  /** The bundled skills: read only, and their names are not the person's to take. */
  bundled?: readonly BundledSkill[];
  /** The person's skills; without one the workshop lists only the bundled ones and refuses to save. */
  store: SkillStore | undefined;
  /** The on/off switches; in memory by default. */
  switches?: SkillSwitches | undefined;
  /** The organisation's skills in governed mode (the agent's `listSkills`); without it none are listed. */
  organisation?: OrganisationSkills | undefined;
  /** Called after a skill was saved, deleted or switched, so that the module reads the skills again (`SkillsModule.refresh`). */
  changed?: (() => void) | undefined;
  maxMatched?: number;
  maxNamed?: number;
  maxPreloaded?: number;
}

const KNOWN_YAML_KEYS: ReadonlySet<string> = new Set([
  "title", "tags", "priority", "activation", "trigger_rules", "preferred_tools", "allowed_tools", "forbidden_tools", "knowledge_sources",
]);
const RECORD_KEYS: ReadonlySet<string> = new Set(["name", "description", "body", "resources", "fadenYaml", "license", "compatibility", "metadata", "allowedTools"]);
const MAX_QUERY = 20000;

const short = (key: string): string => (key.length > 40 ? key.slice(0, 40) : key);
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The skill editor's side of the module (sdk/51 F04): the person's skills in the module's store (IndexedDB), the bundled skills (read
 * only), the organisation's (governed mode: read only, never their instructions), the on/off switches, the checks, import and export
 * as a zip, and the test step over the module's own pre-selection. It writes only when the editor calls `save`, `commitImport`,
 * `delete` or `setEnabled`, which the person started; nothing here saves on its own, and no skill text changes a tool's class, a mode
 * or a grant. A skill is one record, so a save is atomic: the record is replaced whole, or not at all. .NET: SkillWorkshop.cs.
 */
export class StoreSkillWorkshop implements SkillWorkshop {
  readonly #options: SkillWorkshopOptions;
  readonly #bundled: readonly BundledSkill[];
  readonly #reserved: ReadonlySet<string>;
  readonly #switches: SkillSwitches;

  constructor(options: SkillWorkshopOptions) {
    this.#options = options;
    this.#bundled = options.bundled ?? [];
    this.#reserved = new Set(this.#bundled.map((b) => b.name));
    this.#switches = options.switches ?? new MemorySkillSwitches();
  }

  async list(signal?: AbortSignal): Promise<readonly SkillEntry[]> {
    const off = await this.#off();
    const entries: SkillEntry[] = [];
    for (const bundled of [...this.#bundled].sort((a, b) => ordinal(a.name, b.name))) {
      entries.push(createSkillEntry(bundled.name, bundled.description, SkillOrigin.Bundled, !off.has(bundled.name)));
    }
    for (const row of await this.#rows()) {
      const name = typeof row?.name === "string" ? row.name : "";
      if (name.length === 0) continue;
      const problem = checkSkill(row, name);
      let broken = problem !== undefined || this.#reserved.has(name);
      let reason = problem !== undefined ? skillIssue(SkillIssueCode.SkillMdUnreadable, SkillSeverity.Error, "SKILL.md", { detail: problem })
        : broken ? skillIssue(SkillIssueCode.NameReserved, SkillSeverity.Error, name) : undefined;
      if (!broken) {
        const check = this.check({ ...recordToDocument(row, name), instructions: "", extension: createExtensionFields(), resources: [] }, name);
        broken = check.hasErrors;
        reason = check.issues.find((i) => i.isError);
      }
      entries.push(createSkillEntry(name, typeof row.description === "string" ? row.description : "", SkillOrigin.Own, !off.has(name), broken, reason));
    }
    if (this.#options.organisation) {
      try {
        const list = await this.#options.organisation(signal);
        for (const skill of [...list].sort((a, b) => ordinal(a.name, b.name))) {
          entries.push(createSkillEntry(skill.slug.length > 0 ? skill.slug : skill.name, skill.description, SkillOrigin.Organisation, true));
        }
      } catch {
        // the organisation's list could not be read: the person's own skills are still there
      }
    }
    return entries;
  }

  async read(name: string): Promise<SkillReadResult> {
    const bundled = this.#bundled.find((b) => b.name === name);
    if (bundled) {
      const document = createSkillDocument({
        name: bundled.name,
        description: bundled.description,
        instructions: bundled.body,
        license: bundled.license ?? "",
        compatibility: bundled.compatibility ?? "",
        metadata: { ...(bundled.metadata ?? {}) },
        allowedTools: bundled.allowedTools ?? "",
        resources: Object.entries(bundled.resources ?? {}).map(([path, text]) => skillFileFromText(path, text)),
        extension: bundled.fadenYaml !== undefined ? this.parseExtension(bundled.fadenYaml).fields ?? createExtensionFields() : createExtensionFields(),
      });
      return { document, origin: SkillOrigin.Bundled, issues: [] };
    }
    let row: SkillDefinition | undefined;
    try {
      row = validName(name) ? await this.#options.store?.get(name) : undefined;
    } catch {
      row = undefined;
    }
    if (typeof row !== "object" || row === null) {
      return { document: undefined, origin: SkillOrigin.Own, issues: [skillIssue(SkillIssueCode.ReadFailed, SkillSeverity.Error, name)] };
    }
    const issues: SkillIssue[] = [];
    let extension = createExtensionFields();
    if (typeof row.fadenYaml === "string") {
      const parsed = this.parseExtension(row.fadenYaml);
      if (parsed.fields) extension = parsed.fields;
      // An unreadable faden.yaml is ignored by the module (the skill still works); a Save would replace it, so it is said.
      issues.push(...parsed.issues.map((i) => ({ ...i, severity: SkillSeverity.Warning, isError: false })));
    }
    const document = { ...recordToDocument(row, name), extension };
    issues.push(...this.check(document, name).issues);
    return { document, origin: SkillOrigin.Own, issues };
  }

  check(document: SkillDocument, folderName?: string): SkillCheck {
    return checkSkillDocument(document, folderName, this.#reserved);
  }

  async save(document: SkillDocument, previousName?: string, replaceExisting = false): Promise<SkillSaveResult> {
    if (previousName !== undefined && this.#reserved.has(previousName)) return skillSaveResult(SkillSaveStatus.NotAllowed, [], document.name);
    const store = this.#options.store;
    if (!store) return skillSaveResult(SkillSaveStatus.NotAllowed, [], document.name);
    const check = this.check(document);
    if (check.hasErrors) return skillSaveResult(SkillSaveStatus.Refused, check.issues, document.name);
    const from = previousName !== undefined && validName(previousName) ? previousName : undefined;
    try {
      const exists = (await store.get(document.name)) !== undefined;
      if (exists && from !== document.name && !replaceExisting) return skillSaveResult(SkillSaveStatus.Exists, check.issues, document.name);
      const definition = toDefinition(document);
      const renamed = from !== undefined && from !== document.name ? from : undefined;
      if (store.save) await store.save(definition, renamed);
      else {
        await store.add(definition);
        if (renamed !== undefined) await store.remove(renamed);
      }
    } catch {
      return skillSaveResult(SkillSaveStatus.Failed, [], document.name);
    }
    if (from !== undefined && from !== document.name && !(await this.#isEnabled(from))) {
      await this.#switch(from, true); // the switch follows the skill
      await this.#switch(document.name, false);
    }
    this.#options.changed?.();
    return skillSaveResult(SkillSaveStatus.Saved, check.issues, document.name);
  }

  async delete(name: string): Promise<boolean> {
    const store = this.#options.store;
    if (this.#reserved.has(name) || !store || !validName(name)) return false;
    let removed = false;
    try {
      removed = await store.remove(name);
    } catch {
      return false;
    }
    if (!removed) return false;
    await this.#switch(name, true);
    this.#options.changed?.();
    return true;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    let known = this.#reserved.has(name);
    if (!known && validName(name)) {
      try {
        known = (await this.#options.store?.get(name)) !== undefined;
      } catch {
        known = false;
      }
    }
    if (known && (await this.#switch(name, enabled))) this.#options.changed?.();
  }

  analyzeZip(zip: Uint8Array, source: string): Promise<ImportAnalysis> {
    return analyzeZip(zip, source, {
      extension: (text) => this.parseExtension(text),
      exists: async (name) => {
        try {
          return (await this.#options.store?.get(name)) !== undefined;
        } catch {
          return false;
        }
      },
      reserved: this.#reserved,
    });
  }

  async commitImport(analysis: ImportAnalysis, replaceExisting: boolean): Promise<SkillSaveResult> {
    // An analysis that found an error (an unreadable faden.yaml, say) is refused whole: its document is not what the person was shown.
    if (!analysis?.document || !analysis.ok) return skillSaveResult(SkillSaveStatus.Refused, analysis?.issues ?? []);
    // The analysis is checked again: what is written is what passes now, not what a caller says passed.
    return this.save(analysis.document, undefined, replaceExisting);
  }

  async exportZip(name: string): Promise<Uint8Array | undefined> {
    const read = await this.read(name);
    return read.document && !checkSkillDocument(read.document, undefined).hasErrors ? skillToZip(read.document) : undefined;
  }

  parseExtension(text: string): SkillExtensionParse {
    let extension: SkillExtension;
    try {
      extension = SkillExtension.parse(text);
    } catch (error) {
      if (!(error instanceof FadenYamlError)) throw error;
      return { fields: undefined, issues: [skillIssue(SkillIssueCode.FadenYamlUnreadable, SkillSeverity.Error, "faden.yaml", { detail: error.message })] };
    }
    const unknown: string[] = [];
    let allowed: string[] = [];
    let forbidden: string[] = [];
    let sources: string[] = [];
    const data = parseFadenYaml(text);
    if (data instanceof Map) {
      for (const key of data.keys()) if (!KNOWN_YAML_KEYS.has(key)) unknown.push(short(key));
      allowed = strings(data, "allowed_tools");
      forbidden = strings(data, "forbidden_tools");
      sources = strings(data, "knowledge_sources");
      const rules = data.get("trigger_rules");
      if (rules instanceof Map) for (const key of rules.keys()) if (key !== "keywords" && key !== "file_types") unknown.push("trigger_rules." + short(key));
    }
    const fields = createExtensionFields({
      title: extension.title ?? "",
      tags: extension.tags,
      priority: extension.priority,
      activation: extension.activation,
      keywords: extension.keywords,
      fileTypes: extension.fileTypes,
      preferredTools: extension.preferredTools,
      allowedTools: allowed,
      forbiddenTools: forbidden,
      knowledgeSources: sources,
      unknownKeys: unknown,
    });
    return { fields, issues: unknown.map((k) => skillIssue(SkillIssueCode.FadenYamlUnknownKey, SkillSeverity.Warning, "faden.yaml", { detail: k })) };
  }

  async test(prompt: string, edited?: SkillDocument, editedFrom?: string): Promise<SkillTestResult> {
    const off = await this.#off();
    const candidates: SkillCandidate[] = [];
    for (const bundled of this.#bundled.filter((b) => !off.has(b.name))) {
      candidates.push(new SkillCandidate(bundled.name, bundled.description, extensionOf(bundled.fadenYaml)));
    }
    for (const row of await this.#rows()) {
      const name = typeof row?.name === "string" ? row.name : "";
      if (name.length === 0 || off.has(name) || this.#reserved.has(name)) continue;
      const head = { ...recordToDocument(row, name), instructions: "x", extension: createExtensionFields(), resources: [] };
      if (checkSkill(row, name) === undefined && !this.check(head, name).hasErrors) {
        candidates.push(new SkillCandidate(name, head.description, extensionOf(typeof row.fadenYaml === "string" ? row.fadenYaml : undefined)));
      }
    }
    let editedListed = false;
    if (edited) {
      // The edited skill stands in for the saved one it came from (and for itself under the same name).
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i]!.name === edited.name || (editedFrom !== undefined && candidates[i]!.name === editedFrom)) candidates.splice(i, 1);
      }
      if (edited.name.length > 0 && !this.#reserved.has(edited.name)) {
        candidates.push(new SkillCandidate(edited.name, edited.description, extensionOf(writeExtensionYaml(edited.extension))));
        editedListed = true;
      }
    }
    const query = prompt.length > MAX_QUERY ? prompt.slice(0, MAX_QUERY) : prompt;
    const selection = select(candidates, { query }, this.#options.maxMatched, this.#options.maxNamed, this.#options.maxPreloaded);
    const listed = selection.listed.map((s) => s.name);
    return {
      listed,
      matches: selection.matches.map((m) => ({ name: m.skill.name, matchedBy: m.matchedBy, score: m.score })),
      preloaded: selection.preloaded.map((m) => m.skill.name),
      modelInstructions: render(selection, []),
      editedListed: editedListed && edited !== undefined && listed.includes(edited.name),
    };
  }

  async #off(): Promise<ReadonlySet<string>> {
    try {
      return await this.#switches.disabled();
    } catch {
      return new Set();
    }
  }

  async #isEnabled(name: string): Promise<boolean> {
    try {
      return await this.#switches.isEnabled(name);
    } catch {
      return true;
    }
  }

  async #switch(name: string, enabled: boolean): Promise<boolean> {
    try {
      return await this.#switches.set(name, enabled);
    } catch {
      return false;
    }
  }

  async #rows(): Promise<SkillDefinition[]> {
    try {
      return ((await this.#options.store?.list()) ?? []).slice().sort((a, b) => ordinal(String(a?.name), String(b?.name)));
    } catch {
      return [];
    }
  }
}

function extensionOf(yaml: string | undefined): SkillExtension | undefined {
  if (yaml === undefined || yaml.trim().length === 0) return undefined;
  try {
    return SkillExtension.parse(yaml);
  } catch (error) {
    if (error instanceof FadenYamlError) return undefined; // the module ignores a file it cannot read, and the skill still works
    throw error;
  }
}

/** core's `_string_list`, as the editor lists it: a string split at commas and white space, or the strings of a list. */
function strings(map: Map<string, unknown>, key: string): string[] {
  const value = map.get(key);
  if (typeof value === "string") return value.split(/[,\s]+/).filter((p) => p.length > 0);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter((v) => v.length > 0) : [];
}

/** A stored record as the editor's document, whatever the record holds (a record that breaks a rule is still shown, to fix or delete). */
function recordToDocument(row: SkillDefinition, name: string): SkillDocument {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const resources = typeof row.resources === "object" && row.resources !== null && !Array.isArray(row.resources) ? row.resources : {};
  const metadata = typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
    ? Object.fromEntries(Object.entries(row.metadata).filter(([, value]) => typeof value === "string"))
    : {};
  return createSkillDocument({
    name: text(row.name) || name,
    description: text(row.description),
    license: text(row.license),
    compatibility: text(row.compatibility),
    metadata,
    allowedTools: text(row.allowedTools),
    instructions: text(row.body),
    resources: Object.entries(resources).filter(([, v]) => typeof v === "string").map(([path, v]) => skillFileFromText(path, v)),
    unknownKeys: Object.keys(row).filter((k) => !RECORD_KEYS.has(k)).map(short),
  });
}

/** The document as the record the store keeps: the six fields, the body, the resources (text) and the `faden.yaml` text. */
export function toDefinition(document: SkillDocument): SkillDefinition {
  const definition: SkillDefinition = {
    name: document.name,
    description: document.description,
    body: document.instructions.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/^\n+|\n+$/g, ""),
  };
  if (document.resources.length > 0) definition.resources = Object.fromEntries(document.resources.map((f) => [f.path, skillFileText(f) ?? ""]));
  const yaml = writeExtensionYaml(document.extension);
  if (yaml !== undefined) definition.fadenYaml = yaml;
  if (document.license.length > 0) definition.license = document.license;
  if (document.compatibility.length > 0) definition.compatibility = document.compatibility;
  if (Object.keys(document.metadata).length > 0) definition.metadata = { ...document.metadata };
  if (document.allowedTools.length > 0) definition.allowedTools = document.allowedTools;
  return definition;
}
