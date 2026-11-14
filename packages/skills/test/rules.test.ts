import { describe, expect, it } from "vitest";

import { MemorySkillStore, checkSkill, extraFrontmatterKey, type SkillDefinition } from "@fadenstack/skills";

import { Entries, ask, calls, standalone, standard } from "./rig.js";

/** The six-field rule on read (sdk/51 F04, H6): a skill that breaks it is skipped and logged, and its neighbours stay. Port of the .NET `SkillRuleTests`. */
async function offered(...skills: unknown[]): Promise<{ instructions: string; logs: Entries }> {
  const logs = new Entries();
  const rig = standalone({ skills: { bundled: skills as SkillDefinition[] }, logs });
  await ask(rig, "Hi");
  return { instructions: calls(rig.fake)[0]!.instructions ?? "", logs };
}

describe("the six-field rule on read", () => {
  it("offers a skill that follows the rule, with all six fields", async () => {
    const { instructions, logs } = await offered(standard()); // name, description, license, compatibility, metadata and allowed-tools

    expect(instructions).toContain("house-style");
    expect(logs.warnings).toEqual([]);
  });

  it("skips a skill with a key beyond the six and logs it, and keeps the others", async () => {
    const { instructions, logs } = await offered(standard("good-skill"), { ...standard("keyword-skill"), keywords: ["mail", "reply"] });

    expect(instructions).toContain("good-skill");
    expect(instructions).not.toContain("keyword-skill");
    expect(logs.warnings.some((l) => l.message.includes("keyword-skill") && l.message.includes("keywords"))).toBe(true);
  });

  it.each(["Upper-Case", "double--hyphen", "-leading", "trailing-", "under_score", "has space", "dotted.name", ""])(
    "skips a name that is not lowercase letters, digits and single hyphens (%j)", async (name) => {
      const { instructions, logs } = await offered(standard("good-skill"), standard(name));

      expect(instructions).toContain("good-skill");
      if (name) expect(instructions).not.toContain(name);
      expect(logs.warnings).toHaveLength(1);
    });

  it("skips a name over 64 characters and takes one of exactly 64", async () => {
    const { instructions, logs } = await offered(standard("good-skill"), standard("a".repeat(65)));
    expect(instructions).toContain("good-skill");
    expect(instructions).not.toContain("a".repeat(65));
    expect(logs.warnings).toHaveLength(1);

    const exact = await offered(standard("a".repeat(64)));
    expect(exact.instructions).toContain("a".repeat(64));
    expect(exact.logs.warnings).toEqual([]);
  });

  it("skips a description over 1,024 characters and takes one of 1,024", async () => {
    const { instructions, logs } = await offered(standard("long-one", "x".repeat(1025)), standard("just-fits", "y".repeat(1024)));

    expect(instructions).not.toContain("long-one");
    expect(instructions).toContain("just-fits");
    expect(logs.warnings).toHaveLength(1);
  });

  it("skips a skill without a description", async () => {
    const { instructions, logs } = await offered(standard("good-skill"), standard("no-description", "  "));

    expect(instructions).not.toContain("no-description");
    expect(logs.warnings).toHaveLength(1);
  });

  it("skips a compatibility over 500 characters and takes one of 500", async () => {
    const { instructions, logs } = await offered(standard("good-skill"), standard("wordy-skill", "Wordy.", { compatibility: "c".repeat(501) }),
      standard("fits-skill", "Fits.", { compatibility: "c".repeat(500) }));

    expect(instructions).toContain("good-skill");
    expect(instructions).toContain("fits-skill");
    expect(instructions).not.toContain("wordy-skill");
    expect(logs.warnings).toHaveLength(1);
  });

  it("takes the skill's metadata as a map of text to text, and skips another shape", async () => {
    const { instructions, logs } = await offered(standard("nested-ok"), { ...standard("bad-metadata"), metadata: { author: { name: "x" } } },
      { ...standard("bad-license"), license: 5 });

    expect(instructions).toContain("nested-ok");
    expect(instructions).not.toContain("bad-metadata");
    expect(instructions).not.toContain("bad-license");
    expect(logs.warnings).toHaveLength(2);
  });

  it("skips what is no skill record at all", async () => {
    const { instructions, logs } = await offered(standard("good-skill"), null, 5, "text", [], { name: "no-body", description: "Has no body." });

    expect(instructions).toContain("good-skill");
    expect(instructions).not.toContain("no-body");
    expect(logs.warnings).toHaveLength(5);
  });

  it("skips a skill with a resource that names a place outside the skill", async () => {
    const { instructions } = await offered(standard("good-skill"), standard("escaper", "Escapes.", { resources: { "../up.md": "x" } }),
      standard("absolute", "Absolute.", { resources: { "/etc/passwd": "x" } }), standard("backslash", "Backslash.", { resources: { "a\\b.md": "x" } }));

    expect(instructions).toContain("good-skill");
    for (const name of ["escaper", "absolute", "backslash"]) expect(instructions).not.toContain(name);
  });

  it("skips what the person's store holds that breaks the rule, and keeps their other skills", async () => {
    const store = new MemorySkillStore();
    await store.add(standard("kept-skill"));
    const logs = new Entries();
    // A row another script wrote straight into the database: the store itself would have refused it.
    const rows = [standard("kept-skill"), { ...standard("planted"), extra: true }];
    store.list = async () => structuredClone(rows) as SkillDefinition[];
    const rig = standalone({ skills: { store }, logs });

    await ask(rig, "Hi");

    const instructions = calls(rig.fake)[0]!.instructions!;
    expect(instructions).toContain("kept-skill");
    expect(instructions).not.toContain("planted");
    expect(logs.warnings.some((l) => l.message.includes("planted"))).toBe(true);
  });

});

describe("checkSkill", () => {
  it("gives the reason, and nothing for a skill", () => {
    expect(checkSkill(standard())).toBeUndefined();
    expect(checkSkill({ ...standard(), extra: 1 })).toContain("(extra)");
    expect(checkSkill(standard("name"), "other")).toContain("kept under");
    expect(checkSkill({ ...standard(), extra: 1 }, "house-style")).toContain("(extra)");
    expect(checkSkill({ ...standard(), ["k".repeat(100)]: 1 })).toContain(`(${"k".repeat(40)})`); // a long key is cut in the log
  });
});

describe("extraFrontmatterKey", () => {
  const md = (front: string) => `---\n${front}---\n# Body\n`;

  it("finds the first key beyond the six", () => {
    expect(extraFrontmatterKey(md("name: a\ndescription: b\nkeywords: [x]\n"))).toBe("keywords");
    expect(extraFrontmatterKey(md("name: a\n\"quoted\": 1\n"))).toBe("quoted");
    expect(extraFrontmatterKey(md("name: a\nAllowed-Tools: x\n"))).toBe("Allowed-Tools");
  });

  it("takes the six, nested keys, list items and comments", () => {
    expect(extraFrontmatterKey(md("name: a\ndescription: b\nlicense: MIT\ncompatibility: any\nmetadata:\n  author: me\n  other: 1\nallowed-tools: read_page\n# a comment\n"))).toBeUndefined();
    expect(extraFrontmatterKey(md("name: a\nmetadata:\n  - one\n  - two\n"))).toBeUndefined();
  });

  it("reads Windows line ends, a leading blank line, and stops at the closing line", () => {
    expect(extraFrontmatterKey("\r\n---\r\nname: a\r\nextra: 1\r\n---\r\n")).toBe("extra");
    expect(extraFrontmatterKey("---\nname: a\n---\nlater: 1\n")).toBeUndefined();
  });

  it("finds nothing in a text without frontmatter or with an unclosed one", () => {
    expect(extraFrontmatterKey("# Just a body\nkey: value\n")).toBeUndefined();
    expect(extraFrontmatterKey("")).toBeUndefined();
    expect(extraFrontmatterKey("---\nname: a\n")).toBeUndefined();
  });

  it("cuts a long key at 40 characters", () => {
    expect(extraFrontmatterKey(md(`${"k".repeat(60)}: 1\n`))).toBe("k".repeat(40));
  });
});
