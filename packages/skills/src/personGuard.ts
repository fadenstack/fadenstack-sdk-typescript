import type { SkillDefinition } from "./skillRules.js";
import type { SkillStore } from "./store.js";
import type { SkillSwitches } from "./skillSwitches.js";

/**
 * A change was asked before the skills module knows whose skills these are: the agent has not started, so it has not read the profile
 * that names the person. .NET: "Whose skills these are is not known yet: start the agent first, so that the skills module has read its profile."
 */
export class SkillsPersonUnknownError extends Error {
  constructor() {
    super("Whose skills these are is not known yet: start the agent first, so that the skills module has read its profile.");
    this.name = "SkillsPersonUnknownError";
  }
}

/**
 * The person's own skills of a module that does not yet know the person (sdk/51 F04; as .NET's `SkillsModule.OwnFolder`, which is null
 * until the profile names one): nothing is listed, and a change throws `SkillsPersonUnknownError`, so that no skill is ever written to
 * the database of the wrong person (the standalone principal's, before a governed profile names the real one).
 */
export class PersonGuardedSkillStore implements SkillStore {
  readonly #inner: SkillStore;
  readonly #known: () => boolean;

  constructor(inner: SkillStore, known: () => boolean) {
    this.#inner = inner;
    this.#known = known;
  }

  list(): Promise<SkillDefinition[]> {
    return this.#known() ? this.#inner.list() : Promise.resolve([]);
  }

  get(name: string): Promise<SkillDefinition | undefined> {
    return this.#known() ? this.#inner.get(name) : Promise.resolve(undefined);
  }

  add(skill: SkillDefinition): Promise<void> {
    return this.#known() ? this.#inner.add(skill) : Promise.reject(new SkillsPersonUnknownError());
  }

  save(skill: SkillDefinition, previousName?: string): Promise<void> {
    if (!this.#known()) return Promise.reject(new SkillsPersonUnknownError());
    const inner = this.#inner;
    return inner.save ? inner.save(skill, previousName) : this.#addThenRemove(skill, previousName);
  }

  async #addThenRemove(skill: SkillDefinition, previousName: string | undefined): Promise<void> {
    await this.#inner.add(skill);
    if (previousName !== undefined && previousName !== skill.name) await this.#inner.remove(previousName);
  }

  remove(name: string): Promise<boolean> {
    return this.#known() ? this.#inner.remove(name) : Promise.reject(new SkillsPersonUnknownError());
  }

  onChanged(listener: () => void): () => void {
    return this.#inner.onChanged(listener);
  }

  close(): void {
    this.#inner.close();
  }
}

/** The person's switches of a module that does not yet know the person: every skill is on, and a change throws. */
export class PersonGuardedSkillSwitches implements SkillSwitches {
  readonly #inner: SkillSwitches;
  readonly #known: () => boolean;

  constructor(inner: SkillSwitches, known: () => boolean) {
    this.#inner = inner;
    this.#known = known;
  }

  disabled(): Promise<ReadonlySet<string>> {
    return this.#known() ? this.#inner.disabled() : Promise.resolve(new Set<string>());
  }

  isEnabled(name: string): Promise<boolean> {
    return this.#known() ? this.#inner.isEnabled(name) : Promise.resolve(true);
  }

  set(name: string, enabled: boolean): Promise<boolean> {
    return this.#known() ? this.#inner.set(name, enabled) : Promise.reject(new SkillsPersonUnknownError());
  }

  close(): void {
    (this.#inner as { close?: () => void }).close?.();
  }
}
