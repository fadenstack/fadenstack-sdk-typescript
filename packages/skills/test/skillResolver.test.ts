import { describe, expect, it } from "vitest";

import { SkillCandidate, SkillExtension, chooseSkills, selectSkills, skillMentions, type SkillMatch, type SkillRequest } from "@fadenstack/skills";

/**
 * The pre-selection's rules, ported from core's `skills/tests/test_resolve.py` (release/0.7.1) and its `resolve.py`, through the .NET
 * `SkillResolverTests`. The tests of owners, visibility and assignments there (a private always-on skill, asking by name for the
 * closest of three, the project and workspace assignments) have no counterpart here: on a device every skill is the person's own. The
 * numbers are core's: a keyword and a file type +30, a tag +20, a named skill 1000, three matches, five named.
 */

/** A skill as its faden.yaml would make it. */
function skill(name: string, activation = "auto", priority = 50, more: { keywords?: string[]; fileTypes?: string[]; tags?: string[] } = {}): SkillCandidate {
  let yaml = `activation: ${activation}\npriority: ${priority}\n`;
  if (more.tags) yaml += `tags: [${more.tags.join(", ")}]\n`;
  if (more.keywords || more.fileTypes) {
    yaml += "trigger_rules:\n";
    if (more.keywords) yaml += `  keywords: [${more.keywords.map((k) => `"${k}"`).join(", ")}]\n`;
    if (more.fileTypes) yaml += `  file_types: [${more.fileTypes.join(", ")}]\n`;
  }
  return new SkillCandidate(name, `${name} description`, SkillExtension.parse(yaml));
}

const ask = (query?: string, more: Partial<SkillRequest> = {}): SkillRequest => ({ query, requested: [], fileTypes: [], tags: [], ...more });
const names = (matches: readonly SkillMatch[]) => matches.map((m) => m.skill.name);

describe("mentions", () => {
  it("are skills, not prices", () => {
    const text = "Use $code-review and $SQL-Tuning, not $100, US$5 or $$x; again $code-review.";
    expect(skillMentions(text)).toEqual(["code-review", "sql-tuning"]);
    expect(skillMentions(undefined)).toEqual([]);
    expect(skillMentions("")).toEqual([]);
  });
});

describe("choosing skills", () => {
  it("needs an auto skill's trigger as a word", () => {
    const art = skill("art-critic", "auto", 50, { keywords: ["art"] });
    expect(chooseSkills([art], ask("Let us start the report"))).toEqual([]);
    expect(names(chooseSkills([art], ask("What makes art good?")))).toEqual(["art-critic"]);
  });

  it("gives a manual skill only when asked for", () => {
    const manual = skill("tone", "manual", 50, { keywords: ["tone"] });
    expect(chooseSkills([manual], ask("fix the tone"))).toEqual([]);
    const matches = chooseSkills([manual], ask("fix the tone with $tone"));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchedBy).toBe("explicit");
  });

  it("has an always skill on in every chat", () => {
    expect(names(chooseSkills([skill("policy", "always")], ask("hello")))).toEqual(["policy"]);
  });

  it("puts named skills first and on top of the limit", () => {
    const always = Array.from({ length: 4 }, (_, i) => skill(`a${i}`, "always", 90 - i));
    const named = skill("named", "manual", 1);
    const chosen = chooseSkills([...always, named], ask(undefined, { requested: ["named"] }), 2, 5);
    expect(names(chosen)).toEqual(["named", "a0", "a1"]);
  });

  it("caps the explicit requests", () => {
    const skills = Array.from({ length: 4 }, (_, i) => skill(`s${i}`, "manual"));
    const chosen = chooseSkills(skills, ask(undefined, { requested: skills.map((s) => s.name) }), 3, 2);
    expect(names(chosen)).toEqual(["s0", "s1"]);
  });

  // Ranking (core's test_rank_skills): the old resolver cut to the top three before it dropped the skills that did not apply.
  const plan = skill("test-plan", "auto", 40, { keywords: ["test plan"] });
  const cases = skill("test-cases", "auto", 40, { keywords: ["pytest"] });
  const bugs = skill("bug-triage", "auto", 40, { keywords: ["bug"] });
  const style = skill("qa-style", "always", 10);

  it("does not crowd out an always-on skill with ones that do not apply", () => {
    expect(names(chooseSkills([plan, cases, bugs, style], ask("hello there")))).toEqual(["qa-style"]);
  });

  it("ranks matched skills by score and cuts them at the limit", () => {
    const chosen = chooseSkills([style, plan, cases, bugs], ask("a test plan for the pytest bug"));
    expect(names(chosen)).toEqual(["bug-triage", "test-cases", "test-plan"]);
    expect(chosen.map((m) => m.score)).toEqual([70, 70, 70]);
  });

  it.each([
    ["slide", 1],
    ["a slide and a slide", 1],
    ["slide and deck", 2],
    ["Slide, DECK, and pitch.", 3],
    ["slides", 0],
    ["deck-building", 1],
    ["slide_one", 0],
    ["nodeck", 0],
  ])("adds thirty for each keyword once, as a whole word in any case: %j has %i", (query, keywords) => {
    const chosen = chooseSkills([skill("s", "auto", 20, { keywords: ["slide", "deck", "pitch"] })], ask(query));
    if (keywords === 0) {
      expect(chosen).toEqual([]);
      return;
    }
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.score).toBe(20 + 30 * keywords);
    expect(chosen[0]!.triggerHits).toBe(keywords);
    expect(chosen[0]!.matchedBy).toBe("trigger");
  });

  it("takes a keyword as a phrase and holds no pattern", () => {
    const s = skill("s", "auto", 50, { keywords: ["test plan", "c++", ".*"] });
    expect(chooseSkills([s], ask("a plan for the test"))).toEqual([]);
    expect(chooseSkills([s], ask("Write a TEST PLAN"))).toHaveLength(1);
    expect(chooseSkills([s], ask("port it to c++ today"))).toHaveLength(1);
    expect(chooseSkills([s], ask("anything at all"))).toEqual([]);
  });

  it("adds file types and tags to the score, and a tag alone is a weak match", () => {
    const sheet = skill("sheet", "auto", 10, { fileTypes: [".XLSX", "csv"], tags: ["finance"] });
    const byType = chooseSkills([sheet], ask(undefined, { fileTypes: ["xlsx", ".csv"] }));
    expect(byType).toHaveLength(1);
    expect(byType[0]!.score).toBe(70);
    expect(byType[0]!.triggerHits).toBe(2);
    const byTag = chooseSkills([sheet], ask(undefined, { tags: ["finance"] }));
    expect(byTag).toHaveLength(1);
    expect(byTag[0]!.score).toBe(30);
    expect(byTag[0]!.triggerHits).toBe(0);
    expect(chooseSkills([sheet], ask(undefined, { fileTypes: ["pdf"], tags: ["legal"] }))).toEqual([]);
  });

  it("gives equal scores to the higher priority, then the name", () => {
    const low = skill("alpha", "auto", 40, { keywords: ["x"] });
    const high = skill("zulu", "auto", 41, { keywords: ["x", "y"] });
    const tie = skill("bravo", "auto", 40, { keywords: ["x"] });
    const chosen = chooseSkills([low, tie, high], ask("x"), 5);
    expect(names(chosen)).toEqual(["zulu", "alpha", "bravo"]);
    expect(chosen.map((m) => m.score)).toEqual([71, 70, 70]);
  });

  it("scores a named skill by its priority over a thousand", () => {
    const matches = chooseSkills([skill("review", "auto", 7)], ask("use $Review"));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.score).toBe(1007);
    expect(matches[0]!.matchedBy).toBe("explicit");
  });
});

// The part core does not have: what is listed and what is loaded.
describe("selecting skills", () => {
  it("lists the matches, then the skills that are not filtered, and a skill without faden.yaml is one of them", () => {
    const plain = new SkillCandidate("plain", "No faden.yaml.");
    const open = skill("open", "auto", 80); // a faden.yaml with no triggers
    const slide = skill("slide-design", "auto", 50, { keywords: ["slide"] });
    const manual = skill("manual-one", "manual", 50, { keywords: ["slide"] });
    const all = [plain, slide, manual, open];

    const quiet = selectSkills(all, ask("hello"));
    expect(quiet.listed.map((s) => s.name)).toEqual(["open", "plain"]);
    expect(quiet.matches).toEqual([]);

    const slides = selectSkills(all, ask("a slide please"));
    expect(slides.listed.map((s) => s.name)).toEqual(["slide-design", "open", "plain"]);

    const named = selectSkills(all, ask("use $manual-one"));
    expect(named.listed.map((s) => s.name)).toEqual(["manual-one", "open", "plain"]);
  });

  it("pre-loads a skill without faden.yaml only when the person names it", () => {
    const plain = new SkillCandidate("plain", "No faden.yaml.");
    const unnamed = selectSkills([plain], ask("plain plain plain"));
    expect(unnamed.matches).toEqual([]);
    expect(unnamed.preloaded).toEqual([]);
    // Named by the person ($plain): they asked for it, so it is first in the list and its instructions come with the turn.
    const selection = selectSkills([plain], ask("use $plain"));
    expect(selection.matches).toHaveLength(1);
    expect(selection.preloaded.map((m) => m.skill.name)).toEqual(["plain"]);
    expect(selection.listed.map((s) => s.name)).toEqual(["plain"]);
  });

  it("pre-loads a keyword, a named skill and an always skill, and not a tag", () => {
    const keyword = skill("kw", "auto", 50, { keywords: ["slide"] });
    const tagged = skill("tg", "auto", 50, { tags: ["design"] });
    const always = skill("al", "always", 5);
    const manual = skill("mn", "manual");

    expect(pre([keyword], ask("a slide"))).toEqual(["kw"]);
    expect(pre([manual], ask("$mn"))).toEqual(["mn"]);
    expect(pre([always], ask("hello"))).toEqual(["al"]);
    const weak = selectSkills([tagged], ask(undefined, { tags: ["design"] }));
    expect(weak.matches).toHaveLength(1);
    expect(weak.preloaded).toEqual([]);
  });

  it("pre-loads only the first strong matches up to the limit, in rank order", () => {
    const one = skill("one", "auto", 60, { keywords: ["x"] });
    const two = skill("two", "auto", 50, { keywords: ["x"] });
    const named = skill("named", "manual");
    const all = [one, two, named];

    expect(pre(all, ask("x $named"))).toEqual(["named"]);
    expect(pre(all, ask("x $named"), 2)).toEqual(["named", "one"]);
    expect(pre(all, ask("x"))).toEqual(["one"]);
    expect(pre(all, ask("x"), 0)).toEqual([]);
    expect(pre(all, ask("x"), 5)).toEqual(["one", "two"]);
  });
});

function pre(skills: readonly SkillCandidate[], request: SkillRequest, maxPreloaded = 1): string[] {
  return selectSkills(skills, request, undefined, undefined, maxPreloaded).preloaded.map((m) => m.skill.name);
}
