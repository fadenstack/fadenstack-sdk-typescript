import { describe, expect, it } from "vitest";
import { SkillLimits } from "@fadenstack/agents";
import type { ChatUpdate } from "@fadenstack/client";
import { SkillEditorMode, SkillModelAnswer, parseMarkdown, type SkillEditorClosed, type SkillEditorViewModel } from "@fadenstack/ui";

import { Gate, ScriptedModel, SkillRig, doc, flush, inLanguage, textFile, waitUntil } from "./skillFakes.js";

// The skill editor's view model: the fields, the checks as you type, Save, Cancel, the files, the preview and the Test step.
// (.NET: SkillEditorTests.cs.) Commands are methods with `can*` getters; the Closed event is `onClosed`.

function newEditor(rig: SkillRig, model?: ScriptedModel): SkillEditorViewModel {
  const library = rig.library(model);
  library.newSkill();
  return library.editor!;
}

const texts = (editor: SkillEditorViewModel): string[] => editor.issues.map((i) => i.text);

describe("the skill editor", () => {
  it("starts a new skill with its checks failing and Save off, and they clear as you type", () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);

    expect(editor.canSave).toBe(false);
    expect(texts(editor)).toContain("The name is empty.");
    expect(texts(editor)).toContain("The description is empty. It tells the model when to use the skill.");
    expect(editor.isDirty).toBe(false);

    editor.name = "Contract Review";
    expect(texts(editor)).toContain("The name may use only lower-case letters, digits and single hyphens.");
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";

    expect(editor.canSave).toBe(true);
    expect(editor.isDirty).toBe(true);
    expect(editor.issues.some((i) => i.isError)).toBe(false);
  });

  it("shows the limits with their numbers, and a long body is only a warning", () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    editor.name = "a".repeat(65);
    editor.description = "d".repeat(1025);
    editor.compatibility = "c".repeat(501);

    expect(texts(editor)).toContain("The name is 65 characters long; the limit is 64.");
    expect(texts(editor)).toContain("The description is 1025 characters long; the limit is 1024.");
    expect(texts(editor)).toContain("The compatibility note is 501 characters long; the limit is 500.");

    editor.name = "long-body";
    editor.description = "x";
    editor.compatibility = "";
    editor.instructions = "w".repeat(5001 * SkillLimits.charactersPerToken);

    expect(editor.canSave).toBe(true);
    expect(editor.issues.some((i) => !i.isError && i.text.includes("5001"))).toBe(true);
    expect(editor.instructionsTokens).toBe(5001);
  });

  it("stops the save for invisible characters and scripts, and says where", () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    editor.name = "a-skill";
    editor.description = "Does\u202e it.";

    expect(editor.canSave).toBe(false);
    expect(texts(editor)).toContain("description contains an invisible character (U+202E). Remove it.");

    editor.description = "Does it.";
    editor.addResource(textFile("scripts/run.py", "print(1)"));
    expect(editor.canSave).toBe(false);
    expect(texts(editor)).toContain("scripts/run.py is a script or a program. Scripts never run here; remove it.");

    editor.resources[0]!.remove();
    expect(editor.canSave).toBe(true);
  });

  it("puts the errors before the warnings", () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    editor.name = "a-skill";
    editor.description = "x";
    editor.instructions = "w".repeat(5001 * 4);
    expect(editor.issues.map((i) => i.isError)).toEqual([false]);

    editor.description = "";
    expect(editor.issues.map((i) => i.isError)).toEqual([true, false]);
  });

  it("writes the skill on Save, closes the editor and tells the library", async () => {
    const rig = new SkillRig();
    const library = rig.library();
    library.newSkill();
    const editor = library.editor!;
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";
    editor.instructions = "## Goal\nReview.";
    let closed: SkillEditorClosed | undefined;
    editor.onClosed((e) => (closed = e));

    await editor.save();

    expect(await rig.onDisk("contract-review")).toBe(true);
    expect([closed!.name, closed!.saved]).toEqual(["contract-review", true]);
    expect(library.editor).toBeUndefined();
    expect(editor.isDirty).toBe(false);
    expect(editor.mode).toBe(SkillEditorMode.Edit);
    expect(rig.workshop.saves).toBe(1);
  });

  it("closes without saving anything on Cancel", async () => {
    const rig = new SkillRig();
    const library = rig.library();
    library.newSkill();
    const editor = library.editor!;
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";
    let closed: SkillEditorClosed | undefined;
    editor.onClosed((e) => (closed = e));

    editor.cancel();

    expect(closed!.saved).toBe(false);
    expect(library.editor).toBeUndefined();
    expect(rig.workshop.saves).toBe(0);
    expect(await rig.isEmpty()).toBe(true);
  });

  it("stops calling a listener that has unsubscribed", () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    let calls = 0;
    const off = editor.onClosed(() => calls++);
    off();

    editor.cancel();

    expect(calls).toBe(0);
  });

  it("asks before it replaces a taken name, and a new name withdraws the question", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc("contract-review", "The old one."));
    const editor = newEditor(rig);
    editor.name = "contract-review";
    editor.description = "The new one.";

    await editor.save();

    expect(editor.needsReplaceConfirmation).toBe(true);
    expect(editor.canConfirmReplace).toBe(true);
    expect(editor.replaceTitle).toBe("Replace contract-review?");
    expect((await rig.workshop.read("contract-review")).document!.description).toBe("The old one.");

    editor.name = "nda-review";
    expect(editor.needsReplaceConfirmation).toBe(false);
    editor.name = "contract-review";
    await editor.save();
    expect(editor.needsReplaceConfirmation).toBe(true);

    await editor.confirmReplace();

    expect((await rig.workshop.read("contract-review")).document!.description).toBe("The new one.");
  });

  it("lets the person say no to the replacement", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc("contract-review", "The old one."));
    const editor = newEditor(rig);
    editor.name = "contract-review";
    editor.description = "The new one.";
    await editor.save();

    editor.dismissReplace();

    expect(editor.needsReplaceConfirmation).toBe(false);
    await editor.confirmReplace(); // nothing is waiting: nothing is written
    expect((await rig.workshop.read("contract-review")).document!.description).toBe("The old one.");
    expect(rig.workshop.saves).toBe(2); // the old one, and the Save the store answered with "exists"
  });

  it("moves a skill that is edited and renamed", async () => {
    const rig = new SkillRig();
    await rig.workshop.save(doc());
    const library = rig.library();
    await library.refresh();
    await library.edit(library.rows.find((r) => r.name === "contract-review"));
    const editor = library.editor!;

    editor.name = "nda-review";
    await editor.save();

    expect(await rig.onDisk("nda-review")).toBe(true);
    expect(await rig.onDisk("contract-review")).toBe(false);
  });

  it("cannot change or save a bundled skill", async () => {
    const rig = new SkillRig();
    const library = rig.library();
    await library.refresh();
    await library.edit(library.rows.find((r) => r.name === "slide-design"));
    const editor = library.editor!;

    editor.description = "Changed.";
    editor.name = "other";
    editor.addResource(textFile("a.md", "x"));

    expect([editor.description, editor.name]).toEqual(["Designs a slide.", "slide-design"]);
    expect(editor.resources).toHaveLength(0);
    expect(editor.canSave).toBe(false);
    expect(editor.isDirty).toBe(false);
    await editor.save();
    expect(rig.workshop.saves).toBe(0);
  });

  it("shows the preview as the chat's Markdown model, and only when it is on", () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    editor.instructions = "# Goal\n\n- one\n- two\n\n`code`";

    expect(editor.previewBlocks).toHaveLength(0);

    editor.togglePreview();

    expect(editor.showPreview).toBe(true);
    expect(editor.previewBlocks.length).toBeGreaterThan(0);
    expect(editor.previewBlocks).toHaveLength(parseMarkdown(editor.instructions).length);
    const version = editor.version;
    editor.instructions = "# Other";
    expect(editor.version).toBeGreaterThan(version);
    expect(editor.previewBlocks).toHaveLength(parseMarkdown("# Other").length);
    editor.togglePreview();
    expect(editor.previewBlocks).toHaveLength(0);
  });

  it("edits the faden.yaml fields as fields and writes them back as a faden.yaml", async () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";
    editor.keywordsText = "contract, clause\nnda";
    editor.fileTypesText = ".docx; pdf";
    editor.preferredToolsText = "read_page";
    editor.tagsText = "legal";
    editor.extensionTitle = "Contract review";
    editor.priority = 70;
    editor.activation = "always";
    expect(editor.activationOptions.map((o) => o.value)).toEqual(["auto", "always", "manual"]);
    expect(editor.activationOptions.find((o) => o.value === "always")!.label).toBe("Always");

    await editor.save();

    const stored = (await rig.store.get("contract-review"))!;
    expect(stored.fadenYaml).toContain("keywords:");
    expect(stored.fadenYaml).toContain("- nda");
    const back = (await rig.workshop.read("contract-review")).document!.extension;
    expect(back.keywords).toEqual(["contract", "clause", "nda"]);
    expect(back.fileTypes).toEqual([".docx", "pdf"]);
    expect([back.title, back.priority, back.activation]).toEqual(["Contract review", 70, "always"]);
    expect(stored.body).not.toContain("keywords");
  });

  it("calls a priority the module would not accept an error already here", () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    editor.name = "a-skill";
    editor.description = "x";

    editor.priority = 500;

    expect(editor.canSave).toBe(false);
    expect(texts(editor).some((t) => t.startsWith("faden.yaml cannot be read:"))).toBe(true);
  });

  it("adds, renames and removes files, and the checks follow", async () => {
    const rig = new SkillRig();
    rig.files.resource = textFile("references\\tone.md", "Warm.");
    const editor = newEditor(rig);
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";
    expect(editor.canAddResource).toBe(true);

    await editor.addResourceFromHost();

    expect(editor.resources).toHaveLength(1);
    const row = editor.resources[0]!;
    expect([row.path, row.isText, editor.hasResources]).toEqual(["references/tone.md", true, true]);
    expect(row.canRename).toBe(false); // the name was not changed yet

    row.newPath = "../tone.md";
    expect(row.canRename).toBe(true);
    row.rename();
    expect(editor.canSave).toBe(false);
    expect(texts(editor).some((t) => t.includes("is not allowed"))).toBe(true);

    editor.resources[0]!.newPath = "references/voice.md";
    editor.resources[0]!.rename();
    expect(editor.canSave).toBe(true);
    expect(editor.resources[0]!.path).toBe("references/voice.md");

    await editor.save();
    expect((await rig.store.get("contract-review"))!.resources).toEqual({ "references/voice.md": "Warm." });
  });

  it("replaces a file of the same path, ignoring case, and recognises a file that is not text", () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);

    editor.addResource(textFile("references/a.md", "one"));
    editor.addResource(textFile("References/A.md", "two"));
    editor.addResource({ path: "references/pic.png", bytes: new Uint8Array([0, 1, 2]) });

    expect(editor.resources.map((r) => r.path)).toEqual(["References/A.md", "references/pic.png"]);
    expect(editor.resources.map((r) => r.isText)).toEqual([true, false]);
    expect(editor.resources[1]!.size).toBe(3);
    expect(texts(editor).some((t) => t.includes("references/pic.png"))).toBe(true); // a skill keeps text files only
  });

  it("does not add a file without a file host or when the person cancelled the picker", async () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);

    await editor.addResourceFromHost(); // the host has nothing to hand over

    expect(editor.resources).toHaveLength(0);
    expect(editor.isDirty).toBe(false);
  });

  it("cannot save a skill with fields beyond the six until they are removed", async () => {
    const rig = new SkillRig();
    rig.store.putRaw({ name: "extra-key", description: "Has a stray field.", body: "Body", version: 2 });
    const library = rig.library();
    await library.refresh();
    expect(library.rows.find((r) => r.name === "extra-key")!.isBroken).toBe(true);
    await library.edit(library.rows.find((r) => r.name === "extra-key"));
    const editor = library.editor!;

    expect(editor.hasUnknownKeys).toBe(true);
    expect(editor.canSave).toBe(false);
    expect(editor.canDropUnknownKeys).toBe(true);
    expect(texts(editor).some((t) => t.includes("version"))).toBe(true);

    editor.dropUnknownKeys();

    expect(editor.hasUnknownKeys).toBe(false);
    expect(editor.canSave).toBe(true);
    await editor.save();
    expect(Object.keys((await rig.store.get("extra-key"))!)).not.toContain("version");
  });

  it("stops the save for a file too large to be kept, so it is not dropped silently", async () => {
    const rig = new SkillRig();
    await rig.store.add({ name: "contract-review", description: "x", body: "Body", resources: { "big.md": "x".repeat(SkillLimits.fileMaxBytes + 10) } });
    const library = rig.library();
    await library.refresh();

    await library.edit(library.rows.find((r) => r.name === "contract-review"));

    expect(library.editor!.canSave).toBe(false);
    expect(texts(library.editor!).some((t) => t.startsWith("big.md is larger than"))).toBe(true);
  });

  it("shows what the pre-selection lists, matches and pre-loads in the test step", async () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";
    editor.keywordsText = "clause";

    editor.testPrompt = "Please check this clause and make a slide.";
    await editor.runTest();

    expect(editor.hasTestResult).toBe(true);
    expect(editor.testListed).toContain("contract-review");
    expect(editor.testMatches).toContain("contract-review — matches its keywords");
    expect(editor.testMatches).toContain("slide-design — matches its keywords");
    expect(editor.testPreloaded).toEqual(["contract-review"]);
    expect(editor.testIncludesThisSkill).toBe(true);
    expect(editor.testNote).toBe("");

    editor.testPrompt = "Something else entirely.";
    await editor.runTest();

    expect(editor.testIncludesThisSkill).toBe(false);
    expect(editor.testNote).toBe("No skill is offered for this message.");
    expect(rig.workshop.saves).toBe(0);
  });

  it("lets a newer test replace an older one that answers late", async () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";
    editor.keywordsText = "clause";
    const gate = new Gate();
    rig.workshop.holdTest = (prompt) => (prompt === "first" ? gate.promise : Promise.resolve());

    editor.testPrompt = "first";
    const older = editor.runTest();
    editor.testPrompt = "Please check this clause.";
    await editor.runTest();
    gate.open();
    await older;

    expect(editor.testMatches).toContain("contract-review — matches its keywords");
    expect(editor.testIncludesThisSkill).toBe(true);
  });

  it("asks the model once whether it would call load_skill, and runs no tool", async () => {
    const rig = new SkillRig();
    const model = new ScriptedModel().loads("contract-review").loads("slide-design").says("I would just answer.").throws();
    const editor = newEditor(rig, model);
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";
    editor.testPrompt = "Review this contract.";
    expect(editor.canAskModel).toBe(true);
    expect(editor.canAsk).toBe(true);

    await editor.askModel();
    expect([editor.modelAnswer, editor.modelAnswerText]).toEqual([SkillModelAnswer.LoadsThis, "The model would load contract-review."]);
    await editor.askModel();
    expect([editor.modelAnswer, editor.modelAnswerText]).toEqual([SkillModelAnswer.LoadsOther, "The model would load another skill instead: slide-design."]);
    await editor.askModel();
    expect([editor.modelAnswer, editor.modelAnswerText]).toEqual([SkillModelAnswer.LoadsNone, "The model would not load a skill for this message."]);
    await editor.askModel();
    expect([editor.modelAnswer, editor.modelAnswerText]).toEqual([SkillModelAnswer.Failed, "The model could not be asked."]);

    expect(model.calls).toHaveLength(4);
    const { messages, options } = model.calls[0]!;
    expect(messages[0]!.role).toBe("system");
    expect(String(messages[0]!.content)).toContain("contract-review");
    expect(String(messages[0]!.content)).toContain("<available_skills>");
    expect(messages[1]).toEqual({ role: "user", content: "Review this contract." });
    // The one tool is only a declaration: it cannot run.
    expect(options!.tools).toHaveLength(1);
    const tool = options!.tools![0]!;
    expect(tool.name).toBe("load_skill");
    expect(Object.values(tool).some((v) => typeof v === "function")).toBe(false);
    expect(rig.workshop.saves).toBe(0);
    expect(await rig.isEmpty()).toBe(true);
  });

  it("is off without a model, and makes no call when no skill is listed", async () => {
    const rig = new SkillRig();
    const editor = newEditor(rig);
    editor.testPrompt = "x";
    expect(editor.canAskModel).toBe(false);
    expect(editor.canAsk).toBe(false);
    await editor.askModel();
    expect(editor.modelAnswer).toBe(SkillModelAnswer.NotAsked);
    expect(editor.modelAnswerText).toBe("");

    const model = new ScriptedModel();
    const other = newEditor(rig, model);
    other.name = "a-skill";
    other.description = "x";
    other.keywordsText = "never-matches";
    other.testPrompt = "Something else.";

    await other.askModel();

    expect(model.calls).toHaveLength(0); // nothing is listed, so there is nothing to ask
    expect(other.modelAnswer).toBe(SkillModelAnswer.LoadsNone);
  });

  it("does not ask without a message", async () => {
    const rig = new SkillRig();
    const model = new ScriptedModel();
    const editor = newEditor(rig, model);
    editor.testPrompt = "   ";

    expect(editor.canAsk).toBe(false);
    await editor.askModel();

    expect(model.calls).toHaveLength(0);
  });

  it("starts no second question while one is on its way, and takes the one answer", async () => {
    // .NET lets a newer question overtake the older one; here the button is off while a question is open (`canAsk`), so the
    // second press does nothing and the first answer is the answer.
    const rig = new SkillRig();
    const gate = new Gate<ChatUpdate[]>();
    const model = new ScriptedModel().reply(() => gate.promise).loads("slide-design");
    const editor = newEditor(rig, model);
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";
    editor.testPrompt = "Review this contract.";

    const older = editor.askModel();
    await waitUntil(() => model.calls.length === 1);
    expect(editor.modelAnswer).toBe(SkillModelAnswer.Asking);
    expect(editor.modelAnswerText).toBe("Asking the model…");
    expect(editor.canAsk).toBe(false);
    await editor.askModel();
    expect(model.calls).toHaveLength(1);
    gate.open([{ type: "text", text: "I would just answer." }]);
    await older;

    expect(editor.modelAnswer).toBe(SkillModelAnswer.LoadsNone);
  });

  it("changes nothing when an answer arrives after the editor was cancelled", async () => {
    const rig = new SkillRig();
    const gate = new Gate<ChatUpdate[]>();
    const model = new ScriptedModel().reply(async (): Promise<ChatUpdate[]> => {
      await gate.promise;
      return [{ type: "tool_calls", calls: [{ id: "c", name: "load_skill", argumentsJson: "{\"skillName\":\"contract-review\"}", arguments: { skillName: "contract-review" } }] }];
    });
    const editor = newEditor(rig, model);
    editor.name = "contract-review";
    editor.description = "Reviews a contract.";
    editor.testPrompt = "Review this contract.";

    const asking = editor.askModel();
    await waitUntil(() => model.calls.length === 1);
    const signal = model.calls[0]!.options!.signal!;
    editor.cancel();
    expect(signal.aborted).toBe(true);
    gate.open([]);
    await asking;
    await flush();

    expect(editor.modelAnswer).toBe(SkillModelAnswer.Asking); // the late answer was dropped
    expect(rig.workshop.saves).toBe(0);
  });

  it("makes a late answer of an older Save close nothing after Cancel", async () => {
    const rig = new SkillRig();
    const gate = new Gate();
    const original = rig.workshop.save.bind(rig.workshop);
    rig.workshop.save = async (...args) => {
      await gate.promise;
      return original(...args);
    };
    const library = rig.library();
    library.newSkill();
    const editor = library.editor!;
    editor.name = "contract-review";
    editor.description = "x";
    const closed: SkillEditorClosed[] = [];
    editor.onClosed((e) => closed.push(e));

    const saving = editor.save();
    expect(editor.isSaving).toBe(true);
    expect(editor.canSave).toBe(false);
    editor.cancel();
    gate.open();
    await saving;

    expect(closed).toEqual([{ saved: false, name: undefined }]); // Cancel closed it once; the stale Save closed nothing more
  });

  it("says the texts in the language and changes them with it", () => {
    const rig = new SkillRig();
    let language = "en";
    const library = rig.library(undefined, () => inLanguage(language));
    library.newSkill();
    const editor = library.editor!;
    expect(editor.heading).toBe("New skill");
    expect(texts(editor)).toContain("The name is empty.");

    language = "de";
    editor.retext();

    expect(editor.heading).toBe("Neuer Skill");
    expect(texts(editor)).toContain("Der Name ist leer.");
    expect(editor.activationOptions.find((o) => o.value === "always")!.label).toBe("Immer");
    language = "fr";
    editor.retext();
    expect(texts(editor)).toContain("Le nom est vide.");
  });
});
