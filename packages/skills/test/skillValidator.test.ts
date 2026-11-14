import { describe, expect, it } from "vitest";

import {
  SkillIssueCode,
  SkillLimits,
  SkillSeverity,
  parseSkillMarkdown,
  slugifySkillName,
  writeExtensionYaml,
  writeSkillMarkdown,
  type SkillCheck,
  type SkillDocument,
} from "@fadenstack/agents";

import { binaryFile, doc, fields, textFile, workshopRig } from "./workshopRig.js";

/** The checks before saving: one validator for the editor, the import and the draft, one test per rule. Port of the .NET `SkillValidatorTests`. */
const { workshop } = workshopRig();
const good = (): SkillDocument => doc();
const check = (document: SkillDocument, folder?: string): SkillCheck => workshop.check(document, folder);
const codes = (c: SkillCheck) => c.issues.map((i) => i.code);
const hide = (codePoint: number): string => String.fromCodePoint(codePoint);
const changed = (more: Partial<SkillDocument>): SkillDocument => ({ ...good(), ...more });

describe("the validator", () => {
  it("passes a good skill without a finding", () => {
    const result = check(good(), "contract-review");

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it.each([
    ["", SkillIssueCode.NameMissing],
    ["Contract-Review", SkillIssueCode.NameForm],
    ["contract review", SkillIssueCode.NameForm],
    ["contract--review", SkillIssueCode.NameForm],
    ["-contract", SkillIssueCode.NameForm],
    ["contract-", SkillIssueCode.NameForm],
    ["contract_review", SkillIssueCode.NameForm],
    ["vertragspr\u00fcfung", SkillIssueCode.NameForm],
  ])("wants the name as lower case words with single hyphens: %j", (name, expected) => {
    const result = check(changed({ name }));

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(expected);
  });

  it("keeps the name to 64 characters", () => {
    expect(check(changed({ name: "a".repeat(64) })).ok).toBe(true);

    const long = check(changed({ name: "a".repeat(65) }));

    expect(long.issues.some((i) => i.code === SkillIssueCode.NameTooLong && i.limit === 64 && i.actual === 65)).toBe(true);
  });

  it("wants the name to be the one the skill is kept under", () => {
    const result = check(good(), "other-name");

    expect(result.issues.some((i) => i.code === SkillIssueCode.NameNotFolder && i.detail === "other-name")).toBe(true);
    expect(check(good(), "contract-review").ok).toBe(true);
  });

  it("takes a bundled skill's name", () => {
    expect(codes(check(changed({ name: "slide-design" })))).toContain(SkillIssueCode.NameReserved);
  });

  it("needs a description of at most 1024 characters", () => {
    expect(codes(check(changed({ description: "  " })))).toContain(SkillIssueCode.DescriptionMissing);
    expect(check(changed({ description: "d".repeat(1024) })).ok).toBe(true);
    expect(check(changed({ description: "d".repeat(1025) })).issues.some((i) => i.code === SkillIssueCode.DescriptionTooLong && i.limit === 1024 && i.actual === 1025)).toBe(true);
  });

  it("keeps the compatibility note to 500 characters", () => {
    expect(check(changed({ compatibility: "c".repeat(500) })).ok).toBe(true);
    expect(codes(check(changed({ compatibility: "c".repeat(501) })))).toContain(SkillIssueCode.CompatibilityTooLong);
  });

  it("refuses a key beyond the six standard fields, naming each", () => {
    const result = check(changed({ unknownKeys: ["version", "triggers"] }));

    expect(result.ok).toBe(false);
    expect(result.issues.filter((i) => i.code === SkillIssueCode.UnknownKey).map((i) => i.detail)).toEqual(["version", "triggers"]);
  });

  it.each([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x00ad, 0xe0041])(
    "refuses an invisible character wherever it hides: U+%s",
    (codePoint) => {
      const hidden = hide(codePoint);
      const documents = [
        changed({ description: `Reviews${hidden} contracts.` }),
        changed({ instructions: `Read${hidden} the clause.` }),
        changed({ license: `MIT${hidden}` }),
        changed({ compatibility: `any${hidden}` }),
        changed({ metadata: { a: `b${hidden}` } }),
        changed({ allowedTools: `read_page${hidden}` }),
        changed({ resources: [textFile("references/a.md", `Fine${hidden} text.`)] }),
      ];
      const detail = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

      for (const document of documents) {
        const result = check(document);

        expect(result.ok).toBe(false);
        expect(result.issues.some((i) => i.code === SkillIssueCode.InvisibleCharacter && i.detail === detail)).toBe(true);
      }
    },
  );

  it("takes a leading byte order mark in a resource's text as an encoding signature, not hidden text", () => {
    expect(check(changed({ resources: [textFile("references/a.md", `${hide(0xfeff)}Fine.`)] })).ok).toBe(true);
  });

  it.each([0x00, 0x07, 0x1b, 0x7f, 0x85])("refuses a control character: U+%s", (codePoint) => {
    expect(codes(check(changed({ instructions: `Read${hide(codePoint)}this.` })))).toContain(SkillIssueCode.ControlCharacter);
  });

  it("lets tab and line breaks stand in the instructions", () => {
    expect(check(changed({ instructions: "a\tb\r\nc\nd" })).ok).toBe(true);
  });

  it("warns for a long body and for an empty one, and refuses neither", () => {
    const long = check(changed({ instructions: "x".repeat(5001 * 4) }));
    const empty = check(changed({ instructions: "" }));

    expect(long.ok).toBe(true);
    expect(long.issues.some((i) => i.code === SkillIssueCode.BodyLarge && i.severity === SkillSeverity.Warning && i.limit === 5000)).toBe(true);
    expect(empty.ok).toBe(true);
    expect(codes(empty)).toContain(SkillIssueCode.BodyEmpty);
    expect(check(changed({ instructions: "x".repeat(5000 * 4) })).issues).toEqual([]);
  });

  it("refuses a file over 1 MiB, a total over 5 MiB and more than 100 files", () => {
    const big = textFile("references/big.md", "a".repeat(SkillLimits.fileMaxBytes + 1));
    const many = Array.from({ length: 100 }, (_, i) => textFile(`references/f${i}.md`, "x"));
    const heavy = Array.from({ length: 6 }, (_, i) => textFile(`references/b${i}.md`, "a".repeat(SkillLimits.fileMaxBytes)));

    expect(check(changed({ resources: [big] })).issues.some((i) => i.code === SkillIssueCode.FileTooLarge && i.subject === "references/big.md")).toBe(true);
    expect(codes(check(changed({ resources: many })))).toContain(SkillIssueCode.TooManyFiles); // 100 resources + SKILL.md = 101
    expect(codes(check(changed({ resources: heavy })))).toContain(SkillIssueCode.TotalTooLarge);
    expect(check(changed({ resources: many.slice(0, 98) })).ok).toBe(true);
  });

  it("refuses a resource that is not text, with BinaryFile", () => {
    const result = check(changed({ resources: [binaryFile("assets/pic.bin", [1, 2, 3, 0, 255]), textFile("references/ok.md", "Fine.")] }));

    expect(result.ok).toBe(false);
    expect(result.issues.filter((i) => i.code === SkillIssueCode.BinaryFile).map((i) => i.subject)).toEqual(["assets/pic.bin"]);
    expect(check(changed({ resources: [binaryFile("assets/bad-utf8.md", [0xc3, 0x28])] })).issues.some((i) => i.code === SkillIssueCode.BinaryFile)).toBe(true);
  });

  it.each(["scripts/run.py", "scripts/notes.txt", "helper.ps1", "tools/build.sh", "setup.exe", "lib/native.dll", "check.bat", "hook.js"])(
    "does not keep a script or a program as runnable: %s",
    (path) => {
      const result = check(changed({ resources: [textFile(path, "echo hi")] }));

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === SkillIssueCode.ScriptFile && i.subject === path)).toBe(true);
    },
  );

  it.each(["../evil.md", "a/../../evil.md", "/etc/passwd", "C:/windows/x.md", "C:\\windows\\x.md", "C:x.md", "a\\b.md", "a//b.md", "./a.md", "a/", "SKILL.md", "faden.yaml", "CON:.md", "a/b./c.md"])(
    "refuses an unsafe resource path: %j",
    (path) => {
      const result = check(changed({ resources: [textFile(path, "x")] }));

      expect(result.ok).toBe(false);
      expect(codes(result)).toContain(SkillIssueCode.UnsafePath);
    },
  );

  it("refuses two files of one name, whatever the case", () => {
    const result = check(changed({ resources: [textFile("references/A.md", "1"), textFile("references/a.md", "2")] }));

    expect(codes(result)).toContain(SkillIssueCode.DuplicatePath);
  });

  it("wants the faden.yaml fields to read with the module's own reader", () => {
    expect(check(changed({ extension: fields({ keywords: ["contract"], priority: 100, activation: "manual" }) })).ok).toBe(true);

    expect(codes(check(changed({ extension: fields({ priority: 101 }) })))).toContain(SkillIssueCode.FadenYamlUnreadable);
    expect(codes(check(changed({ extension: fields({ activation: "sometimes" }) })))).toContain(SkillIssueCode.FadenYamlUnreadable);
    expect(codes(check(changed({ extension: fields({ keywords: ["k".repeat(101)] }) })))).toContain(SkillIssueCode.FadenYamlUnreadable);
    expect(codes(check(changed({ extension: fields({ keywords: [`a${hide(0x200b)}`] }) })))).toContain(SkillIssueCode.InvisibleCharacter);
  });

  it("warns for a faden.yaml field the editor does not keep, and does not refuse", () => {
    const result = check(changed({ extension: fields({ unknownKeys: ["mystery"], keywords: ["a"] }) }));

    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.code === SkillIssueCode.FadenYamlUnknownKey && i.detail === "mystery" && i.severity === SkillSeverity.Warning)).toBe(true);
  });
});

describe("the faden.yaml fields", () => {
  it("survive writing and reading, awkward text included", () => {
    const original = fields({
      title: "Contract: review # 1",
      tags: ["legal", "yes"],
      priority: 61,
      activation: "always",
      keywords: ["clause", "Vertragspr\u00fcfung", 'say "hi"', "it's", "a: b", "true", "123", "c:\\x"],
      fileTypes: [".docx", "pdf"],
      preferredTools: ["read_page", "search.web"],
      allowedTools: ["x"],
      forbiddenTools: ["y"],
      knowledgeSources: ["z"],
    });
    const yaml = writeExtensionYaml(original)!;

    const parsed = workshop.parseExtension(yaml);

    expect(parsed.fields).toBeDefined();
    const back = parsed.fields!;
    expect(back.title).toBe(original.title);
    expect(back.tags).toEqual(original.tags);
    expect(back.keywords).toEqual(original.keywords);
    expect(back.fileTypes).toEqual(original.fileTypes);
    expect(back.preferredTools).toEqual(original.preferredTools);
    expect([back.priority, back.activation]).toEqual([61, "always"]);
    expect(back.allowedTools).toEqual(["x"]);
    expect(back.forbiddenTools).toEqual(["y"]);
    expect(back.knowledgeSources).toEqual(["z"]);
    expect(parsed.issues).toEqual([]);
  });

  it("come back as an error when they do not read, and an unknown field as a warning", () => {
    const bad = workshop.parseExtension("priority: 500\n");
    const anchors = workshop.parseExtension("a: &x 1\nb: *x\n");
    const extra = workshop.parseExtension("title: T\nmystery: 1\ntrigger_rules:\n  keywords: [a]\n  intents: [b]\n");

    expect(bad.fields).toBeUndefined();
    expect(bad.issues.some((i) => i.code === SkillIssueCode.FadenYamlUnreadable && i.isError)).toBe(true);
    expect(anchors.fields).toBeUndefined();
    expect(extra.fields).toBeDefined();
    expect(extra.fields!.unknownKeys).toEqual(["mystery", "trigger_rules.intents"]);
    expect(extra.issues.length).toBeGreaterThan(0);
    expect(extra.issues.every((i) => i.severity === SkillSeverity.Warning)).toBe(true);
  });
});

describe("SKILL.md", () => {
  it("round trips and reads loose forms", () => {
    const document = changed({ license: "MIT", compatibility: "needs: nothing", metadata: { a: "b: c" }, allowedTools: "read_page" });

    const parsed = parseSkillMarkdown(writeSkillMarkdown(document));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const back = parsed.document;
    expect([back.name, back.description, back.license, back.compatibility, back.allowedTools]).toEqual([document.name, document.description, "MIT", "needs: nothing", "read_page"]);
    expect(back.metadata["a"]).toBe("b: c");
    expect(back.instructions.trim()).toBe(document.instructions.trim());

    const loose = parseSkillMarkdown("\r\n---\r\nname: a-b\r\ndescription: >\r\n  Folded text\r\n  over lines.\r\nallowed-tools:\r\n  - read_page\r\n  - find_tool\r\nextra: 1\r\n---\r\nBody\r\n");
    expect(loose.ok).toBe(true);
    if (!loose.ok) return;
    expect([loose.document.name, loose.document.description, loose.document.allowedTools, loose.document.instructions.trim()]).toEqual(["a-b", "Folded text over lines.", "read_page find_tool", "Body"]);
    expect(loose.document.unknownKeys).toEqual(["extra"]);

    expect(parseSkillMarkdown("# no frontmatter").ok).toBe(false);
    expect(parseSkillMarkdown("---\nname: a\n").ok).toBe(false);
    expect(parseSkillMarkdown("---\nname: a\nname: b\n---\n").ok).toBe(false);
    expect(parseSkillMarkdown('---\nname: "unclosed\n---\n').ok).toBe(false);
  });

  it.each([
    ["SQL Review", "sql-review"],
    ["  Code  Review!! ", "code-review"],
    ["\u00dcberpr\u00fcfung", "berpr-fung"],
    ["!!!", "new-skill"],
    ["", "new-skill"],
  ])("makes a name from any text as core does: %j", (input, expected) => {
    expect(slugifySkillName(input)).toBe(expected);
  });

  it("cuts a slug at 64 characters without a trailing hyphen", () => {
    const slug = slugifySkillName(`${"a".repeat(63)} b`);

    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("keeps the six fields only when it writes a skill", () => {
    const text = writeSkillMarkdown(changed({ extension: fields({ keywords: ["clause"], title: "Contract review" }) }));

    expect(text.startsWith("---\nname: contract-review\ndescription: ")).toBe(true);
    expect(text).not.toContain("keywords");
    expect(text).not.toContain("title");
  });
});
