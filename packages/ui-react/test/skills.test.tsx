// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SkillDraftViewModel,
  SkillEditorMode,
  SkillLibraryViewModel,
  englishStrings,
  germanStrings,
  type SkillEditorViewModel,
  type SkillFileHost,
  type UiStrings,
} from "@fadenstack/ui";
import { SkillDraft, SkillEditor, SkillLibrary } from "@fadenstack/ui-react";
import { browserSkillFiles } from "@fadenstack/ui-web";

import { ScriptedModel, SkillRig, doc, makeZip, textFile, waitUntil } from "../../ui/test/skillFakes.js";
import {
  CHAT,
  DRAFT_STATES,
  EDITOR_STATES,
  GOOD_ANSWER,
  GOOD_SKILL_MD,
  LIBRARY_STATES,
  SkillHarness,
  reachDraft,
  reachEditor,
  reachLibrary,
} from "./skillHarness.js";

// The skill library, editor and draft views of the React skin, over the real view models on the real in-memory workshop.

const harnesses: SkillHarness[] = [];
afterEach(() => {
  cleanup();
  for (const h of harnesses.splice(0)) h.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const languages: readonly [string, UiStrings][] = [["English", englishStrings], ["German", germanStrings]];

async function library(state: Parameters<typeof reachLibrary>[0], strings: UiStrings = englishStrings) {
  const made = await reachLibrary(state, strings);
  harnesses.push(made.h);
  return made;
}
async function editorAt(state: Parameters<typeof reachEditor>[0], strings: UiStrings = englishStrings) {
  const made = await reachEditor(state, strings);
  harnesses.push(made.h);
  return made;
}
async function draftAt(state: Parameters<typeof reachDraft>[0], strings: UiStrings = englishStrings) {
  const made = await reachDraft(state, strings);
  harnesses.push(made.h);
  return made;
}

const drawLibrary = (h: SkillHarness, vm: SkillLibraryViewModel) => render(<SkillLibrary library={vm} strings={h.source} />);
const drawEditor = (h: SkillHarness, vm: SkillEditorViewModel) => render(<SkillEditor editor={vm} strings={h.source} />);
const drawDraft = (h: SkillHarness, vm: SkillDraftViewModel, onOpenProposal?: (e: SkillEditorViewModel) => void) =>
  render(<SkillDraft draft={vm} strings={h.source} onOpenProposal={onOpenProposal} />);

const column = (container: HTMLElement) => container.querySelector<HTMLElement>(".fdn-wizard-column")!;
const rowOf = (container: HTMLElement, name: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>(".fdn-skills-row")].find((r) => r.querySelector(".fdn-skills-name")?.textContent === name);
  if (!found) throw new Error(`no row ${name}`);
  return found;
};

/** A click whose command answers later: the answer is let through inside act. */
async function press(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function settle(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** Every input has a label and every button a name. */
function expectNamed(container: HTMLElement): void {
  for (const field of container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")) {
    expect(field.labels?.length ?? 0, `a label for ${field.outerHTML}`).toBeGreaterThan(0);
  }
  for (const button of container.querySelectorAll("button")) {
    const name = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
    expect(name.length, `a name for ${button.outerHTML}`).toBeGreaterThan(0);
  }
}

describe("the skill views: every state renders", () => {
  describe.each(languages)("in %s", (_name, strings) => {
    it.each(LIBRARY_STATES)("SkillLibrary: %s", async (state) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { h, library: vm } = await library(state, strings);
      const { container } = drawLibrary(h, vm);
      expect(container.querySelector(".fdn-skills")!.getAttribute("lang")).toBe(strings.language);
      expect(column(container).textContent!.trim().length).toBeGreaterThan(0);
      expect(container.querySelector("h2")!.textContent).toBe(strings.skillLibraryTitle);
      expect(column(container).getAttribute("aria-busy")).toBe(String(vm.isLoading));
      expectNamed(container);
      expect(error).not.toHaveBeenCalled();
    });

    it.each(EDITOR_STATES)("SkillEditor: %s", async (state) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { h, editor } = await editorAt(state, strings);
      const { container } = drawEditor(h, editor);
      expect(container.querySelector(".fdn-skills")!.getAttribute("lang")).toBe(strings.language);
      expect(container.querySelector("h2")!.textContent).toBe(editor.heading);
      expect(column(container).getAttribute("aria-busy")).toBe(String(editor.isSaving));
      expectNamed(container);
      // Save is what the view model allows; a bundled skill has none.
      const save = screen.queryByRole("button", { name: strings.skillSave }) as HTMLButtonElement | null;
      if (editor.isReadOnly) expect(save).toBeNull();
      else expect(save!.disabled).toBe(!editor.canSave);
      expect(error).not.toHaveBeenCalled();
    });

    it.each(DRAFT_STATES)("SkillDraft: %s", async (state) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { h, draft } = await draftAt(state, strings);
      const { container } = drawDraft(h, draft);
      expect(container.querySelector(".fdn-skills")!.getAttribute("lang")).toBe(strings.language);
      expect(container.querySelector("h2")!.textContent).toBe(strings.skillDraftTitle);
      expect(column(container).getAttribute("aria-busy")).toBe(String(draft.isWorking));
      if (draft.statusText) expect(screen.getByText(draft.statusText)).toBeTruthy();
      expectNamed(container);
      expect(error).not.toHaveBeenCalled();
    });
  });
});

describe("SkillLibrary", () => {
  it("lists the skills with where each comes from, 'not reviewed' for the person's own, and a switch where it may be switched", async () => {
    const rig = new SkillRig({ organisation: async () => [{ id: "o", slug: "org-policy", name: "Org policy", description: "From the server.", activation: "auto" }] });
    const h = new SkillHarness(englishStrings, rig);
    harnesses.push(h);
    await rig.workshop.save(doc());
    const vm = h.library();
    await vm.refresh();
    const { container } = drawLibrary(h, vm);
    const s = englishStrings;

    const bundled = rowOf(container, "slide-design");
    expect(within(bundled).getByText(s.skillOriginBundled)).toBeTruthy();
    expect(within(bundled).queryByText(s.skillNotReviewed)).toBeNull();
    expect(within(bundled).getByRole("button", { name: s.skillView })).toBeTruthy();
    expect(within(bundled).queryByRole("button", { name: s.skillDelete })).toBeNull();
    expect(within(bundled).getByRole("switch", { name: "slide-design" })).toBeTruthy();

    const own = rowOf(container, "contract-review");
    expect(within(own).getByText(s.skillOriginOwn)).toBeTruthy();
    expect(within(own).getByText(s.skillNotReviewed)).toBeTruthy();
    for (const name of [s.skillEdit, s.skillDuplicate, s.skillExport, s.skillDelete]) expect(within(own).getByRole("button", { name })).toBeTruthy();

    const org = rowOf(container, "org-policy");
    expect(within(org).getByText(s.skillOriginOrganisation)).toBeTruthy();
    expect(within(org).queryByRole("switch")).toBeNull();
    expect(within(org).queryAllByRole("button")).toHaveLength(0); // no text to open, nothing to export or delete
  });

  it("says when the list is empty, being read, or could not be read", async () => {
    const empty = await library("empty");
    drawLibrary(empty.h, empty.library);
    expect(screen.getByRole("status").textContent).toBe(englishStrings.skillLibraryEmpty);
    cleanup();

    const loading = await library("loading");
    drawLibrary(loading.h, loading.library);
    expect(screen.getByText(englishStrings.skillLibraryLoading)).toBeTruthy();
    expect(column(document.body).getAttribute("aria-busy")).toBe("true");
    cleanup();

    const failed = await library("failed");
    drawLibrary(failed.h, failed.library);
    expect(screen.getByRole("alert").textContent).toBe(englishStrings.skillLibraryFailed);
  });

  it("switches a skill on and off", async () => {
    const { h, library: vm } = await library("list");
    const { container } = drawLibrary(h, vm);
    const toggle = within(rowOf(container, "contract-review")).getByRole("switch") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await press(toggle);
    expect(vm.rows.find((r) => r.name === "contract-review")!.isEnabled).toBe(false);
    expect((within(rowOf(container, "contract-review")).getByRole("switch") as HTMLInputElement).checked).toBe(false);
    expect(within(rowOf(container, "contract-review")).getByText(englishStrings.skillOff)).toBeTruthy();
  });

  it("opens New, Edit and View in place of the list, and the list comes back on Cancel", async () => {
    const { h, library: vm } = await library("list");
    const { container } = drawLibrary(h, vm);
    await press(screen.getByRole("button", { name: englishStrings.skillNew }));
    expect(vm.editor!.mode).toBe(SkillEditorMode.New);
    expect(screen.getByRole("heading", { level: 2, name: englishStrings.skillNew })).toBeTruthy();
    expect(screen.queryByRole("button", { name: englishStrings.skillImport })).toBeNull();
    await press(screen.getByRole("button", { name: englishStrings.skillCancel }));
    expect(vm.editor).toBeUndefined();

    await press(within(rowOf(container, "slide-design")).getByRole("button", { name: englishStrings.skillView }));
    expect(vm.editor!.mode).toBe(SkillEditorMode.View);
    expect((screen.getByLabelText(englishStrings.skillName) as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: englishStrings.skillSave })).toBeNull();
    await press(screen.getByRole("button", { name: englishStrings.skillCancel }));

    await press(within(rowOf(container, "contract-review")).getByRole("button", { name: englishStrings.skillEdit }));
    expect(vm.editor!.mode).toBe(SkillEditorMode.Edit);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(englishStrings.skillEditorEditing("contract-review"));
  });

  it("duplicates a skill into an editor that has written nothing", async () => {
    const { h, library: vm } = await library("list");
    const { container } = drawLibrary(h, vm);
    await press(within(rowOf(container, "contract-review")).getByRole("button", { name: englishStrings.skillDuplicate }));
    expect(vm.editor!.mode).toBe(SkillEditorMode.New);
    expect((screen.getByLabelText(englishStrings.skillName) as HTMLInputElement).value).toBe("contract-review-copy");
    expect(h.workshop.saves).toBe(0);
  });

  it("asks before deleting, with Cancel focused, and deletes only on Delete", async () => {
    const { h, library: vm } = await library("list");
    const { container } = drawLibrary(h, vm);
    fireEvent.click(within(rowOf(container, "contract-review")).getByRole("button", { name: englishStrings.skillDelete }));
    await act(() => Promise.resolve());
    expect(vm.pendingDelete?.name).toBe("contract-review");
    expect(screen.getByRole("alert").textContent).toBe(englishStrings.skillDeleteTitle("contract-review"));
    expect(screen.getByText(englishStrings.skillDeleteBody)).toBeTruthy();
    const group = screen.getByRole("group", { name: englishStrings.skillDeleteTitle("contract-review") });
    expect(document.activeElement).toBe(within(group).getByRole("button", { name: englishStrings.skillCancel }));
    expect(h.workshop.deletes).toBe(0);

    fireEvent.keyDown(column(container), { key: "Escape" }); // Escape says no
    await act(() => Promise.resolve());
    expect(vm.pendingDelete).toBeUndefined();
    expect(h.workshop.deletes).toBe(0);

    fireEvent.click(within(rowOf(container, "contract-review")).getByRole("button", { name: englishStrings.skillDelete }));
    await act(() => Promise.resolve());
    await press(within(screen.getByRole("group")).getByRole("button", { name: englishStrings.skillDelete }));
    expect(h.workshop.deletes).toBe(1);
    expect(vm.rows.some((r) => r.name === "contract-review")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe(englishStrings.skillDeleted("contract-review"));
  });

  it("shows what an import found, writes nothing until Import, and says Replace for a skill of the same name", async () => {
    const ok = await library("importOk");
    drawLibrary(ok.h, ok.library);
    expect(screen.getByRole("alert").textContent).toBe(englishStrings.skillImportTitle("nda-review"));
    expect(screen.getByText(englishStrings.skillImportBody)).toBeTruthy();
    expect(ok.h.workshop.commits).toBe(0);
    const importButton = within(screen.getByRole("group")).getByRole("button", { name: englishStrings.skillImport }) as HTMLButtonElement;
    expect(importButton.type).toBe("submit"); // Enter in the form presses it
    expect(document.activeElement).toBe(importButton);
    fireEvent.submit(importButton.closest("form")!);
    await settle();
    expect(ok.h.workshop.commits).toBe(1);
    expect(screen.getByRole("status").textContent).toBe(englishStrings.skillImported("nda-review"));
    cleanup();

    const replace = await library("importReplaces");
    drawLibrary(replace.h, replace.library);
    expect(screen.getByText(englishStrings.skillImportReplaceBody("contract-review"))).toBeTruthy();
    expect(screen.getByRole("button", { name: englishStrings.skillReplace })).toBeTruthy();
    cleanup();

    const refused = await library("importRefused");
    drawLibrary(refused.h, refused.library);
    expect(screen.getByText(englishStrings.skillImportRefused, { selector: "p" })).toBeTruthy();
    expect(within(screen.getByRole("group")).queryByRole("button", { name: englishStrings.skillImport })).toBeNull();
    expect(refused.library.importIssues.length).toBeGreaterThan(0);
    for (const issue of refused.library.importIssues) expect(screen.getByText(issue.text)).toBeTruthy();
    fireEvent.keyDown(column(document.body), { key: "Escape" });
    await act(() => Promise.resolve());
    expect(refused.library.pendingImport).toBeUndefined();
    expect(refused.h.workshop.commits).toBe(0);
  });

  it("imports through a zip file input: the bytes reach the view model, which waits for Import", async () => {
    const { h, library: vm } = await library("list");
    const { container } = drawLibrary(h, vm);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe(".zip");
    expect(input.labels?.length).toBeGreaterThan(0);
    const clicked = vi.spyOn(input, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: englishStrings.skillImport }));
    expect(clicked).toHaveBeenCalledTimes(1); // inside the click: the picker needs the gesture

    const bytes = await makeZip(["SKILL.md", GOOD_SKILL_MD.replace("contract-review", "nda-review")]);
    const importFrom = vi.spyOn(vm, "importFrom");
    fireEvent.change(input, { target: { files: [new File([bytes as BlobPart], "nda.zip", { type: "application/zip" })] } });
    await act(async () => { await waitUntil(() => vm.pendingImport !== undefined); });
    expect(importFrom).toHaveBeenCalledTimes(1);
    expect(importFrom.mock.calls[0]![0].name).toBe("nda.zip");
    expect([...importFrom.mock.calls[0]![0].bytes]).toEqual([...bytes]);
    expect(vm.pendingImport!.document!.name).toBe("nda-review");
    expect(h.workshop.commits).toBe(0);
    expect(screen.getByRole("alert").textContent).toBe(englishStrings.skillImportTitle("nda-review"));
  });

  it("exports a skill as a zip download through the platform's link", async () => {
    const h = new SkillHarness(englishStrings);
    harnesses.push(h);
    await h.rig.workshop.save(doc());
    const created: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: (blob: Blob) => { created.push(blob); return "blob:skill"; },
      revokeObjectURL: () => undefined,
    }));
    const links: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      links.push({ href: this.href, download: this.download });
    });
    const vm = new SkillLibraryViewModel({ workshop: h.workshop, files: browserSkillFiles() as SkillFileHost, strings: h.source });
    await vm.refresh();
    const { container } = drawLibrary(h, vm);
    await press(within(rowOf(container, "contract-review")).getByRole("button", { name: englishStrings.skillExport }));
    await act(async () => { await waitUntil(() => links.length > 0); });
    expect(links).toEqual([{ href: "blob:skill", download: "contract-review.zip" }]);
    expect(created[0]!.type).toBe("application/zip");
    expect(created[0]!.size).toBeGreaterThan(0);
    expect(screen.getByRole("status").textContent).toBe(englishStrings.skillExported("contract-review"));
    expect(h.workshop.saves).toBe(0);
  });

  it("gives the first focus to New, and back to it when an editor closes", async () => {
    const { h, library: vm } = await library("list");
    drawLibrary(h, vm);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: englishStrings.skillNew }));
    await press(screen.getByRole("button", { name: englishStrings.skillNew }));
    expect(document.activeElement).toBe(screen.getByLabelText(englishStrings.skillName));
    await press(screen.getByRole("button", { name: englishStrings.skillCancel }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: englishStrings.skillNew }));
  });
});

describe("SkillEditor", () => {
  it("shows the name and description checks as one types, and Save follows what the view model allows", async () => {
    const { h, editor } = await editorAt("new");
    drawEditor(h, editor);
    const name = screen.getByLabelText(englishStrings.skillName) as HTMLInputElement;
    const save = screen.getByRole("button", { name: englishStrings.skillSave }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const describedBy = name.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)!.textContent).toBe(editor.issues.find((i) => i.subject === "name")!.text);

    fireEvent.change(name, { target: { value: "Not A Valid Name" } });
    expect(editor.name).toBe("Not A Valid Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(name, { target: { value: "contract-review" } });
    expect(name.getAttribute("aria-invalid")).toBeNull();
    expect(name.getAttribute("aria-describedby")).toBeNull();
    fireEvent.change(screen.getByLabelText(englishStrings.skillDescription), { target: { value: "Reviews a contract clause by clause." } });
    expect(editor.canSave).toBe(true);
    expect(save.disabled).toBe(false);
  });

  it("lists a warning in the checks without stopping Save", async () => {
    const { h, editor } = await editorAt("newWarning");
    drawEditor(h, editor);
    expect(editor.hasErrors).toBe(false);
    expect(editor.hasIssues).toBe(true);
    expect(screen.getAllByText(editor.issues[0]!.text, { selector: "li" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(englishStrings.skillChecksOk)).toBeNull();
    expect(document.querySelectorAll(".fdn-skills-issue-error")).toHaveLength(0);
    expect((screen.getByRole("button", { name: englishStrings.skillSave }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says all checks pass when there is nothing to report", async () => {
    const { h, editor } = await editorAt("newValid");
    drawEditor(h, editor);
    expect(editor.hasIssues).toBe(false);
    expect(screen.getByText(englishStrings.skillChecksOk)).toBeTruthy();
  });

  it("draws every field of the faden.yaml and the activation as a labelled select", async () => {
    const { h, editor } = await editorAt("edit");
    drawEditor(h, editor);
    const s = englishStrings;
    for (const label of [s.skillTitleField, s.skillKeywords, s.skillTags, s.skillFileTypes, s.skillPreferredTools, s.skillPriority, s.skillLicense, s.skillCompatibility]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText(s.skillKeywords), { target: { value: "contract, clause" } });
    expect(editor.keywordsText).toBe("contract, clause");
    fireEvent.change(screen.getByLabelText(s.skillPriority), { target: { value: "80" } });
    expect(editor.priority).toBe(80);
    const select = screen.getByLabelText(s.skillActivation) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["auto", "always", "manual"]);
    expect([...select.options].map((o) => o.textContent)).toEqual([s.skillActivationAuto, s.skillActivationAlways, s.skillActivationManual]);
    fireEvent.change(select, { target: { value: "manual" } });
    expect(editor.activation).toBe("manual");
  });

  it("previews the instructions with the chat's Markdown, as elements and never as HTML", async () => {
    const { h, editor } = await editorAt("newValid");
    const { container } = drawEditor(h, editor);
    expect(container.querySelector(".fdn-md")).toBeNull();
    fireEvent.change(screen.getByLabelText(englishStrings.skillInstructions), { target: { value: "## Goal\nReview <b>this</b>.\n\n- one\n- two" } });
    fireEvent.click(screen.getByLabelText(englishStrings.skillPreview));
    expect(editor.showPreview).toBe(true);
    const preview = screen.getByRole("region", { name: englishStrings.skillPreview });
    expect(preview.querySelector(".fdn-md")).toBeTruthy();
    expect(preview.querySelector("h2, h3, h4")!.textContent).toBe("Goal");
    expect(preview.querySelectorAll("li")).toHaveLength(2);
    expect(preview.querySelector("b")).toBeNull();
    expect(preview.textContent).toContain("<b>this</b>");
  });

  it("makes every field read-only for a bundled skill, and offers no file to add", async () => {
    const { h, editor } = await editorAt("view");
    const { container } = drawEditor(h, editor);
    for (const field of container.querySelector("form")!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[type=text], input[type=number], textarea")) {
      expect(field.readOnly, field.outerHTML).toBe(true);
    }
    expect((screen.getByLabelText(englishStrings.skillActivation) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: englishStrings.skillAddFile })).toBeNull();
    expect(screen.getByText(editor.heading)).toBeTruthy();
    const before = editor.name;
    fireEvent.change(screen.getByLabelText(englishStrings.skillName), { target: { value: "other" } });
    expect(editor.name).toBe(before);
  });

  it("draws the files with rename and remove, and the extra fields with their button", async () => {
    const resources = await editorAt("resources");
    drawEditor(resources.h, resources.editor);
    expect(screen.getByText("notes/checklist.md", { selector: ".fdn-skills-name" })).toBeTruthy();
    const input = screen.getByLabelText(`${englishStrings.skillRenameFile}: notes/checklist.md`) as HTMLInputElement;
    const rename = screen.getByRole("button", { name: englishStrings.skillRenameFile }) as HTMLButtonElement;
    expect(rename.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "notes/list.md" } });
    expect(rename.disabled).toBe(false);
    fireEvent.submit(input.closest("form")!); // Enter renames; it does not save the skill
    expect(resources.editor.resources[0]!.path).toBe("notes/list.md");
    expect(resources.h.workshop.saves).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: englishStrings.skillRemoveFile }));
    expect(resources.editor.hasResources).toBe(false);
    expect(screen.getByText(englishStrings.skillNoResources)).toBeTruthy();
    cleanup();

    const unknown = await editorAt("unknownKeys");
    drawEditor(unknown.h, unknown.editor);
    expect((screen.getByRole("button", { name: englishStrings.skillSave }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: englishStrings.skillDropUnknownKeys }));
    expect(unknown.editor.hasUnknownKeys).toBe(false);
    expect(screen.queryByRole("button", { name: englishStrings.skillDropUnknownKeys })).toBeNull();
  });

  it("writes nothing but by Save: typing, the preview, the test, the model question and a file added do not", async () => {
    const { h, library: vm, editor } = await editorAt("new");
    h.model.loads("contract-review");
    h.rig.files.resource = textFile("notes.md", "Some notes.");
    drawLibrary(h, vm);
    fireEvent.change(screen.getByLabelText(englishStrings.skillName), { target: { value: "contract-review" } });
    fireEvent.change(screen.getByLabelText(englishStrings.skillDescription), { target: { value: "Reviews a contract clause by clause." } });
    fireEvent.change(screen.getByLabelText(englishStrings.skillInstructions), { target: { value: "## Goal\nReview." } });
    fireEvent.click(screen.getByLabelText(englishStrings.skillPreview));
    fireEvent.change(screen.getByLabelText(englishStrings.skillTestPrompt), { target: { value: "review this contract clause" } });
    await press(screen.getByRole("button", { name: englishStrings.skillTestRun }));
    await press(screen.getByRole("button", { name: englishStrings.skillAskModel }));
    await press(screen.getByRole("button", { name: englishStrings.skillAddFile }));
    expect(editor.resources.map((r) => r.path)).toEqual(["notes.md"]);
    expect(h.workshop.saves).toBe(0);
    expect(await h.rig.isEmpty()).toBe(true);

    await press(screen.getByRole("button", { name: englishStrings.skillSave }));
    await act(async () => { await waitUntil(() => vm.editor === undefined); });
    expect(h.workshop.saves).toBe(1);
    expect(await h.rig.onDisk("contract-review")).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(englishStrings.skillSaved("contract-review"));
  });

  it("saves with Enter in a field (a form), and Cancel and Escape close it without saving", async () => {
    const { h, editor } = await editorAt("newValid");
    const closed = vi.fn();
    editor.onClosed(closed);
    const { container } = drawEditor(h, editor);
    const form = screen.getByLabelText(englishStrings.skillName).closest("form")!;
    const save = screen.getByRole("button", { name: englishStrings.skillSave }) as HTMLButtonElement;
    expect(save.form).toBe(form);
    expect(save.type).toBe("submit");
    fireEvent.keyDown(column(container), { key: "Escape" });
    expect(closed).toHaveBeenCalledWith({ saved: false, name: undefined });
    expect(h.workshop.saves).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: englishStrings.skillCancel }));
    expect(closed).toHaveBeenCalledTimes(2);

    fireEvent.submit(form);
    await settle();
    expect(h.workshop.saves).toBe(1);
    expect(closed).toHaveBeenLastCalledWith({ saved: true, name: "contract-review" });
  });

  it("asks before replacing, with Cancel focused; Escape says no, and Replace writes", async () => {
    const { h, editor } = await editorAt("replace");
    const closed = vi.fn();
    editor.onClosed(closed);
    const { container } = drawEditor(h, editor);
    expect(editor.needsReplaceConfirmation).toBe(true);
    const group = screen.getByRole("group", { name: editor.replaceTitle });
    expect(within(group).getByText(editor.replaceBody)).toBeTruthy();
    expect(document.activeElement).toBe(within(group).getByRole("button", { name: englishStrings.skillCancel }));
    fireEvent.keyDown(column(container), { key: "Escape" });
    expect(editor.needsReplaceConfirmation).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText(englishStrings.skillName));

    await press(screen.getByRole("button", { name: englishStrings.skillSave }));
    await press(within(screen.getByRole("group")).getByRole("button", { name: englishStrings.skillReplace }));
    expect(closed).toHaveBeenCalledWith({ saved: true, name: "contract-review" });
  });

  it("says in an alert that the skill could not be written, and what a proposal is", async () => {
    const failed = await editorAt("saveFailed");
    drawEditor(failed.h, failed.editor);
    expect(screen.getByRole("alert").textContent).toBe(englishStrings.skillSaveFailed);
    cleanup();

    const proposal = await editorAt("proposal");
    drawEditor(proposal.h, proposal.editor);
    expect(screen.getByText(englishStrings.skillEditorProposal)).toBeTruthy();
    expect(proposal.h.workshop.saves).toBe(0);
  });

  it("runs the test with Enter in its field and shows what the pre-selection says", async () => {
    const { h, editor } = await editorAt("edit");
    drawEditor(h, editor);
    const prompt = screen.getByLabelText(englishStrings.skillTestPrompt) as HTMLInputElement;
    expect(screen.getByRole("button", { name: englishStrings.skillTestRun }).getAttribute("type")).toBe("submit");
    fireEvent.change(prompt, { target: { value: "Please review this contract clause" } });
    fireEvent.submit(prompt.closest("form")!);
    await settle();
    expect(editor.hasTestResult).toBe(true);
    for (const line of editor.testMatches) expect(screen.getByText(line)).toBeTruthy();
    for (const name of editor.testListed) expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    expect(h.workshop.saves).toBe(0);
  });

  it("says the model's answer in a polite status, without an assertive or ticking region", async () => {
    const { h, editor } = await editorAt("answered");
    drawEditor(h, editor);
    expect(editor.modelAnswerText.length).toBeGreaterThan(0);
    const status = screen.getAllByRole("status").find((r) => r.textContent!.includes(editor.modelAnswerText));
    expect(status).toBeTruthy();
    expect(screen.getByText(englishStrings.skillModelNote)).toBeTruthy();
    expect(h.model.calls).toHaveLength(1);
    expect(document.querySelectorAll('[aria-live="assertive"], [role="timer"]')).toHaveLength(0);
  });

  it("puts the focus on the first field, also when it is read-only", async () => {
    const fresh = await editorAt("new");
    drawEditor(fresh.h, fresh.editor);
    expect(document.activeElement).toBe(screen.getByLabelText(englishStrings.skillName));
    cleanup();
    const view = await editorAt("view");
    drawEditor(view.h, view.editor);
    expect(document.activeElement).toBe(screen.getByLabelText(englishStrings.skillName));
  });
});

describe("SkillDraft", () => {
  it("puts the focus in the guidance field, and Enter in it writes the draft", async () => {
    const h = new SkillHarness(englishStrings);
    harnesses.push(h);
    const model = new ScriptedModel().says(GOOD_ANSWER);
    const made = new SkillDraftViewModel({ workshop: h.workshop, model, conversation: () => CHAT, strings: h.source });
    drawDraft(h, made);
    const field = screen.getByLabelText(englishStrings.skillDraftGuidance) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "Always flag liability caps." } });
    expect(made.guidance).toBe("Always flag liability caps.");
    expect(screen.getByRole("button", { name: englishStrings.skillDraftStart }).getAttribute("type")).toBe("submit");
    fireEvent.submit(field.closest("form")!);
    await settle();
    expect(model.calls).toHaveLength(1);
    expect(String(model.calls[0]!.messages[1]!.content)).toContain("Always flag liability caps.");
    expect(made.proposal).toBeDefined();
    expect(h.workshop.saves).toBe(0);
  });

  it("says in words that nothing is saved until Save, and offers the proposal's editor only when the app gave a way to it", async () => {
    const { h, draft } = await draftAt("ready");
    const open = vi.fn();
    drawDraft(h, draft, open);
    expect(screen.getByText(englishStrings.skillDraftReady)).toBeTruthy();
    expect(screen.getByText(englishStrings.skillEditorProposal)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: englishStrings.skillEdit }));
    expect(open).toHaveBeenCalledWith(draft.proposal);
    expect(h.workshop.saves).toBe(0);
    cleanup();
    drawDraft(h, draft);
    expect(screen.queryByRole("button", { name: englishStrings.skillEdit })).toBeNull();
  });

  it("marks the state: working is busy and Escape stops it, failed and unreadable are alerts, the others statuses", async () => {
    const working = await draftAt("working");
    const { container } = drawDraft(working.h, working.draft);
    expect(column(container).getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: englishStrings.skillDraftStart }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(englishStrings.skillDraftWorking);
    fireEvent.keyDown(column(container), { key: "Escape" });
    await act(() => Promise.resolve());
    expect(working.draft.isWorking).toBe(false);
    cleanup();

    for (const [state, text] of [["failed", englishStrings.skillDraftFailed], ["unreadable", englishStrings.skillDraftUnreadable]] as const) {
      const made = await draftAt(state);
      drawDraft(made.h, made.draft);
      expect(screen.getByRole("alert").textContent).toBe(text);
      cleanup();
    }
    for (const [state, text] of [["noChat", englishStrings.skillDraftNoChat], ["noModel", englishStrings.skillDraftNoModel], ["readyWithProblems", englishStrings.skillDraftBroken]] as const) {
      const made = await draftAt(state);
      drawDraft(made.h, made.draft);
      expect(screen.getByRole("status").textContent).toBe(text);
      cleanup();
    }
  });
});
