import { describe, expect, it } from "vitest";
import { SkillOrigin, createSkillEntry } from "@fadenstack/agents";
import { readZip } from "@fadenstack/skills";
import { SkillEditorMode, SkillLibraryViewModel, SkillMessageKind, SkillRowViewModel, englishStrings, germanStrings, type UiStrings } from "@fadenstack/ui";

import {
  Gate,
  ScriptedModel,
  SkillRig,
  ThrowingWorkshop,
  doc,
  english,
  inLanguage,
  organisationSkills,
  textFile,
  waitUntil,
  zipOf,
} from "./skillFakes.js";

// The skill library's view model: the list with its labels and switches, and new, edit, duplicate, delete, import and export.
// (.NET: SkillLibraryTests.cs.) There is no dispatcher: a command is a method, `can*` says whether it is on, and `version` /
// `subscribe` tell a skin that something changed.

const GOOD_SKILL_MD = "---\nname: contract-review\ndescription: Reviews a contract clause by clause.\n---\n## Goal\nReview it.\n";

const row = (library: SkillLibraryViewModel, name: string) => library.rows.find((r) => r.name === name)!;

describe("the skill library", () => {
  it("lists bundled, own and organisation skills with their labels and switches", async () => {
    const rig = new SkillRig({ organisation: organisationSkills({ slug: "org-policy", name: "Org policy", description: "From the server." }) });
    await rig.workshop.save(doc());
    const library = rig.library();

    await library.refresh();

    expect(library.rows.map((r) => r.name)).toEqual(["slide-design", "contract-review", "org-policy"]);
    const [bundled, own, org] = library.rows as [typeof library.rows[0], typeof library.rows[0], typeof library.rows[0]];
    expect([bundled.originLabel, bundled.statusLabel, bundled.canDelete]).toEqual(["Built in", "", false]);
    expect([own.originLabel, own.statusLabel, own.canDelete]).toEqual(["Yours", "Not reviewed", true]);
    expect([org.originLabel, org.statusLabel, org.canDelete]).toEqual(["Your organisation", "", false]);
    expect([bundled.canSwitch, own.canSwitch, org.canSwitch]).toEqual([true, true, false]);
    expect([bundled.isReadOnly, own.isReadOnly, org.isReadOnly]).toEqual([true, false, true]);
    expect([bundled.canOpen, own.canOpen, org.canOpen]).toEqual([true, true, false]);
    expect(own.switchLabel).toBe("On");
    expect(library.isLoading).toBe(false);
    expect(library.note).toBe("");
  });

  it("says so when the library is empty and when it cannot be read", async () => {
    const rig = new SkillRig({ bundled: [] });
    const library = rig.library();
    expect(library.note).toBe("");

    await library.refresh();
    expect(library.isEmpty).toBe(true);
    expect(library.note).toBe("There are no skills yet. Create one, or import a folder or a zip.");

    const broken = new SkillLibraryViewModel({ workshop: new ThrowingWorkshop(), strings: () => english });
    await broken.refresh();
    expect(broken.failed).toBe(true);
    expect(broken.note).toBe("The skills could not be read.");
  });

  it("says the labels in the language of the texts and changes them with it", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc());
    let language = "en";
    const library = rig.library(undefined, () => inLanguage(language));
    await library.refresh();
    const own = row(library, "contract-review");
    expect(own.statusLabel).toBe("Not reviewed");
    const seen = library.version;

    language = "de";
    library.retext();
    expect([own.statusLabel, own.originLabel]).toEqual(["Nicht geprüft", "Eigene"]);
    expect(library.version).toBeGreaterThan(seen);
    language = "zh-Hans";
    library.retext();
    expect(own.statusLabel).toBe("未经审核");
  });

  it("turns a skill off in the workshop with the switch, and the list shows it", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc());
    const library = rig.library();
    await library.refresh();

    await library.toggle(row(library, "contract-review"));

    expect(await rig.switches.isEnabled("contract-review")).toBe(false);
    expect(row(library, "contract-review").isEnabled).toBe(false);
    expect(row(library, "contract-review").switchLabel).toBe("Off");
    await library.toggle(row(library, "contract-review"));
    expect(await rig.switches.isEnabled("contract-review")).toBe(true);
  });

  it("gives an organisation skill no switch and no way to open, copy, export or delete it", async () => {
    const rig = new SkillRig({ organisation: organisationSkills({ slug: "org-policy", name: "Org", description: "x" }) });
    const library = rig.library();
    await library.refresh();
    const org = row(library, "org-policy");

    expect(library.canToggle(org)).toBe(false);
    expect(library.canEdit(org)).toBe(false);
    expect(library.canDuplicate(org)).toBe(false);
    expect(library.canExport(org)).toBe(false);
    expect(library.canAskDelete(org)).toBe(false);
    await library.toggle(org);
    await library.edit(org);
    expect(library.editor).toBeUndefined();
  });

  it("opens an empty editor for New and writes nothing", async () => {
    const rig = new SkillRig();
    const library = rig.library();

    library.newSkill();

    expect(library.editor).toBeDefined();
    expect(library.editor!.mode).toBe(SkillEditorMode.New);
    expect(library.canNew).toBe(false); // one editor at a time
    expect(rig.workshop.saves).toBe(0);
    expect(await rig.isEmpty()).toBe(true);
    library.editor!.cancel();
    expect(library.editor).toBeUndefined();
  });

  it("opens an own skill for editing and a bundled one read only", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc());
    const library = rig.library();
    await library.refresh();

    await library.edit(row(library, "contract-review"));
    const own = library.editor!;
    expect([own.mode, own.name, own.isReadOnly]).toEqual([SkillEditorMode.Edit, "contract-review", false]);
    expect(own.heading).toBe("Editing contract-review");
    own.cancel();

    await library.edit(row(library, "slide-design"));
    const bundled = library.editor!;
    expect([bundled.mode, bundled.isReadOnly, bundled.instructions]).toEqual([SkillEditorMode.View, true, "Use one idea per slide."]);
    expect(bundled.heading).toBe("slide-design is read only.");
  });

  it("opens a copy under a free name for Duplicate and saves nothing until Save", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc("contract-review", undefined, { resources: [textFile("references/a.md", "A")] }));
    await rig.workshop.save(doc("contract-review-copy"));
    const saves = rig.workshop.saves;
    const library = rig.library();
    await library.refresh();

    await library.duplicate(row(library, "contract-review"));

    const editor = library.editor!;
    expect([editor.name, editor.mode]).toEqual(["contract-review-copy-2", SkillEditorMode.New]);
    expect(editor.description).toBe("Reviews a contract clause by clause.");
    expect(editor.resources).toHaveLength(1);
    expect(rig.workshop.saves).toBe(saves);
    expect(await rig.onDisk("contract-review-copy-2")).toBe(false);

    await editor.save();

    expect(await rig.onDisk("contract-review-copy-2")).toBe(true);
    expect(library.editor).toBeUndefined(); // saving closed the editor
    await waitUntil(() => library.rows.some((r) => r.name === "contract-review-copy-2"));
    expect(library.message).toBe("contract-review-copy-2 was saved.");
  });

  it("asks before it deletes and deletes only after the person confirms", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc());
    const library = rig.library();
    await library.refresh();
    const own = row(library, "contract-review");

    library.askDelete(own);
    expect(library.deleteTitle).toBe("Delete contract-review?");
    expect(library.canConfirmDelete).toBe(true);
    expect(await rig.onDisk("contract-review")).toBe(true);
    expect(rig.workshop.deletes).toBe(0);

    library.cancelDelete();
    expect(library.pendingDelete).toBeUndefined();
    expect(await rig.onDisk("contract-review")).toBe(true);
    expect(rig.workshop.deletes).toBe(0);

    library.askDelete(own);
    await library.confirmDelete();

    expect(await rig.onDisk("contract-review")).toBe(false);
    expect(library.pendingDelete).toBeUndefined();
    expect(library.rows.some((r) => r.name === "contract-review")).toBe(false);
    expect(library.message).toBe("contract-review was deleted.");
  });

  it("does not let a bundled skill be asked to be deleted", async () => {
    const rig = new SkillRig();
    const library = rig.library();
    await library.refresh();

    expect(library.canAskDelete(row(library, "slide-design"))).toBe(false);
    library.askDelete(row(library, "slide-design"));
    expect(library.pendingDelete).toBeUndefined();
  });

  it("waits for the person after a good import and writes only when confirmed", async () => {
    const rig = new SkillRig();
    rig.files.importZip = await zipOf("good.zip", ["contract-review/SKILL.md", GOOD_SKILL_MD]);
    const library = rig.library();

    await library.import();

    expect(library.pendingImport).toBeDefined();
    expect(library.canConfirmImport).toBe(true);
    expect(library.importTitle).toBe("Import contract-review?");
    expect(library.importBody).toContain("not reviewed");
    expect(await rig.onDisk("contract-review")).toBe(false);
    expect(rig.workshop.commits).toBe(0);

    await library.confirmImport();

    expect(await rig.onDisk("contract-review")).toBe(true);
    expect(library.pendingImport).toBeUndefined();
    expect(library.message).toBe("contract-review was imported.");
    expect(library.rows.some((r) => r.name === "contract-review")).toBe(true);
  });

  it("writes nothing for a cancelled import", async () => {
    const rig = new SkillRig();
    rig.files.importZip = await zipOf("good.zip", ["SKILL.md", GOOD_SKILL_MD]);
    const library = rig.library();
    await library.import();
    expect(library.canCancelImport).toBe(true);

    library.cancelImport();

    expect(library.pendingImport).toBeUndefined();
    expect(await rig.onDisk("contract-review")).toBe(false);
    expect(rig.workshop.commits).toBe(0);
    await library.confirmImport(); // nothing is waiting: nothing happens
    expect(rig.workshop.commits).toBe(0);
  });

  it("says an import over an existing skill replaces it, and does so only on Import", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc("contract-review", "The old one."));
    rig.files.importZip = await zipOf("good.zip", ["SKILL.md", GOOD_SKILL_MD]);
    const library = rig.library();

    await library.import();

    expect(library.importReplaces).toBe(true);
    expect(library.importBody).toBe("A skill named contract-review is already here. Importing replaces it.");
    expect((await rig.workshop.read("contract-review")).document!.description).toBe("The old one.");

    await library.confirmImport();

    expect((await rig.workshop.read("contract-review")).document!.description).toBe("Reviews a contract clause by clause.");
  });

  it.each([
    ["../evil/SKILL.md", "pwned"],
    ["/abs/x.md", "pwned"],
    ["scripts/run.ps1", "Remove-Item *"],
  ])("shows why a hostile import (%s) is refused and cannot be confirmed", async (name, text) => {
    const rig = new SkillRig();
    rig.files.importZip = await zipOf("hostile.zip", ["SKILL.md", GOOD_SKILL_MD], [name, text]);
    const library = rig.library();

    await library.import();

    expect(library.pendingImport).toBeDefined();
    expect(library.canConfirmImport).toBe(false);
    expect(library.importIssues.some((i) => i.isError && i.text.length > 0)).toBe(true);
    expect(library.importBody).toBe("This cannot be imported. Nothing was written.");
    expect(await rig.isEmpty()).toBe(true);
    await library.confirmImport();
    expect(rig.workshop.commits).toBe(0);
  });

  it("names the problem for an import with an unknown key or a hidden character", async () => {
    const rig = new SkillRig();
    rig.files.importZip = await zipOf("keys.zip", ["SKILL.md", "---\nname: a-skill\ndescription: Does\u200b it.\nversion: 2\n---\nBody\n"]);
    const library = rig.library();

    await library.import();

    const texts = library.importIssues.map((i) => i.text);
    expect(texts.some((t) => t.includes("version"))).toBe(true);
    expect(texts.some((t) => t.includes("U+200B"))).toBe(true);
    expect(library.canConfirmImport).toBe(false);
  });

  it("makes an older import's answer stale when a newer import was started", async () => {
    const rig = new SkillRig();
    const first = await zipOf("first.zip", ["SKILL.md", GOOD_SKILL_MD]);
    const second = await zipOf("second.zip", ["SKILL.md", GOOD_SKILL_MD.replace("contract-review", "nda-review")]);
    const gate = new Gate();
    rig.workshop.holdAnalysis = (source) => (source === "first.zip" ? gate.promise : Promise.resolve());
    const library = rig.library();

    const older = library.importFrom(first);
    await library.importFrom(second);
    gate.open();
    await older;

    expect(library.pendingImport!.document!.name).toBe("nda-review");
  });

  it("hands the exported zip to the file host and says so", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc("contract-review", undefined, { resources: [textFile("references/a.md", "A")] }));
    const library = rig.library();
    await library.refresh();

    await library.export(row(library, "contract-review"));

    expect(rig.files.exportedAs).toBe("contract-review.zip");
    const read = readZip(rig.files.exported!, 100);
    expect(read.ok).toBe(true);
    const names = read.ok ? read.entries.map((e) => e.name) : [];
    expect(names).toContain("contract-review/SKILL.md");
    expect(names).toContain("contract-review/references/a.md");
    expect(library.message).toBe("contract-review was exported.");
  });

  it("turns import and export off without a file host", async () => {
    const rig = new SkillRig();
    const library = new SkillLibraryViewModel({ workshop: rig.workshop, strings: () => english });
    await library.refresh();

    expect(library.canImport).toBe(false);
    expect(library.canExport(library.rows[0])).toBe(false);
    await library.import();
    await library.export(library.rows[0]);
    expect(library.pendingImport).toBeUndefined();
    expect(library.message).toBe("");
  });

  it("tells a skin of every change through subscribe and version", async () => {
    const rig = new SkillRig();
    const library = rig.library();
    let calls = 0;
    const off = library.subscribe(() => calls++);

    await library.refresh();
    expect(calls).toBeGreaterThanOrEqual(2); // loading, loaded
    const version = library.version;
    library.newSkill();
    expect(library.version).toBeGreaterThan(version);
    off();
    const before = calls;
    library.editor!.cancel();
    expect(calls).toBe(before);
  });

  it("closes the editor again when a saved proposal is shown through the library and refreshes the list", async () => {
    const rig = new SkillRig();
    const library = rig.library();
    library.newSkill();
    const editor = library.editor!;
    editor.name = "nda-review";
    editor.description = "Reviews an NDA.";

    await editor.save();

    expect(library.editor).toBeUndefined();
    await waitUntil(() => library.rows.some((r) => r.name === "nda-review"));
    expect(library.message).toBe("nda-review was saved.");
    expect(rig.workshop.saveNames).toEqual(["nda-review"]);
  });

  it("refuses a zip that is not a zip", async () => {
    const rig = new SkillRig();
    const library = rig.library();

    await library.importFrom({ name: "junk.zip", bytes: new Uint8Array([1, 2, 3]) });

    expect(library.canConfirmImport).toBe(false);
    expect(library.importIssues.some((i) => i.isError)).toBe(true);
    expect(await rig.isEmpty()).toBe(true);
  });
});

describe("the gaps the skin builders found: the library", () => {
  it("exposes its texts and says so when the language changes", async () => {
    const rig = new SkillRig();
    let current: UiStrings = englishStrings;
    const library = rig.library(undefined, () => current);
    const versions: number[] = [];
    library.subscribe(() => versions.push(library.version));

    expect(library.strings.skillLibraryTitle).toBe("Skills on this device");
    current = germanStrings;
    library.retext();

    expect(versions.length).toBeGreaterThan(0);
    expect(library.strings.skillLibraryTitle).toBe(germanStrings.skillLibraryTitle);
  });

  it("says whether a message is information or an error", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc());
    const library = rig.library();
    await library.refresh();
    expect([library.message, library.messageIsError, library.messageIsInformation, library.messageIsWarning]).toEqual(["", false, false, false]);

    // information: what an action did
    library.askDelete(row(library, "contract-review"));
    await library.confirmDelete();
    expect(library.message).toBe("contract-review was deleted.");
    expect(library.messageKind).toBe(SkillMessageKind.Information);
    expect([library.messageIsInformation, library.messageIsError]).toEqual([true, false]);

    // an error: the action did not happen (the skill is gone before Edit reads it)
    await rig.workshop.save(doc("other-skill"));
    await library.refresh();
    const other = row(library, "other-skill");
    await rig.workshop.delete("other-skill");
    await library.edit(other);
    expect(library.message).not.toBe("");
    expect(library.messageKind).toBe(SkillMessageKind.Error);
    expect([library.messageIsError, library.messageIsInformation]).toEqual([true, false]);
  });

  it("says a broken skill cannot be read, and why when it knows", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc());
    rig.store.putRaw({ name: "bad-skill", description: "x", body: "Body.", version: 3 });
    let current: UiStrings = englishStrings;
    const library = rig.library(undefined, () => current);
    await library.refresh();

    const bad = row(library, "bad-skill");
    expect(bad.isBroken).toBe(true);
    expect(bad.brokenText.startsWith("This skill cannot be read: ")).toBe(true);
    expect(bad.brokenText).toContain("version");
    expect(row(library, "contract-review").brokenText).toBe("");
    expect(row(library, "slide-design").brokenText).toBe("");
    current = germanStrings;
    library.retext();
    expect(bad.brokenText.startsWith("Dieser Skill kann nicht gelesen werden: ")).toBe(true);

    // a broken skill whose reason is not known still says it cannot be read
    const odd = new SkillRowViewModel(createSkillEntry("odd", "", SkillOrigin.Own, true, true), () => englishStrings);
    expect(odd.brokenText).toBe("This skill cannot be read. Open it to fix it, or delete it.");
  });

  it("names the buttons of a row for the row, in every language", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc());
    let current: UiStrings = englishStrings;
    const library = rig.library(undefined, () => current);
    await library.refresh();
    const own = row(library, "contract-review");
    const bundled = row(library, "slide-design");

    expect([own.editLabel, own.deleteLabel, own.exportLabel, own.duplicateLabel]).toEqual([
      "Edit contract-review", "Delete contract-review", "Export contract-review", "Duplicate contract-review",
    ]);
    expect(bundled.viewLabel).toBe("View slide-design");
    current = inLanguage("fr");
    library.retext();
    expect(own.editLabel).toBe("Modifier contract-review");
    current = inLanguage("zh-Hans");
    library.retext();
    expect(new Set([own.editLabel, own.deleteLabel, own.exportLabel, own.duplicateLabel, bundled.viewLabel]).size).toBe(5);
    expect(own.exportLabel).toContain("contract-review");
  });

  it("has a 'Draft from this chat' entry only when the host gives a conversation", async () => {
    const rig = new SkillRig();
    const without = rig.library();
    expect([without.hasDraft, without.draft, without.canToggleDraft]).toEqual([false, undefined, false]);

    const chat = [{ fromUser: true, text: "Please review this contract." }, { fromUser: false, text: "Clause 4 caps liability." }];
    const model = new ScriptedModel().says("---\nname: contract-review\ndescription: Reviews contracts. Use when asked.\n---\n## Goal\nReview.\n");
    const library = new SkillLibraryViewModel({ workshop: rig.workshop, files: rig.files, model, strings: () => english, draftSource: () => chat });

    expect([library.hasDraft, library.draftOpen, library.canToggleDraft]).toEqual([true, false, true]);
    library.toggleDraft();
    expect(library.draftOpen).toBe(true);

    // the draft opens in the library's editor as a proposal; nothing is saved
    await library.draft!.draft();
    expect(library.editor?.isProposal).toBe(true);
    expect(library.draftOpen).toBe(false);
    expect(rig.workshop.saves).toBe(0);
    expect(library.canToggleDraft).toBe(false);

    // Open the proposal while it is open: the same editor, once
    library.draft!.openProposal();
    expect(library.editor).toBe(library.draft!.proposal);
    library.editor!.cancel();
    expect(library.editor).toBeUndefined();
  });
});