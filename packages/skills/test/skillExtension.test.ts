import { describe, expect, it } from "vitest";

import { FadenYamlError, SkillExtension } from "@fadenstack/skills";

import { slideDesignYaml } from "./rig.js";
import { MAX_KEYWORDS, MAX_KEYWORD_LENGTH } from "../src/skillExtension.js";

/** What `faden.yaml` may say, by the rules of core's `bundle.py` (`split_extension`, `normalize_manifest`). Port of the .NET `SkillExtensionTests`. */
describe("a skill's faden.yaml", () => {
  it("reads the Office agent's slide-design file", () => {
    const e = SkillExtension.parse(slideDesignYaml());

    expect(e.title).toBe("Slide design");
    expect(e.tags).toEqual(["powerpoint", "presentations", "design"]);
    expect(e.activation).toBe("auto");
    expect(e.priority).toBe(60);
    expect(e.keywords).toEqual(["slide", "slides", "presentation", "deck", "powerpoint", "pitch"]);
    expect(e.preferredTools).toEqual(["get_design", "add_slide", "check_slide", "render_slide"]);
  });

  it("gives the defaults for an empty file and for a file without the fields", () => {
    for (const text of ["", "# nothing\n", "unknown_field: 1\n", "preferred_tools:\ntrigger_rules: {}\ntags: []\n"]) {
      const e = SkillExtension.parse(text);
      expect(e.priority).toBe(50);
      expect(e.activation).toBe("auto");
      expect(e.keywords).toEqual([]);
      expect(e.preferredTools).toEqual([]);
    }
  });

  it("splits a string where a list goes at commas and white space, as core does", () => {
    const e = SkillExtension.parse("preferred_tools: get_design, add_slide render_slide\ntrigger_rules:\n  keywords: slide, deck\n");

    expect(e.preferredTools).toEqual(["get_design", "add_slide", "render_slide"]);
    expect(e.keywords).toEqual(["slide", "deck"]);
  });

  it.each([
    "priority: 101",
    "priority: -1",
    "priority: high",
    "priority: true",
    "priority: 1.5",
    "activation: sometimes",
    "activation: true",
    "preferred_tools: [a, [b]]",
    "preferred_tools: 5",
    "tags: {a: b}",
    "trigger_rules: [slide]",
    "trigger_rules:\n  keywords: [yes]",
    "allowed_tools: [1]",
    "- just\n- a list\n",
    "just text\n",
    "a: &x 1\nb: *x\n",
  ])("refuses the whole file for a field of the wrong type: %j", (text) => {
    expect(() => SkillExtension.parse(text)).toThrow(FadenYamlError);
  });

  it("checks allowed, forbidden and knowledge fields and never uses them", () => {
    const e = SkillExtension.parse("allowed_tools: [read_page]\nforbidden_tools: [send_mail]\nknowledge_sources: [wiki]\nactivation: manual\n");

    expect(e.activation).toBe("manual");
    expect(e.preferredTools).toEqual([]); // nothing of the three reaches anything that decides a tool
  });

  it("limits the keywords in number and length", () => {
    const many = `trigger_rules:\n  keywords: [${Array.from({ length: MAX_KEYWORDS + 1 }, (_, i) => `k${i}`).join(",")}]\n`;
    expect(() => SkillExtension.parse(many)).toThrow(FadenYamlError);
    const long = `trigger_rules:\n  keywords: [${"k".repeat(MAX_KEYWORD_LENGTH + 1)}]\n`;
    expect(() => SkillExtension.parse(long)).toThrow(FadenYamlError);
    expect(SkillExtension.parse(many.replace(`,k${MAX_KEYWORDS}`, "")).keywords).toHaveLength(MAX_KEYWORDS);
  });

  it("cuts the title at 255 characters", () => {
    expect(SkillExtension.parse(`title: ${"t".repeat(400)}\n`).title).toHaveLength(255);
  });

  it("reads a keyword as text, never as a pattern", () => {
    const e = SkillExtension.parse('trigger_rules:\n  keywords: ["c++", ".*", "(a+)+$", "[x"]\n');

    expect(e.keywordMatchers).toHaveLength(4);
    expect(e.keywordMatchers[0]!.test("port it to c++ today")).toBe(true);
    expect(e.keywordMatchers[1]!.test("anything at all")).toBe(false);
    expect(e.keywordMatchers[2]!.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).toBe(false);
    expect(e.keywordMatchers[3]!.test("a [x here")).toBe(true);
  });

  it("matches a keyword as a whole word in any case, with letters beyond ASCII as word characters", () => {
    const e = SkillExtension.parse("trigger_rules:\n  keywords: [slide, übung]\n");
    const [slide, practice] = e.keywordMatchers;

    expect(slide!.test("A SLIDE.")).toBe(true);
    expect(slide!.test("slides")).toBe(false);
    expect(slide!.test("slide_one")).toBe(false);
    expect(slide!.test("deck-slide")).toBe(true);
    expect(practice!.test("Eine ÜBUNG heute")).toBe(true);
    expect(practice!.test("dieübung")).toBe(false);
  });
});
