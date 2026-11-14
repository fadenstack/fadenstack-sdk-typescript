import { createExtensionFields, createSkillDocument, type SkillDocument, type SkillExtensionFields, type SkillFile } from "@fadenstack/agents";
import type { SkillOption } from "@fadenstack/client";
import {
  MemorySkillStore,
  MemorySkillSwitches,
  skillsModule,
  type SkillDefinition,
  type SkillStore,
  type SkillsModule,
  type StoreSkillWorkshop,
} from "@fadenstack/skills";

/** A workshop over a store in memory, the switches in memory and a bundled skill (the .NET tests' `WorkshopRig`, without a folder). */

export const GOOD_SKILL_MD = "---\nname: contract-review\ndescription: Reviews a contract clause by clause.\n---\n## Goal\nReview it.\n";

/** The bundled skill of the rig: its name is taken, its resource is a file called `layouts`, its faden.yaml keys on slide and deck. */
export const BUNDLED_SLIDE_DESIGN: SkillDefinition = {
  name: "slide-design",
  description: "Designs a slide.",
  body: "Use one idea per slide.",
  resources: { layouts: "Title, then two columns." },
  fadenYaml: "trigger_rules:\n  keywords:\n    - slide\n    - deck\n",
};

/** A document with a body, as `WorkshopRig.Doc`. */
export function doc(name = "contract-review", description = "Reviews a contract clause by clause.", more: Partial<SkillDocument> = {}): SkillDocument {
  return createSkillDocument({
    name,
    description,
    instructions: "## Goal\nReview the contract.\n\n## Procedure\n1. Read each clause.\n2. Flag the risky ones.\n",
    ...more,
  });
}

export function fields(changes: Partial<SkillExtensionFields> = {}): SkillExtensionFields {
  return createExtensionFields(changes);
}

export function textFile(path: string, content: string): SkillFile {
  return { path, bytes: new TextEncoder().encode(content) };
}

export function binaryFile(path: string, bytes: readonly number[]): SkillFile {
  return { path, bytes: Uint8Array.from(bytes) };
}

/** A store that keeps a record as it is given, however it breaks the rules (a store written by another version, or by hand). */
export class RawSkillStore implements SkillStore {
  readonly records = new Map<string, unknown>();
  failWrites = false;
  readonly #listeners = new Set<() => void>();

  async list(): Promise<SkillDefinition[]> {
    return [...this.records.values()].map((r) => structuredClone(r) as SkillDefinition);
  }

  async get(name: string): Promise<SkillDefinition | undefined> {
    const record = this.records.get(name);
    return record === undefined ? undefined : (structuredClone(record) as SkillDefinition);
  }

  async add(skill: SkillDefinition): Promise<void> {
    if (this.failWrites) throw new Error("the disk is full");
    this.records.set(skill.name, structuredClone(skill));
    for (const listener of this.#listeners) listener();
  }

  async remove(name: string): Promise<boolean> {
    return this.records.delete(name);
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {}
}

/** A store of which every write fails at the end, after it has looked at the skill: nothing of it is kept. */
export class FailingStore extends MemorySkillStore {
  override async add(): Promise<void> {
    throw new Error("the write failed");
  }

  override async save(): Promise<void> {
    throw new Error("the write failed");
  }
}

export interface WorkshopRig {
  readonly store: SkillStore;
  readonly switches: MemorySkillSwitches;
  readonly module: SkillsModule;
  readonly workshop: StoreSkillWorkshop;
  readonly changes: { count: number };
}

/** The rig: the module over the store and the switches, and its workshop. `changed` counts the module's own refreshes. */
export function workshopRig(options: { store?: SkillStore; organisation?: () => Promise<readonly SkillOption[]> } = {}): WorkshopRig {
  const store = options.store ?? new MemorySkillStore();
  const switches = new MemorySkillSwitches();
  const module = skillsModule({ store, switches, bundled: [BUNDLED_SLIDE_DESIGN] });
  const changes = { count: 0 };
  module.onChanged(() => changes.count++);
  const workshop = module.workshop(options.organisation ? { organisation: options.organisation } : {});
  return { store, switches, module, workshop, changes };
}
