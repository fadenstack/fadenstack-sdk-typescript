import { SkillExtension, WORD } from "./skillExtension.js";

/** A skill the person can use on this device, with what its `faden.yaml` says (`SkillExtension.empty` without one). */
export class SkillCandidate {
  readonly name: string;
  readonly description: string;
  readonly extension: SkillExtension;
  /** Whether a `faden.yaml` was read for the skill. */
  readonly hasFile: boolean;

  constructor(name: string, description: string, extension?: SkillExtension) {
    this.name = name;
    this.description = description;
    this.extension = extension ?? SkillExtension.empty;
    this.hasFile = extension !== undefined;
  }

  get priority(): number {
    return this.extension.priority;
  }

  /**
   * A skill the pre-selection does not filter: `auto` with no keywords and no file types, which is every skill without a
   * `faden.yaml`. Core would never offer one (nothing matches it); a person's own skills stay listed as before.
   */
  get unfiltered(): boolean {
    return this.extension.activation === "auto" && this.extension.keywords.length === 0 && this.extension.fileTypes.length === 0;
  }
}

/** What a request says about itself (core's `RequestContext`, minus the server's users, assistants and projects). */
export interface SkillRequest {
  query?: string | undefined;
  /** Skills asked for by name (a picker); a `$slug` in `query` asks for one too. */
  requested?: readonly string[];
  fileTypes?: readonly string[];
  tags?: readonly string[];
}

export type MatchedBy = "explicit" | "always" | "trigger";

/** A skill a request gets, and why: `explicit`, `always` or `trigger` (core's `Match`). */
export interface SkillMatch {
  readonly skill: SkillCandidate;
  readonly score: number;
  readonly matchedBy: MatchedBy;
  /** How many keywords and file types of the skill the request matched (tags do not count: they are a weak sign). */
  readonly triggerHits: number;
}

/** What one turn offers: the skills listed for the model, and the ones whose instructions are loaded for it. */
export interface SkillSelection {
  readonly listed: readonly SkillCandidate[];
  readonly matches: readonly SkillMatch[];
  readonly preloaded: readonly SkillMatch[];
}

export const EXPLICIT = "explicit";
export const ALWAYS = "always";
export const TRIGGER = "trigger";

export const MAX_MATCHED = 3;
export const MAX_NAMED = 5;
export const MAX_PRELOADED = 1;

const TRIGGER_BOOST = 30;
const TAG_BOOST = 20;

// ``$code-review`` in a message: not after a word character or another $ ("US$5", "$$"), and the slug holds a letter ("$100" is a price).
const MENTION = new RegExp(`(?<![${WORD}$])\\$([a-z0-9]+(?:-[a-z0-9]+)*)(?![${WORD}-])`, "giu");

/** The skills a message asks for with `$slug`, in order, once each (core's `mentions`). */
export function mentions(text: string | undefined | null): string[] {
  const found: string[] = [];
  if (!text) return found;
  for (const match of text.matchAll(MENTION)) {
    const slug = match[1]!.toLowerCase();
    if (/[a-z]/.test(slug) && !found.includes(slug)) found.push(slug);
  }
  return found;
}

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The skills `request` gets: named ones first, then by score (core's `choose`). */
export function choose(candidates: Iterable<SkillCandidate>, request: SkillRequest, maxResults = MAX_MATCHED, maxExplicit = MAX_NAMED): SkillMatch[] {
  const all = [...candidates];
  const asked = (request.requested ?? []).filter((a) => a.trim().length > 0).map((a) => a.trim().toLowerCase());
  asked.push(...mentions(request.query).filter((m) => !asked.includes(m)));

  const explicitMatches: SkillMatch[] = [];
  for (const name of asked) {
    const pick = all.find((c) => c.name === name);
    if (pick && explicitMatches.every((m) => m.skill !== pick)) {
      explicitMatches.push({ skill: pick, score: 1000 + pick.priority, matchedBy: EXPLICIT, triggerHits: 0 });
    }
  }
  explicitMatches.length = Math.min(explicitMatches.length, Math.max(maxExplicit, 0));

  const scored: SkillMatch[] = [];
  for (const candidate of all) {
    if (explicitMatches.some((m) => m.skill === candidate)) continue;
    const match = implicit(candidate, request);
    if (match) scored.push(match);
  }
  const ranked = scored
    .sort((a, b) => b.score - a.score || b.skill.priority - a.skill.priority || ordinal(a.skill.name, b.skill.name))
    .slice(0, Math.max(maxResults, 0));
  return [...explicitMatches, ...ranked];
}

function implicit(candidate: SkillCandidate, request: SkillRequest): SkillMatch | undefined {
  if (candidate.extension.activation === "manual") return undefined;
  const matched = score(candidate, request);
  if (candidate.extension.activation === "always") {
    return { skill: candidate, score: matched?.score ?? candidate.priority, matchedBy: ALWAYS, triggerHits: matched?.hits ?? 0 };
  }
  return matched ? { skill: candidate, score: matched.score, matchedBy: TRIGGER, triggerHits: matched.hits } : undefined;
}

function score(candidate: SkillCandidate, request: SkillRequest): { score: number; hits: number } | undefined {
  let total = candidate.priority;
  let hits = 0;
  let matched = false;
  const query = request.query ?? "";
  const extension = candidate.extension;
  for (const keyword of extension.keywordMatchers) {
    if (query.length > 0 && keyword.test(query)) {
      matched = true;
      hits++;
      total += TRIGGER_BOOST;
    }
  }
  const wanted = new Set((request.fileTypes ?? []).map((f) => stripDots(f.toLowerCase())));
  for (const fileType of extension.fileTypes) {
    if (wanted.has(stripDots(fileType.toLowerCase()))) {
      matched = true;
      hits++;
      total += TRIGGER_BOOST;
    }
  }
  for (const tag of request.tags ?? []) {
    if (extension.tags.includes(tag)) {
      matched = true;
      total += TAG_BOOST;
    }
  }
  return matched ? { score: total, hits } : undefined;
}

function stripDots(text: string): string {
  return text.replace(/^\.+/, "");
}

/**
 * What one turn offers: the matches (`choose`), then the skills that are not filtered, listed for the model; and the matches whose
 * instructions are loaded (see below), at most `maxPreloaded`.
 *
 * Which skills a turn gets (sdk/51 F04, D16: the model picks; `faden.yaml` filters, ranks and may pre-load), ported from core's
 * `skills/faden_skills/services/resolve.py` with its numbers: named skills first (up to 5, whatever their activation), then the
 * `always` and the matched `auto` skills by score, cut at 3; `manual` skills only by name. A keyword counts as a whole word or
 * phrase (+30 each), a file type +30, a tag +20, on top of the skill's priority; ties go to the higher priority, then the name.
 * Core has no assignments, owners or visibility here: every skill is the person's own.
 *
 * Core gives every skill it resolves to the model, with its instructions. This module lists them and loads the instructions of the
 * first `maxPreloaded` (default 1) that were asked for by name, are `always` on, or matched a keyword or file type: the "strong"
 * match. A local model has a short context; the others are listed, and `load_skill` loads any of them. .NET: `SkillResolver.Select`.
 */
export function select(candidates: readonly SkillCandidate[], request: SkillRequest, maxResults = MAX_MATCHED, maxExplicit = MAX_NAMED,
  maxPreloaded = MAX_PRELOADED): SkillSelection {
  const matches = choose(candidates, request, maxResults, maxExplicit);
  const listed = matches.map((m) => m.skill);
  listed.push(...candidates.filter((c) => c.unfiltered && !listed.includes(c))
    .sort((a, b) => b.priority - a.priority || ordinal(a.name, b.name)));
  // A skill the person named ($slug) is loaded, faden.yaml or not: they asked for it. Otherwise only a strong match of a skill
  // with faden.yaml (always, or a keyword or file type hit).
  const preloaded = matches
    .filter((m) => m.matchedBy === EXPLICIT || (m.skill.hasFile && (m.matchedBy !== TRIGGER || m.triggerHits > 0)))
    .slice(0, Math.max(maxPreloaded, 0));
  return { listed, matches, preloaded };
}
