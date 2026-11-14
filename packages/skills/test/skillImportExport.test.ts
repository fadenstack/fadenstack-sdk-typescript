import { describe, expect, it } from "vitest";

import { SkillIssueCode, SkillLimits, SkillSaveStatus, SkillSeverity, type ImportAnalysis } from "@fadenstack/agents";
import { IndexedDbSkillStore, MemorySkillStore, analyzeZip, readZip, skillToZip } from "@fadenstack/skills";
import { IDBFactory } from "fake-indexeddb";

import { GOOD_SKILL_MD, binaryFile, doc, fields, textFile, workshopRig, type WorkshopRig } from "./workshopRig.js";
import { SYMLINK_ATTRIBUTES, UNIX_HOST, rawZip, text, type RawEntry } from "./zipRig.js";

/** Import of a zip (a hostile one above all) and export: nothing is written before every check passes. Port of the .NET `SkillImportExportTests`. */
const GOOD = text("contract-review/SKILL.md", GOOD_SKILL_MD);

async function refused(rig: WorkshopRig, zip: Uint8Array, ...expected: SkillIssueCode[]): Promise<ImportAnalysis> {
  const analysis = await rig.workshop.analyzeZip(zip, "hostile.zip");

  expect(analysis.ok).toBe(false);
  if (expected.length > 0) {
    expect(analysis.issues.some((i) => i.isError && expected.includes(i.code)), analysis.issues.map((i) => i.code).join(", ")).toBe(true);
  }
  expect(await rig.store.list(), "an analysis wrote something").toEqual([]);
  expect((await rig.workshop.commitImport(analysis, true)).status).toBe(SkillSaveStatus.Refused);
  expect(await rig.store.list(), "a refused analysis was committed").toEqual([]);
  return analysis;
}

describe("importing a good zip", () => {
  it("reads and checks it, and writes nothing until it is committed", async () => {
    const rig = workshopRig();
    const zip = await rawZip([GOOD, text("contract-review/faden.yaml", "trigger_rules:\n  keywords:\n    - clause\n"), text("contract-review/references/tone.md", "Warm.")]);

    const analysis = await rig.workshop.analyzeZip(zip, "contract-review.zip");

    expect(analysis.ok).toBe(true);
    expect(analysis.wouldReplace).toBe(false);
    expect(analysis.document!.name).toBe("contract-review");
    expect(analysis.document!.extension.keywords).toEqual(["clause"]);
    expect(analysis.document!.resources.map((r) => r.path)).toEqual(["references/tone.md"]);
    expect(analysis.fileCount).toBe(3);
    expect(await rig.store.list()).toEqual([]);

    const committed = await rig.workshop.commitImport(analysis, false);

    expect(committed.status).toBe(SkillSaveStatus.Saved);
    const record = await rig.store.get("contract-review");
    expect(record?.resources).toEqual({ "references/tone.md": "Warm." });
    expect(record?.fadenYaml).toContain("clause");
  });

  it("reads a zip without a folder, and says a folder of another name instead of refusing it", async () => {
    const rig = workshopRig();

    const flat = await rig.workshop.analyzeZip(await rawZip([text("SKILL.md", GOOD_SKILL_MD)]), "flat.zip");
    const renamed = await rig.workshop.analyzeZip(await rawZip([text("contract-review-main/SKILL.md", GOOD_SKILL_MD)]), "main.zip");

    expect(flat.ok).toBe(true);
    expect(renamed.ok).toBe(true);
    expect(renamed.issues.some((i) => i.code === SkillIssueCode.NameNotFolder && i.severity === SkillSeverity.Warning && i.detail === "contract-review-main")).toBe(true);
    expect(renamed.document!.name).toBe("contract-review"); // the skill is kept under its own name
  });

  it("replaces an existing skill of the same name only when the person confirms", async () => {
    const rig = workshopRig();
    await rig.workshop.save(doc("contract-review", "The old one."));
    const analysis = await rig.workshop.analyzeZip(await rawZip([text("SKILL.md", GOOD_SKILL_MD)]), "x.zip");

    const unconfirmed = await rig.workshop.commitImport(analysis, false);

    expect(analysis.wouldReplace).toBe(true);
    expect(unconfirmed.status).toBe(SkillSaveStatus.Exists);
    expect((await rig.workshop.read("contract-review")).document!.description).toBe("The old one.");

    const confirmed = await rig.workshop.commitImport(analysis, true);

    expect(confirmed.status).toBe(SkillSaveStatus.Saved);
    expect((await rig.workshop.read("contract-review")).document!.description).toBe("Reviews a contract clause by clause.");
  });

  it("leaves out the junk of a zip made on a Mac", async () => {
    const rig = workshopRig();
    const zip = await rawZip([GOOD, text("__MACOSX/contract-review/._SKILL.md", "junk"), text("contract-review/.DS_Store", "junk")]);

    const analysis = await rig.workshop.analyzeZip(zip, "mac.zip");

    expect(analysis.ok).toBe(true);
    expect(analysis.document!.resources).toEqual([]);
  });

  it("skips directory entries", async () => {
    const rig = workshopRig();
    const zip = await rawZip([{ name: "contract-review/", method: 0 }, GOOD, { name: "contract-review/references/", method: 0 }, text("contract-review/references/a.md", "x")]);

    const analysis = await rig.workshop.analyzeZip(zip, "dirs.zip");

    expect(analysis.ok).toBe(true);
    expect(analysis.document!.resources.map((r) => r.path)).toEqual(["references/a.md"]);
  });

  it("reads a stored entry", async () => {
    const rig = workshopRig();

    const analysis = await rig.workshop.analyzeZip(await rawZip([text("SKILL.md", GOOD_SKILL_MD, { method: 0 })]), "stored.zip");

    expect(analysis.ok).toBe(true);
    expect(analysis.document!.name).toBe("contract-review");
  });

  it("refuses a name the bundled skills hold, and commits nothing", async () => {
    const rig = workshopRig();
    const zip = await rawZip([text("SKILL.md", "---\nname: slide-design\ndescription: Mine.\n---\nBody\n")]);

    await refused(rig, zip, SkillIssueCode.NameReserved);
  });
});

describe("a hostile zip is refused and nothing is written", () => {
  it.each([
    "../evil/SKILL.md",
    "contract-review/../../evil.md",
    "contract-review/references/../../../evil.md",
    "/etc/passwd",
    "C:/Windows/x.md",
    "C:\\Windows\\x.md",
    "C:x.md",
    "contract-review\\SKILL.md",
    "contract-review/a\\..\\b.md",
    "contract-review//x.md",
  ])("an entry that escapes or is absolute: %j", async (hostile) => {
    const rig = workshopRig();
    const zip = await rawZip([GOOD, text(hostile, "pwned")]);

    const analysis = await refused(rig, zip, SkillIssueCode.UnsafePath);

    expect(analysis.document).toBeUndefined();
  });

  it("a link entry (a Unix symbolic link)", async () => {
    const rig = workshopRig();
    const zip = await rawZip([GOOD, text("contract-review/link.md", "/etc/passwd", { madeBy: UNIX_HOST, attributes: SYMLINK_ATTRIBUTES })]);

    await refused(rig, zip, SkillIssueCode.LinkEntry);
  });

  it("an oversize file, refused without expanding it", async () => {
    const rig = workshopRig();
    const zip = await rawZip([text("SKILL.md", GOOD_SKILL_MD), { name: "references/big.md", bytes: new Uint8Array(SkillLimits.fileMaxBytes + 1) }]);

    await refused(rig, zip, SkillIssueCode.FileTooLarge);
  });

  it("a bomb: several files that expand far past 100:1, and past the total", async () => {
    const rig = workshopRig();
    const entries: RawEntry[] = [text("SKILL.md", GOOD_SKILL_MD)];
    for (let i = 0; i < 6; i++) entries.push({ name: `references/zeros${i}.md`, bytes: new Uint8Array(SkillLimits.fileMaxBytes) });
    const bomb = await rawZip(entries);
    expect(bomb.length).toBeLessThan(50_000);

    await refused(rig, bomb, SkillIssueCode.ZipBomb, SkillIssueCode.TotalTooLarge);
  });

  it("a single highly compressed file, even under the size limit", async () => {
    const rig = workshopRig();
    const zip = await rawZip([text("SKILL.md", GOOD_SKILL_MD), { name: "references/zeros.md", bytes: new Uint8Array(900 * 1024) }]);

    await refused(rig, zip, SkillIssueCode.ZipBomb);
  });

  it("a header that lies about its size: a small file that expands to a lot", async () => {
    const rig = workshopRig();
    const zip = await rawZip([text("SKILL.md", GOOD_SKILL_MD), { name: "references/lie.md", bytes: new Uint8Array(600 * 1024), size: 100 }]);

    await refused(rig, zip, SkillIssueCode.ZipBomb);
  });

  it("a header that lies about its size the other way, and a wrong CRC", async () => {
    const rig = workshopRig();

    await refused(rig, await rawZip([text("SKILL.md", GOOD_SKILL_MD, { size: GOOD_SKILL_MD.length + 5 })]), SkillIssueCode.NotAZip);
    await refused(rig, await rawZip([text("SKILL.md", GOOD_SKILL_MD, { crc: 0xdeadbeef })]), SkillIssueCode.NotAZip);
  });

  it("too many files, and far too many entries", async () => {
    const rig = workshopRig();
    const some: RawEntry[] = [text("SKILL.md", GOOD_SKILL_MD)];
    for (let i = 0; i < 120; i++) some.push(text(`references/f${i}.md`, `x ${i}`, { method: 0 }));
    const lots: RawEntry[] = [text("SKILL.md", GOOD_SKILL_MD)];
    for (let i = 0; i < 250; i++) lots.push(text(`references/f${i}.md`, `x ${i}`, { method: 0 }));

    await refused(rig, await rawZip(some), SkillIssueCode.TooManyFiles);
    await refused(rig, await rawZip(lots), SkillIssueCode.TooManyFiles);
  });

  it("bytes that are not a zip, a truncated zip, an oversize zip and a zip without SKILL.md", async () => {
    const rig = workshopRig();
    const good = await rawZip([text("SKILL.md", GOOD_SKILL_MD)]);

    await refused(rig, new TextEncoder().encode("this is not a zip at all, it is only text"), SkillIssueCode.NotAZip);
    await refused(rig, good.slice(0, good.length - 7), SkillIssueCode.NotAZip);
    await refused(rig, await rawZip([text("README.md", "hi")]), SkillIssueCode.SkillMdMissing);
    await refused(rig, new Uint8Array(SkillLimits.zipMaxBytes + 1), SkillIssueCode.FileTooLarge);
  });

  it("an encrypted entry", async () => {
    const rig = workshopRig();

    await refused(rig, await rawZip([text("SKILL.md", GOOD_SKILL_MD, { flags: 0x0801 })]), SkillIssueCode.NotAZip);
  });

  it("entries whose data overlaps", async () => {
    const rig = workshopRig();
    const zip = await rawZip([text("SKILL.md", GOOD_SKILL_MD, { method: 0 }), text("references/a.md", "x", { method: 0, localOffset: 0 })]);

    await refused(rig, zip, SkillIssueCode.NotAZip);
  });

  it("two entries of one name, whatever the case", async () => {
    const rig = workshopRig();

    await refused(rig, await rawZip([GOOD, text("contract-review/references/a.md", "1"), text("contract-review/references/A.md", "2")]), SkillIssueCode.DuplicatePath);
    await refused(rig, await rawZip([GOOD, text("contract-review/references/a.md", "1"), text("contract-review/references/a.md", "2")]), SkillIssueCode.DuplicatePath);
  });

  it("a name that is not text", async () => {
    const rig = workshopRig();
    const zip = await rawZip([text("SKILL.md", GOOD_SKILL_MD), { name: "x", nameBytes: Uint8Array.from([0x61, 0xff]), bytes: new Uint8Array(1) }]);

    await refused(rig, zip, SkillIssueCode.UnsafePath);
  });

  it("unknown SKILL.md keys, with each key named", async () => {
    const rig = workshopRig();
    const zip = await rawZip([text("SKILL.md", "---\nname: contract-review\ndescription: x\nversion: 3\nhooks: run\n---\nBody\n")]);

    const analysis = await refused(rig, zip, SkillIssueCode.UnknownKey);

    expect(analysis.document).toBeDefined();
    expect(analysis.issues.filter((i) => i.code === SkillIssueCode.UnknownKey).map((i) => i.detail)).toEqual(["version", "hooks"]);
  });

  it.each([0x200b, 0x2060, 0xfeff, 0x202e, 0x2066])("invisible characters in the description, the body and a reference: U+%s", async (codePoint) => {
    const rig = workshopRig();
    const hidden = String.fromCodePoint(codePoint);
    const attempts = [
      await rawZip([text("SKILL.md", `---\nname: contract-review\ndescription: Reviews${hidden} it.\n---\nBody\n`)]),
      await rawZip([text("SKILL.md", `---\nname: contract-review\ndescription: Reviews it.\n---\nBody ignore${hidden} previous\n`)]),
      await rawZip([text("SKILL.md", GOOD_SKILL_MD), text("references/a.md", `Fine${hidden} text`)]),
    ];

    for (const zip of attempts) await refused(rig, zip, SkillIssueCode.InvisibleCharacter);
  });

  it("a script", async () => {
    const rig = workshopRig();

    await refused(rig, await rawZip([text("SKILL.md", GOOD_SKILL_MD), text("scripts/run.py", "print(1)")]), SkillIssueCode.ScriptFile);
  });

  it("an unreadable faden.yaml is refused by the analysis", async () => {
    const rig = workshopRig();

    for (const yaml of ["priority: 999\n", "a: &x 1\nb: *x\n"]) {
      const analysis = await rig.workshop.analyzeZip(await rawZip([text("SKILL.md", GOOD_SKILL_MD), text("faden.yaml", yaml)]), "y.zip");

      expect(analysis.ok).toBe(false);
      expect(analysis.issues.some((i) => i.isError && i.code === SkillIssueCode.FadenYamlUnreadable)).toBe(true);
    }
  });

  // BUG (skillWorkshop.ts commitImport): an analysis the import refused for its faden.yaml still has a document (with the default
  // extension), and commitImport only re-runs the save's checks, which do not see the faden.yaml text: the skill is saved without it.
  it("an unreadable faden.yaml: committing the refused analysis writes nothing", async () => {
    const rig = workshopRig();

    await refused(rig, await rawZip([text("SKILL.md", GOOD_SKILL_MD), text("faden.yaml", "priority: 999\n")]), SkillIssueCode.FadenYamlUnreadable);
  });

  it("a resource that is not text, with BinaryFile", async () => {
    const rig = workshopRig();
    const zip = await rawZip([text("SKILL.md", GOOD_SKILL_MD), { name: "assets/pic.bin", bytes: Uint8Array.from([1, 2, 3, 0, 255]) }]);

    await refused(rig, zip, SkillIssueCode.BinaryFile);
  });

  it("a SKILL.md that cannot be read", async () => {
    const rig = workshopRig();

    await refused(rig, await rawZip([text("SKILL.md", "no frontmatter here")]), SkillIssueCode.SkillMdUnreadable);
  });

  it("never reaches a store through analyzeZip alone", async () => {
    const store = new MemorySkillStore();
    const bomb = await rawZip([{ name: "SKILL.md", bytes: new Uint8Array(900 * 1024) }]);

    const analysis = await analyzeZip(bomb, "bomb.zip", { extension: () => ({ fields: fields(), issues: [] }), exists: async () => false, reserved: new Set() });

    expect(analysis.ok).toBe(false);
    expect(analysis.document).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});

describe("export", () => {
  it("then import gives the same skill back", async () => {
    const rig = workshopRig();
    const document = doc("contract-review", "Reviews a contract clause by clause.", {
      license: "MIT",
      extension: fields({ keywords: ["clause"], title: "Contract review", priority: 60 }),
      resources: [textFile("references/tone.md", "Warm."), textFile("assets/notes.txt", "Some notes.")],
    });
    expect((await rig.workshop.save(document)).status).toBe(SkillSaveStatus.Saved);

    const zip = (await rig.workshop.exportZip("contract-review"))!;

    expect(zip).toBeDefined();
    const read = readZip(zip, 100);
    expect(read.ok && read.entries.map((e) => e.name).sort()).toEqual([
      "contract-review/SKILL.md",
      "contract-review/assets/notes.txt",
      "contract-review/faden.yaml",
      "contract-review/references/tone.md",
    ]);
    const other = workshopRig();
    const analysis = await other.workshop.analyzeZip(zip, "export.zip");
    expect(analysis.ok, analysis.issues.map((i) => i.code).join(", ")).toBe(true);
    expect(analysis.issues).toEqual([]);
    await other.workshop.commitImport(analysis, false);
    const back = (await other.workshop.read("contract-review")).document!;

    expect([back.name, back.description, back.license]).toEqual([document.name, document.description, "MIT"]);
    expect(back.instructions.trim()).toBe(document.instructions.trim());
    expect([back.extension.title, back.extension.priority]).toEqual(["Contract review", 60]);
    expect(back.extension.keywords).toEqual(["clause"]);
    expect(new TextDecoder().decode(back.resources.find((r) => r.path === "references/tone.md")!.bytes)).toBe("Warm.");
    expect(new TextDecoder().decode(back.resources.find((r) => r.path === "assets/notes.txt")!.bytes)).toBe("Some notes.");
    // and the analysis' document is the document that was exported
    expect(analysis.document!.name).toBe(document.name);
    expect(analysis.document!.extension).toEqual({ ...document.extension, unknownKeys: [] });
    expect(analysis.document!.resources.map((r) => r.path).sort()).toEqual(["assets/notes.txt", "references/tone.md"]);
  });

  it("is the same through skillToZip and analyzeZip, with no store in between", async () => {
    const document = doc("nda-review", "Reviews NDAs.", { metadata: { author: "tests" }, allowedTools: "read_page", compatibility: "any" });

    const analysis = await analyzeZip(await skillToZip(document), "x.zip", { extension: (t) => workshopRig().workshop.parseExtension(t), exists: async () => false, reserved: new Set() });

    expect(analysis.ok).toBe(true);
    const back = analysis.document!;
    expect([back.name, back.description, back.compatibility, back.allowedTools, back.metadata["author"]]).toEqual(["nda-review", "Reviews NDAs.", "any", "read_page", "tests"]);
  });

  it("keeps the files across a store in IndexedDB", async () => {
    const store = new IndexedDbSkillStore({ indexedDB: new IDBFactory() });
    const rig = workshopRig({ store });
    await rig.workshop.save(doc("contract-review", "Reviews.", { resources: [textFile("references/tone.md", "Warm.")] }));

    const zip = (await rig.workshop.exportZip("contract-review"))!;
    const analysis = await workshopRig().workshop.analyzeZip(zip, "export.zip");

    expect(analysis.ok).toBe(true);
    expect(analysis.document!.resources.map((r) => r.path)).toEqual(["references/tone.md"]);
    store.close();
  });

  it("exports a bundled skill too, and a missing one or a bad name is undefined", async () => {
    const rig = workshopRig();

    const zip = (await rig.workshop.exportZip("slide-design"))!;

    expect(zip).toBeDefined();
    const read = readZip(zip, 100);
    const names = read.ok ? read.entries.map((e) => e.name) : [];
    expect(names).toContain("slide-design/SKILL.md");
    expect(names).toContain("slide-design/layouts");
    expect(await rig.workshop.exportZip("not-there")).toBeUndefined();
    expect(await rig.workshop.exportZip("../x")).toBeUndefined();
  });

  it("does not export a skill that breaks a rule", async () => {
    const rig = workshopRig();
    await rig.store.add({ name: "plain-one", description: "x", body: "Body" });
    // a record the rules would not keep, as another version of the store might hold it
    const raw = { name: "script-one", description: "x", body: "Body", resources: { "run.py": "print(1)" } };
    await rig.store.add(raw);

    expect(await rig.workshop.exportZip("plain-one")).toBeDefined();
    expect(await rig.workshop.exportZip("script-one")).toBeUndefined();
  });

  it("cannot take a binary file in: a resource that is not text is refused with BinaryFile on save", async () => {
    const rig = workshopRig();

    const result = await rig.workshop.save(doc("contract-review", "Reviews.", { resources: [binaryFile("assets/pic.bin", [1, 2, 3, 0, 255])] }));

    expect(result.status).toBe(SkillSaveStatus.Refused);
    expect(result.issues.some((i) => i.code === SkillIssueCode.BinaryFile)).toBe(true);
    expect(await rig.store.list()).toEqual([]);
  });
});
