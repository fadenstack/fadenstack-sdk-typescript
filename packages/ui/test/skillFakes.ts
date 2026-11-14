import {
  createSkillDocument,
  skillFileFromText,
  type ImportAnalysis,
  type SkillCheck,
  type SkillDocument,
  type SkillEntry,
  type SkillExtensionParse,
  type SkillFile,
  type SkillReadResult,
  type SkillSaveResult,
  type SkillTestResult,
  type SkillWorkshop,
  type SkillZipFile,
  type OrganisationSkills,
} from "@fadenstack/agents";
import type { ChatMessage, ChatOptions, ChatStreamer, ChatUpdate, SkillOption } from "@fadenstack/client";
import { MemorySkillStore, MemorySkillSwitches, StoreSkillWorkshop, writeZip, type BundledSkill, type SkillDefinition } from "@fadenstack/skills";
import {
  SkillLibraryViewModel,
  englishStrings,
  builtInStrings,
  type SkillFileHost,
  type SkillModel,
  type StringsSource,
  type UiStrings,
} from "@fadenstack/ui";

// The skill editor's fakes (.NET: SkillEditorFakes.cs): a workshop that is the real one (`StoreSkillWorkshop`, with its real checks, zip
// import and export, and pre-selection) over a store in memory, seen through a spy that counts what was written and can hold an
// import or a test back; a file host; and a model that answers from a script and keeps what it was asked. There is no disk: "on
// disk" is `store.get`.

/** Lets every pending microtask and promise continuation run. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Waits (briefly) for a condition that a fire-and-forget refresh brings about. */
export async function waitUntil(condition: () => boolean, milliseconds = 5000): Promise<void> {
  const until = Date.now() + milliseconds;
  while (!condition() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** A promise the test completes later. */
export class Gate<T = void> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }

  open(value: T): void {
    this.#resolve(value);
  }
}

/** The workshop the editor talks to: the real one over memory, counting what the person's commands write. */
export class SpyWorkshop implements SkillWorkshop {
  saves = 0;
  commits = 0;
  deletes = 0;
  readonly saveNames: string[] = [];
  /** When set, an import analysis waits for it (called with the zip's name). */
  holdAnalysis: ((source: string) => Promise<void>) | undefined;
  /** When set, a test waits for it (called with the prompt). */
  holdTest: ((prompt: string) => Promise<void>) | undefined;
  readonly #inner: SkillWorkshop;

  constructor(inner: SkillWorkshop) {
    this.#inner = inner;
  }

  list(signal?: AbortSignal): Promise<readonly SkillEntry[]> {
    return this.#inner.list(signal);
  }

  read(name: string, signal?: AbortSignal): Promise<SkillReadResult> {
    return this.#inner.read(name, signal);
  }

  check(document: SkillDocument, folderName?: string): SkillCheck {
    return this.#inner.check(document, folderName);
  }

  save(document: SkillDocument, previousName?: string, replaceExisting?: boolean, signal?: AbortSignal): Promise<SkillSaveResult> {
    this.saves++;
    this.saveNames.push(document.name);
    return this.#inner.save(document, previousName, replaceExisting, signal);
  }

  delete(name: string, signal?: AbortSignal): Promise<boolean> {
    this.deletes++;
    return this.#inner.delete(name, signal);
  }

  setEnabled(name: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
    return this.#inner.setEnabled(name, enabled, signal);
  }

  async analyzeZip(zip: Uint8Array, source: string, signal?: AbortSignal): Promise<ImportAnalysis> {
    if (this.holdAnalysis) await this.holdAnalysis(source);
    return this.#inner.analyzeZip(zip, source, signal);
  }

  commitImport(analysis: ImportAnalysis, replaceExisting: boolean, signal?: AbortSignal): Promise<SkillSaveResult> {
    this.commits++;
    return this.#inner.commitImport(analysis, replaceExisting, signal);
  }

  exportZip(name: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    return this.#inner.exportZip(name, signal);
  }

  parseExtension(text: string): SkillExtensionParse {
    return this.#inner.parseExtension(text);
  }

  async test(prompt: string, edited?: SkillDocument, editedFrom?: string): Promise<SkillTestResult> {
    if (this.holdTest) await this.holdTest(prompt);
    return this.#inner.test(prompt, edited, editedFrom);
  }
}

/** A workshop whose every call fails: "the skills could not be read". */
export class ThrowingWorkshop implements SkillWorkshop {
  list(): Promise<readonly SkillEntry[]> {
    return Promise.reject(new Error("disk"));
  }

  read(): Promise<SkillReadResult> {
    return Promise.reject(new Error("not supported"));
  }

  check(): SkillCheck {
    throw new Error("not supported");
  }

  save(): Promise<SkillSaveResult> {
    return Promise.reject(new Error("not supported"));
  }

  delete(): Promise<boolean> {
    return Promise.reject(new Error("not supported"));
  }

  setEnabled(): Promise<void> {
    return Promise.reject(new Error("not supported"));
  }

  analyzeZip(): Promise<ImportAnalysis> {
    return Promise.reject(new Error("not supported"));
  }

  commitImport(): Promise<SkillSaveResult> {
    return Promise.reject(new Error("not supported"));
  }

  exportZip(): Promise<Uint8Array | undefined> {
    return Promise.reject(new Error("not supported"));
  }

  parseExtension(): SkillExtensionParse {
    throw new Error("not supported");
  }

  test(): Promise<SkillTestResult> {
    return Promise.reject(new Error("not supported"));
  }
}

/** The app's file host: what the person "chose", and what was handed over. */
export class FakeFiles implements SkillFileHost {
  importZip: SkillZipFile | undefined;
  resource: SkillFile | undefined;
  exported: Uint8Array | undefined;
  exportedAs: string | undefined;
  exportWorks = true;

  pickImport(): Promise<SkillZipFile | undefined> {
    return Promise.resolve(this.importZip);
  }

  saveExport(suggestedFileName: string, zip: Uint8Array): Promise<boolean> {
    this.exported = zip;
    this.exportedAs = suggestedFileName;
    return Promise.resolve(this.exportWorks);
  }

  pickResource(): Promise<SkillFile | undefined> {
    return Promise.resolve(this.resource);
  }
}

/**
 * A store that can also hold a record the real one would refuse (a field beyond the six, left by another version): such a record is
 * listed and read like any other, and a Save over it replaces it with a clean one.
 */
export class RigStore extends MemorySkillStore {
  readonly #raw = new Map<string, SkillDefinition>();

  putRaw(record: Record<string, unknown>): void {
    this.#raw.set(String(record["name"]), structuredClone(record) as unknown as SkillDefinition);
  }

  override async list(): Promise<SkillDefinition[]> {
    const kept = await super.list();
    const names = new Set(kept.map((k) => k.name));
    return [...kept, ...[...this.#raw.values()].filter((r) => !names.has(r.name)).map((r) => structuredClone(r))].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  override async get(name: string): Promise<SkillDefinition | undefined> {
    const raw = this.#raw.get(name);
    return raw ? structuredClone(raw) : super.get(name);
  }

  override async save(skill: SkillDefinition, previousName?: string): Promise<void> {
    await super.save(skill, previousName);
    this.#raw.delete(skill.name);
    if (previousName !== undefined) this.#raw.delete(previousName);
  }

  override async remove(name: string): Promise<boolean> {
    const had = this.#raw.delete(name);
    return (await super.remove(name)) || had;
  }
}

export interface SkillRigOptions {
  /** The bundled skills; by default one, `slide-design`. */
  bundled?: readonly BundledSkill[];
  organisation?: OrganisationSkills;
}

export const english: UiStrings = englishStrings;

/** A UiStrings in one of the five built-in languages. */
export const inLanguage = (language: string): UiStrings => builtInStrings[language]!;

/** The workshop, its store, the switches, the file host and a library built on them. */
export class SkillRig {
  readonly store = new RigStore();
  readonly switches = new MemorySkillSwitches();
  readonly bundled: BundledSkill[];
  readonly real: StoreSkillWorkshop;
  readonly workshop: SpyWorkshop;
  readonly files = new FakeFiles();

  constructor(options: SkillRigOptions = {}) {
    this.bundled = [...(options.bundled ?? [{ name: "slide-design", description: "Designs a slide.", body: "Use one idea per slide.", fadenYaml: "trigger_rules:\n  keywords:\n    - slide\n" }])];
    this.real = new StoreSkillWorkshop({ bundled: this.bundled, store: this.store, switches: this.switches, organisation: options.organisation });
    this.workshop = new SpyWorkshop(this.real);
  }

  /** Whether the person's skill of this name is kept (the .NET tests ask whether its folder exists). */
  async onDisk(name: string): Promise<boolean> {
    return (await this.store.get(name)) !== undefined;
  }

  /** Nothing of the person's is kept at all (the .NET tests ask whether the skills folder exists). */
  async isEmpty(): Promise<boolean> {
    return (await this.store.list()).length === 0;
  }

  library(model?: SkillModel, strings?: StringsSource): SkillLibraryViewModel {
    return new SkillLibraryViewModel({ workshop: this.workshop, files: this.files, model, strings: strings ?? (() => english) });
  }
}

/** A skill to save: contract-review unless said otherwise. */
export function doc(name = "contract-review", description = "Reviews a contract clause by clause.", changes: Partial<SkillDocument> = {}): SkillDocument {
  return createSkillDocument({
    name,
    description,
    instructions: "## Goal\nReview the contract.\n\n## Procedure\n1. Read each clause.\n",
    ...changes,
  });
}

export const textFile = skillFileFromText;

/** A zip with these text entries, in this order (a path is written as given, also a hostile one). */
export async function makeZip(...entries: readonly (readonly [string, string])[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  return writeZip(entries.map(([path, text]) => ({ path, bytes: encoder.encode(text) })));
}

export async function zipOf(name: string, ...entries: readonly (readonly [string, string])[]): Promise<SkillZipFile> {
  return { name, bytes: await makeZip(...entries) };
}

export function organisationSkills(...skills: readonly Partial<SkillOption>[]): OrganisationSkills {
  return () => Promise.resolve(skills.map((s) => ({ id: s.slug ?? "x", slug: "", name: "", description: "", activation: "auto", ...s })));
}

// -- the model ------------------------------------------------------------------------------------------

type Answer = (messages: readonly ChatMessage[], options: ChatOptions | undefined) => Promise<readonly ChatUpdate[]>;

/** A model that answers from a script and keeps what it was asked; it runs no tool. After the script it says "Done.". */
export class ScriptedModel implements ChatStreamer {
  readonly calls: { messages: readonly ChatMessage[]; options: ChatOptions | undefined }[] = [];
  readonly #answers: Answer[] = [];

  says(text: string): this {
    return this.reply(() => Promise.resolve([{ type: "text", text }, { type: "finish", reason: "stop" }]));
  }

  loads(skill: string): this {
    return this.reply(() =>
      Promise.resolve([
        {
          type: "tool_calls",
          calls: [{ id: "call-1", name: "load_skill", argumentsJson: JSON.stringify({ skillName: skill }), arguments: { skillName: skill } }],
        },
        { type: "finish", reason: "tool_calls" },
      ]),
    );
  }

  throws(): this {
    return this.reply(() => Promise.reject(new Error("offline")));
  }

  reply(answer: Answer): this {
    this.#answers.push(answer);
    return this;
  }

  async *stream(messages: readonly ChatMessage[], options?: ChatOptions): AsyncIterable<ChatUpdate> {
    this.calls.push({ messages: [...messages], options });
    const answer = this.#answers.shift();
    const updates = answer ? await answer(messages, options) : [{ type: "text", text: "Done." } as ChatUpdate, { type: "finish", reason: "stop" } as ChatUpdate];
    for (const update of updates) yield update;
  }
}
