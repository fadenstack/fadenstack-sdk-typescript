import { SkillSaveStatus, skillSaveResult, type SkillDocument, type SkillEntry, type SkillSaveResult } from "@fadenstack/agents";
import {
  SkillDraftViewModel,
  SkillEditorViewModel,
  SkillLibraryViewModel,
  type SkillDraftMessage,
  type UiStrings,
} from "@fadenstack/ui";

import { Gate, ScriptedModel, SkillRig, SpyWorkshop, ThrowingWorkshop, doc, flush, textFile, zipOf } from "../../ui/test/skillFakes.js";

// Real skill view models on the real (in-memory) workshop, in a given language, driven to a state before a skin draws it. Shared by the
// React and the Vue tests: nothing here knows a framework. (The fakes are the view models' own: packages/ui/test/skillFakes.ts.)

export const GOOD_SKILL_MD = "---\nname: contract-review\ndescription: Reviews a contract clause by clause.\n---\n## Goal\nReview it.\n";

/** A workshop that can hold the list back (the library reading), and can fail a save. */
class RigWorkshop extends SpyWorkshop {
  list_gate: Gate | undefined;
  failSave = false;

  override async list(signal?: AbortSignal): Promise<readonly SkillEntry[]> {
    if (this.list_gate) await this.list_gate.promise;
    return super.list(signal);
  }

  override save(document: SkillDocument, previousName?: string, replaceExisting?: boolean, signal?: AbortSignal): Promise<SkillSaveResult> {
    return this.failSave ? Promise.resolve(skillSaveResult(SkillSaveStatus.Failed, [], document.name)) : super.save(document, previousName, replaceExisting, signal);
  }
}

export const LIBRARY_STATES = [
  "loading", "failed", "empty", "list", "confirmDelete", "importOk", "importReplaces", "importRefused", "message",
] as const;
export type LibraryState = (typeof LIBRARY_STATES)[number];

export const EDITOR_STATES = [
  "new", "newValid", "newWarning", "edit", "view", "proposal", "replace", "unknownKeys", "resources", "tested", "answered", "saveFailed",
] as const;
export type EditorState = (typeof EDITOR_STATES)[number];

export const DRAFT_STATES = ["idle", "working", "ready", "readyWithProblems", "failed", "unreadable", "noChat", "noModel"] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

export const GOOD_ANSWER = [
  "---", "name: contract-review", "description: Reviews a contract clause by clause. Use it when the user shares a contract.", "---", "",
  "## Goal", "Review the contract.", "", "## Procedure", "1. Read each clause.",
].join("\n");

export const CHAT: readonly SkillDraftMessage[] = [
  { fromUser: true, text: "Please review this contract for me." },
  { fromUser: false, text: "Clause 4 limits liability to 10,000 euros." },
];

export class SkillHarness {
  readonly rig: SkillRig;
  readonly workshop: RigWorkshop;
  readonly model = new ScriptedModel();
  readonly #gates: Gate[] = [];

  readonly strings: UiStrings;

  constructor(strings: UiStrings, rig?: SkillRig) {
    this.strings = strings;
    this.rig = rig ?? new SkillRig();
    this.workshop = new RigWorkshop(this.rig.real);
  }

  readonly source = (): UiStrings => this.strings;

  library(workshop = this.workshop, draftSource?: () => readonly SkillDraftMessage[]): SkillLibraryViewModel {
    return new SkillLibraryViewModel({ workshop, files: this.rig.files, model: this.model, strings: this.source, draftSource });
  }

  gate(): Gate {
    const gate = new Gate();
    this.#gates.push(gate);
    return gate;
  }

  dispose(): void {
    for (const gate of this.#gates) gate.open();
    this.workshop.list_gate?.open();
  }
}

export async function reachLibrary(state: LibraryState, strings: UiStrings): Promise<{ h: SkillHarness; library: SkillLibraryViewModel }> {
  if (state === "empty") {
    const h = new SkillHarness(strings, new SkillRig({ bundled: [] }));
    const library = h.library();
    await library.refresh();
    return { h, library };
  }
  const h = new SkillHarness(strings);
  if (state === "failed") {
    const library = h.library(new ThrowingWorkshop() as never);
    await library.refresh();
    return { h, library };
  }
  if (state === "loading") {
    h.workshop.list_gate = h.gate();
    const library = h.library();
    void library.refresh();
    await flush();
    return { h, library };
  }
  await h.rig.workshop.save(doc());
  const library = h.library();
  await library.refresh();
  const own = library.rows.find((r) => r.name === "contract-review")!;
  switch (state) {
    case "confirmDelete":
      library.askDelete(own);
      break;
    case "importOk":
      await library.importFrom(await zipOf("nda-review.zip", ["SKILL.md", GOOD_SKILL_MD.replace("contract-review", "nda-review")]));
      break;
    case "importReplaces":
      await library.importFrom(await zipOf("good.zip", ["SKILL.md", GOOD_SKILL_MD]));
      break;
    case "importRefused":
      await library.importFrom({ name: "junk.zip", bytes: new Uint8Array([1, 2, 3]) });
      break;
    case "message":
      await library.export(own);
      break;
    default:
      break;
  }
  return { h, library };
}

export async function reachEditor(state: EditorState, strings: UiStrings): Promise<{ h: SkillHarness; library: SkillLibraryViewModel; editor: SkillEditorViewModel }> {
  const h = new SkillHarness(strings);
  if (state === "unknownKeys") h.rig.store.putRaw({ name: "extra-key", description: "Has a stray field.", body: "Body", version: 2 });
  if (state === "edit" || state === "resources" || state === "replace" || state === "tested" || state === "answered" || state === "saveFailed") {
    await h.rig.workshop.save(doc("contract-review", "Reviews a contract clause by clause.", state === "resources" ? { resources: [textFile("notes/checklist.md", "# Checklist\n- liability\n")] } : {}));
  }
  const library = h.library();
  await library.refresh();
  const row = (name: string) => library.rows.find((r) => r.name === name);
  let editor: SkillEditorViewModel;
  switch (state) {
    case "edit":
    case "resources":
    case "tested":
    case "answered":
    case "saveFailed":
      await library.edit(row("contract-review"));
      editor = library.editor!;
      break;
    case "view":
      await library.edit(row("slide-design"));
      editor = library.editor!;
      break;
    case "unknownKeys":
      await library.edit(row("extra-key"));
      editor = library.editor!;
      break;
    case "proposal": {
      const model = new ScriptedModel().says(GOOD_ANSWER);
      const draft = new SkillDraftViewModel({ workshop: h.workshop, model, conversation: () => CHAT, strings: h.source });
      await draft.draft();
      editor = draft.proposal!;
      library.openEditor(editor);
      break;
    }
    default:
      library.newSkill();
      editor = library.editor!;
  }
  switch (state) {
    case "newValid":
      editor.name = "contract-review";
      editor.description = "Reviews a contract clause by clause.";
      editor.instructions = "## Goal\nReview the contract.\n";
      break;
    case "newWarning":
      editor.name = "contract-review";
      editor.description = "Reviews a contract clause by clause.";
      break;
    case "replace":
      editor.name = "contract-review";
      editor.description = "Another one.";
      await editor.save();
      break;
    case "tested":
      editor.testPrompt = "Please review this contract clause";
      await editor.runTest();
      break;
    case "answered":
      h.model.loads("contract-review");
      editor.testPrompt = "Please review this contract clause";
      await editor.askModel();
      break;
    case "saveFailed":
      editor.name = "contract-review-2";
      h.workshop.failSave = true;
      await editor.save();
      break;
    default:
      break;
  }
  return { h, library, editor };
}

export async function reachDraft(state: DraftState, strings: UiStrings): Promise<{ h: SkillHarness; library: SkillLibraryViewModel; draft: SkillDraftViewModel }> {
  const h = new SkillHarness(strings);
  const library = h.library();
  const model = state === "noModel" ? undefined : new ScriptedModel();
  const gate = h.gate();
  switch (state) {
    case "working": model!.reply(() => gate.promise.then(() => [])); break;
    case "ready": model!.says(GOOD_ANSWER); break;
    case "readyWithProblems": model!.says("---\nname: contract-review\n---\nBody"); break;
    case "failed": model!.throws(); break;
    case "unreadable": model!.says(""); break;
    default: break;
  }
  const draft = new SkillDraftViewModel({
    workshop: h.workshop, model, conversation: () => (state === "noChat" ? [] : CHAT), files: h.rig.files, strings: h.source,
  });
  if (state !== "idle") {
    const run = draft.draft();
    if (state !== "working") await run;
    else await flush();
  }
  return { h, library, draft };
}
