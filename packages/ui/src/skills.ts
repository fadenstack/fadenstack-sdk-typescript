import type { SkillOption } from "@fadenstack/client";

import { Observable } from "./observable.js";

let counter = 0;

/** How long a loaded list is used before the picker reads it again. */
const LIST_TTL_MS = 5 * 60_000;
/** Skills listed in the picker at most; typing narrows them. */
const SHOWN = 8;

/**
 * Where a skill is asked for in the composer's text: `$name` at the end (after a space or at the start), or
 * `/name` as the whole message. Returns the query and where the token starts, or undefined.
 */
export function skillToken(input: string): { query: string; start: number } | undefined {
  const dollar = /(?:^|\s)\$([\p{L}\p{N}_.-]*)$/u.exec(input);
  if (dollar) return { query: dollar[1]!, start: input.length - dollar[1]!.length - 1 };
  const slash = /^\/([\p{L}\p{N}_.-]*)$/u.exec(input);
  if (slash) return { query: slash[1]!, start: 0 };
  return undefined;
}

/** Lower case without accents, so "uberprufung" finds "Überprüfung". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The skills that match `query`: by name or slug first, then by description; all of them for an empty one. */
export function matchSkills(skills: readonly SkillOption[], query: string): SkillOption[] {
  const q = fold(query.trim());
  if (!q) return [...skills];
  const named: SkillOption[] = [];
  const described: SkillOption[] = [];
  for (const skill of skills) {
    if (fold(skill.name).includes(q) || fold(skill.slug).includes(q)) named.push(skill);
    else if (fold(skill.description).includes(q)) described.push(skill);
  }
  return [...named, ...described];
}

/**
 * The list that opens when the user types `$` (or `/` at the start) in the composer: the skills they can pick for
 * the message, narrowed as they type; arrows move, Enter picks, Esc closes. The chat owns it (`chat.skillPicker`)
 * and opens and closes it as the text changes. It reads the list once and again after a few minutes.
 */
export class SkillPickerViewModel extends Observable {
  /** For the ids skins give the list and its options, unique on the page. */
  readonly key = `fdn-skills-${++counter}`;
  readonly #load: (signal: AbortSignal) => Promise<SkillOption[]>;
  readonly #onPick: (skill: SkillOption) => void;
  readonly #now: () => number;
  #all: readonly SkillOption[] | undefined;
  #loadedAt = 0;
  #loading: Promise<void> | undefined;
  #failed = false;
  #open = false;
  #query = "";
  #active = 0;

  constructor(options: {
    load: (signal: AbortSignal) => Promise<SkillOption[]>;
    onPick: (skill: SkillOption) => void;
    now?: () => number;
  }) {
    super();
    this.#load = options.load;
    this.#onPick = options.onPick;
    this.#now = options.now ?? Date.now;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get query(): string {
    return this.#query;
  }

  get isLoading(): boolean {
    return this.#loading !== undefined && this.#all === undefined;
  }

  /** The list could not be read (the picker says so; typing on tries again). */
  get failed(): boolean {
    return this.#failed;
  }

  /** What the list shows: the matches, the best first, a few at most. */
  get options(): readonly SkillOption[] {
    return this.#all ? matchSkills(this.#all, this.#query).slice(0, SHOWN) : [];
  }

  /** Whether the user can pick any skill at all, once the list is read. */
  get hasSkills(): boolean {
    return (this.#all?.length ?? 0) > 0;
  }

  /** The option Enter picks. */
  get activeIndex(): number {
    return Math.min(this.#active, Math.max(0, this.options.length - 1));
  }

  /** Opens the list (or narrows it) for what follows the `$`. */
  show(query: string): void {
    const changed = !this.#open || query !== this.#query;
    this.#open = true;
    if (query !== this.#query) this.#active = 0;
    this.#query = query;
    if (!this.#all || this.#now() - this.#loadedAt > LIST_TTL_MS || this.#failed) void this.#read();
    if (changed) this.notify();
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#query = "";
    this.#active = 0;
    this.notify();
  }

  /** Moves the choice down (1) or up (-1), round the list. */
  move(step: number): void {
    const count = this.options.length;
    if (count === 0) return;
    this.#active = (this.activeIndex + step + count) % count;
    this.notify();
  }

  /** Picks a skill (the active one when none is given); the chat takes it for the message. */
  pick(skill: SkillOption | undefined = this.options[this.activeIndex]): void {
    if (!skill) return;
    this.close();
    this.#onPick(skill);
  }

  async #read(): Promise<void> {
    if (this.#loading) return this.#loading;
    this.#failed = false;
    const reading = (async () => {
      try {
        this.#all = await this.#load(new AbortController().signal);
        this.#loadedAt = this.#now();
      } catch {
        this.#failed = this.#all === undefined;
      } finally {
        this.#loading = undefined;
        this.notify();
      }
    })();
    this.#loading = reading;
    this.notify();
    return reading;
  }
}
