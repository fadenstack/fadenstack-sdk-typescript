// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
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
import { SkillDraft, SkillEditor, SkillLibrary } from "@fadenstack/ui-vue";
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
} from "../../ui-react/test/skillHarness.js";

// The same checks as @fadenstack/ui-react's skills.test.tsx, on the Vue skin (parity), against real view models on the real workshop.

let wrappers: VueWrapper[] = [];
const harnesses: SkillHarness[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
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

function keep<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper);
  return wrapper;
}
const drawLibrary = (h: SkillHarness, vm: SkillLibraryViewModel) => keep(mount(SkillLibrary, { props: { library: vm, strings: h.source }, attachTo: document.body }));
const drawEditor = (h: SkillHarness, vm: SkillEditorViewModel) => keep(mount(SkillEditor, { props: { editor: vm, strings: h.source }, attachTo: document.body }));
const drawDraft = (h: SkillHarness, vm: SkillDraftViewModel, onOpenProposal?: (e: SkillEditorViewModel) => void) =>
  keep(mount(SkillDraft, { props: { draft: vm, strings: h.source, ...(onOpenProposal ? { onOpenProposal } : {}) }, attachTo: document.body }));

const column = (w: VueWrapper) => w.get(".fdn-wizard-column");
const nameOf = (b: Element): string => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
const buttons = (root: Element | VueWrapper): HTMLButtonElement[] => [...((root as VueWrapper).element ?? (root as Element)).querySelectorAll("button")];
const maybeButton = (root: Element | VueWrapper, name: string): HTMLButtonElement | undefined => buttons(root).find((b) => nameOf(b) === name);
const button = (root: Element | VueWrapper, name: string): HTMLButtonElement => {
  const found = maybeButton(root, name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
/** The input, textarea or select a label points to. */
const field = (w: VueWrapper | Element, label: string): HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement => {
  const root = (w as VueWrapper).element ?? (w as Element);
  const labelled = [...root.querySelectorAll("label")].find((l) => l.textContent === label);
  if (!labelled) throw new Error(`no label ${label}`);
  return root.querySelector(`[id="${labelled.htmlFor}"]`) as never; // each mounted app numbers its ids from 0
};
const rowOf = (w: VueWrapper, name: string): HTMLElement => {
  const found = [...(w.element as Element).querySelectorAll<HTMLElement>(".fdn-skills-row")].find((r) => r.querySelector(".fdn-skills-name")?.textContent === name);
  if (!found) throw new Error(`no row ${name}`);
  return found;
};
const roleOf = (w: VueWrapper, role: string): HTMLElement[] => [...(w.element as Element).querySelectorAll<HTMLElement>(`[role="${role}"]`)];

async function click(element: Element): Promise<void> {
  (element as HTMLElement).click();
  await flushPromises();
}
async function type(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  element.value = value;
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  await nextTick();
}
async function escape(w: VueWrapper): Promise<void> {
  column(w).element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await flushPromises();
}

/** Every input has a label and every button a name. */
function expectNamed(w: VueWrapper): void {
  for (const f of (w.element as Element).querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")) {
    expect(f.labels?.length ?? 0, `a label for ${f.outerHTML}`).toBeGreaterThan(0);
  }
  for (const b of w.element.querySelectorAll("button")) expect(nameOf(b).length, `a name for ${b.outerHTML}`).toBeGreaterThan(0);
}

describe("the skill views: every state renders", () => {
  describe.each(languages)("in %s", (_name, strings) => {
    it.each(LIBRARY_STATES)("SkillLibrary: %s", async (state) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { h, library: vm } = await library(state, strings);
      const w = drawLibrary(h, vm);
      expect(w.get(".fdn-skills").attributes("lang")).toBe(strings.language);
      expect(column(w).text().length).toBeGreaterThan(0);
      expect(w.get("h2").text()).toBe(strings.skillLibraryTitle);
      expect(column(w).attributes("aria-busy")).toBe(String(vm.isLoading));
      expectNamed(w);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(EDITOR_STATES)("SkillEditor: %s", async (state) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { h, editor } = await editorAt(state, strings);
      const w = drawEditor(h, editor);
      expect(w.get(".fdn-skills").attributes("lang")).toBe(strings.language);
      expect(w.get("h2").text()).toBe(editor.heading);
      expect(column(w).attributes("aria-busy")).toBe(String(editor.isSaving));
      expectNamed(w);
      const save = maybeButton(w, strings.skillSave);
      if (editor.isReadOnly) expect(save).toBeUndefined();
      else expect(save!.disabled).toBe(!editor.canSave);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(DRAFT_STATES)("SkillDraft: %s", async (state) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { h, draft } = await draftAt(state, strings);
      const w = drawDraft(h, draft);
      expect(w.get(".fdn-skills").attributes("lang")).toBe(strings.language);
      expect(w.get("h2").text()).toBe(strings.skillDraftTitle);
      expect(column(w).attributes("aria-busy")).toBe(String(draft.isWorking));
      if (draft.statusText) expect(w.text()).toContain(draft.statusText);
      expectNamed(w);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
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
    const w = drawLibrary(h, vm);
    const s = englishStrings;

    const bundled = rowOf(w, "slide-design");
    expect(bundled.textContent).toContain(s.skillOriginBundled);
    expect(bundled.textContent).not.toContain(s.skillNotReviewed);
    expect(maybeButton(bundled, s.skillView)).toBeTruthy();
    expect(maybeButton(bundled, s.skillDelete)).toBeUndefined();
    expect(bundled.querySelector('[role="switch"]')!.getAttribute("aria-label")).toBe("slide-design");

    const own = rowOf(w, "contract-review");
    expect(own.textContent).toContain(s.skillOriginOwn);
    expect(own.textContent).toContain(s.skillNotReviewed);
    for (const name of [s.skillEdit, s.skillDuplicate, s.skillExport, s.skillDelete]) expect(maybeButton(own, name)).toBeTruthy();

    const org = rowOf(w, "org-policy");
    expect(org.textContent).toContain(s.skillOriginOrganisation);
    expect(org.querySelector('[role="switch"]')).toBeNull();
    expect(org.querySelectorAll("button")).toHaveLength(0);
  });

  it("says when the list is empty, being read, or could not be read", async () => {
    const empty = await library("empty");
    const first = drawLibrary(empty.h, empty.library);
    expect(roleOf(first, "status")[0]!.textContent).toBe(englishStrings.skillLibraryEmpty);
    first.unmount();

    const loading = await library("loading");
    const second = drawLibrary(loading.h, loading.library);
    expect(second.text()).toContain(englishStrings.skillLibraryLoading);
    expect(column(second).attributes("aria-busy")).toBe("true");
    second.unmount();

    const failed = await library("failed");
    const third = drawLibrary(failed.h, failed.library);
    expect(roleOf(third, "alert")[0]!.textContent).toBe(englishStrings.skillLibraryFailed);
  });

  it("switches a skill on and off", async () => {
    const { h, library: vm } = await library("list");
    const w = drawLibrary(h, vm);
    const toggle = () => rowOf(w, "contract-review").querySelector<HTMLInputElement>('[role="switch"]')!;
    expect(toggle().checked).toBe(true);
    await click(toggle());
    expect(vm.rows.find((r) => r.name === "contract-review")!.isEnabled).toBe(false);
    expect(toggle().checked).toBe(false);
    expect(rowOf(w, "contract-review").textContent).toContain(englishStrings.skillOff);
  });

  it("opens New, Edit and View in place of the list, and the list comes back on Cancel", async () => {
    const { h, library: vm } = await library("list");
    const w = drawLibrary(h, vm);
    await click(button(w, englishStrings.skillNew));
    expect(vm.editor!.mode).toBe(SkillEditorMode.New);
    expect(w.get("h2").text()).toBe(englishStrings.skillNew);
    expect(maybeButton(w, englishStrings.skillImport)).toBeUndefined();
    await click(button(w, englishStrings.skillCancel));
    expect(vm.editor).toBeUndefined();

    await click(button(rowOf(w, "slide-design"), englishStrings.skillView));
    expect(vm.editor!.mode).toBe(SkillEditorMode.View);
    expect(field(w, englishStrings.skillName).readOnly).toBe(true);
    expect(maybeButton(w, englishStrings.skillSave)).toBeUndefined();
    await click(button(w, englishStrings.skillCancel));

    await click(button(rowOf(w, "contract-review"), englishStrings.skillEdit));
    expect(vm.editor!.mode).toBe(SkillEditorMode.Edit);
    expect(w.get("h2").text()).toBe(englishStrings.skillEditorEditing("contract-review"));
  });

  it("duplicates a skill into an editor that has written nothing", async () => {
    const { h, library: vm } = await library("list");
    const w = drawLibrary(h, vm);
    await click(button(rowOf(w, "contract-review"), englishStrings.skillDuplicate));
    expect(vm.editor!.mode).toBe(SkillEditorMode.New);
    expect(field(w, englishStrings.skillName).value).toBe("contract-review-copy");
    expect(h.workshop.saves).toBe(0);
  });

  it("asks before deleting, with Cancel focused, and deletes only on Delete", async () => {
    const { h, library: vm } = await library("list");
    const w = drawLibrary(h, vm);
    await click(button(rowOf(w, "contract-review"), englishStrings.skillDelete));
    expect(vm.pendingDelete?.name).toBe("contract-review");
    expect(roleOf(w, "alert")[0]!.textContent).toBe(englishStrings.skillDeleteTitle("contract-review"));
    expect(w.text()).toContain(englishStrings.skillDeleteBody);
    const group = roleOf(w, "group")[0]!;
    expect(group.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.activeElement).toBe(button(group, englishStrings.skillCancel));
    expect(h.workshop.deletes).toBe(0);

    await escape(w); // Escape says no
    expect(vm.pendingDelete).toBeUndefined();
    expect(h.workshop.deletes).toBe(0);

    await click(button(rowOf(w, "contract-review"), englishStrings.skillDelete));
    await click(button(roleOf(w, "group")[0]!, englishStrings.skillDelete));
    expect(h.workshop.deletes).toBe(1);
    expect(vm.rows.some((r) => r.name === "contract-review")).toBe(false);
    expect(roleOf(w, "status")[0]!.textContent).toBe(englishStrings.skillDeleted("contract-review"));
  });

  it("shows what an import found, writes nothing until Import, and says Replace for a skill of the same name", async () => {
    const ok = await library("importOk");
    const first = drawLibrary(ok.h, ok.library);
    expect(roleOf(first, "alert")[0]!.textContent).toBe(englishStrings.skillImportTitle("nda-review"));
    expect(first.text()).toContain(englishStrings.skillImportBody);
    expect(ok.h.workshop.commits).toBe(0);
    const importButton = button(roleOf(first, "group")[0]!, englishStrings.skillImport);
    expect(importButton.type).toBe("submit"); // Enter in the form presses it
    expect(document.activeElement).toBe(importButton);
    await importButton.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(ok.h.workshop.commits).toBe(1);
    expect(roleOf(first, "status")[0]!.textContent).toBe(englishStrings.skillImported("nda-review"));
    first.unmount();

    const replace = await library("importReplaces");
    const second = drawLibrary(replace.h, replace.library);
    expect(second.text()).toContain(englishStrings.skillImportReplaceBody("contract-review"));
    expect(maybeButton(second, englishStrings.skillReplace)).toBeTruthy();
    second.unmount();

    const refused = await library("importRefused");
    const third = drawLibrary(refused.h, refused.library);
    expect(third.text()).toContain(englishStrings.skillImportRefused);
    expect(maybeButton(roleOf(third, "group")[0]!, englishStrings.skillImport)).toBeUndefined();
    expect(refused.library.importIssues.length).toBeGreaterThan(0);
    for (const issue of refused.library.importIssues) expect(third.text()).toContain(issue.text);
    await escape(third);
    expect(refused.library.pendingImport).toBeUndefined();
    expect(refused.h.workshop.commits).toBe(0);
  });

  it("imports through a zip file input: the bytes reach the view model, which waits for Import", async () => {
    const { h, library: vm } = await library("list");
    const w = drawLibrary(h, vm);
    const input = w.get<HTMLInputElement>('input[type="file"]').element;
    expect(input.accept).toBe(".zip");
    expect(input.labels?.length).toBeGreaterThan(0);
    const clicked = vi.spyOn(input, "click").mockImplementation(() => undefined);
    button(w, englishStrings.skillImport).click();
    expect(clicked).toHaveBeenCalledTimes(1); // inside the click: the picker needs the gesture

    const bytes = await makeZip(["SKILL.md", GOOD_SKILL_MD.replace("contract-review", "nda-review")]);
    const importFrom = vi.spyOn(vm, "importFrom");
    Object.defineProperty(input, "files", { configurable: true, value: [new File([bytes as BlobPart], "nda.zip", { type: "application/zip" })] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitUntil(() => vm.pendingImport !== undefined);
    await flushPromises();
    expect(importFrom).toHaveBeenCalledTimes(1);
    expect(importFrom.mock.calls[0]![0].name).toBe("nda.zip");
    expect([...importFrom.mock.calls[0]![0].bytes]).toEqual([...bytes]);
    expect(vm.pendingImport!.document!.name).toBe("nda-review");
    expect(h.workshop.commits).toBe(0);
    expect(roleOf(w, "alert")[0]!.textContent).toBe(englishStrings.skillImportTitle("nda-review"));
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
    const w = drawLibrary(h, vm);
    await click(button(rowOf(w, "contract-review"), englishStrings.skillExport));
    await waitUntil(() => links.length > 0);
    await flushPromises();
    expect(links).toEqual([{ href: "blob:skill", download: "contract-review.zip" }]);
    expect(created[0]!.type).toBe("application/zip");
    expect(created[0]!.size).toBeGreaterThan(0);
    expect(roleOf(w, "status")[0]!.textContent).toBe(englishStrings.skillExported("contract-review"));
    expect(h.workshop.saves).toBe(0);
  });

  it("gives the first focus to New, and back to it when an editor closes", async () => {
    const { h, library: vm } = await library("list");
    const w = drawLibrary(h, vm);
    expect(document.activeElement).toBe(button(w, englishStrings.skillNew));
    await click(button(w, englishStrings.skillNew));
    await nextTick();
    expect(document.activeElement).toBe(field(w, englishStrings.skillName));
    await click(button(w, englishStrings.skillCancel));
    await nextTick();
    expect(document.activeElement).toBe(button(w, englishStrings.skillNew));
  });
});

describe("SkillEditor", () => {
  it("shows the name and description checks as one types, and Save follows what the view model allows", async () => {
    const { h, editor } = await editorAt("new");
    const w = drawEditor(h, editor);
    const name = field(w, englishStrings.skillName);
    const save = button(w, englishStrings.skillSave);
    expect(save.disabled).toBe(true);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const describedBy = name.getAttribute("aria-describedby")!;
    expect(w.element.querySelector(`[id="${describedBy}"]`)!.textContent).toBe(editor.issues.find((i) => i.subject === "name")!.text);

    await type(name, "Not A Valid Name");
    expect(editor.name).toBe("Not A Valid Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    await type(name, "contract-review");
    expect(name.getAttribute("aria-invalid")).toBeNull();
    expect(name.getAttribute("aria-describedby")).toBeNull();
    await type(field(w, englishStrings.skillDescription), "Reviews a contract clause by clause.");
    expect(editor.canSave).toBe(true);
    expect(save.disabled).toBe(false);
  });

  it("lists a warning in the checks without stopping Save", async () => {
    const { h, editor } = await editorAt("newWarning");
    const w = drawEditor(h, editor);
    expect(editor.hasErrors).toBe(false);
    expect(editor.hasIssues).toBe(true);
    expect(w.text()).toContain(editor.issues[0]!.text);
    expect(w.text()).not.toContain(englishStrings.skillChecksOk);
    expect(w.element.querySelectorAll(".fdn-skills-issue-error")).toHaveLength(0);
    expect(button(w, englishStrings.skillSave).disabled).toBe(false);
  });

  it("says all checks pass when there is nothing to report", async () => {
    const { h, editor } = await editorAt("newValid");
    const w = drawEditor(h, editor);
    expect(editor.hasIssues).toBe(false);
    expect(w.text()).toContain(englishStrings.skillChecksOk);
  });

  it("draws every field of the faden.yaml and the activation as a labelled select", async () => {
    const { h, editor } = await editorAt("edit");
    const w = drawEditor(h, editor);
    const s = englishStrings;
    for (const label of [s.skillTitleField, s.skillKeywords, s.skillTags, s.skillFileTypes, s.skillPreferredTools, s.skillPriority, s.skillLicense, s.skillCompatibility]) {
      expect(field(w, label)).toBeTruthy();
    }
    await type(field(w, s.skillKeywords), "contract, clause");
    expect(editor.keywordsText).toBe("contract, clause");
    await type(field(w, s.skillPriority), "80");
    expect(editor.priority).toBe(80);
    const select = field(w, s.skillActivation) as unknown as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["auto", "always", "manual"]);
    expect([...select.options].map((o) => o.textContent)).toEqual([s.skillActivationAuto, s.skillActivationAlways, s.skillActivationManual]);
    await type(select, "manual");
    expect(editor.activation).toBe("manual");
  });

  it("previews the instructions with the chat's Markdown, as elements and never as HTML", async () => {
    const { h, editor } = await editorAt("newValid");
    const w = drawEditor(h, editor);
    expect(w.element.querySelector(".fdn-md")).toBeNull();
    await type(field(w, englishStrings.skillInstructions), "## Goal\nReview <b>this</b>.\n\n- one\n- two");
    const preview = field(w, englishStrings.skillPreview);
    preview.checked = true;
    preview.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(editor.showPreview).toBe(true);
    const region = w.get(`[role="region"][aria-label="${englishStrings.skillPreview}"]`).element;
    expect(region.querySelector(".fdn-md")).toBeTruthy();
    expect(region.querySelector("h2, h3, h4")!.textContent).toBe("Goal");
    expect(region.querySelectorAll("li")).toHaveLength(2);
    expect(region.querySelector("b")).toBeNull();
    expect(region.textContent).toContain("<b>this</b>");
  });

  it("makes every field read-only for a bundled skill, and offers no file to add", async () => {
    const { h, editor } = await editorAt("view");
    const w = drawEditor(h, editor);
    for (const f of w.get("form").element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[type=text], input[type=number], textarea")) {
      expect(f.readOnly, f.outerHTML).toBe(true);
    }
    expect(field(w, englishStrings.skillActivation).disabled).toBe(true);
    expect(maybeButton(w, englishStrings.skillAddFile)).toBeUndefined();
    expect(w.text()).toContain(editor.heading);
    const before = editor.name;
    await type(field(w, englishStrings.skillName), "other");
    expect(editor.name).toBe(before);
  });

  it("draws the files with rename and remove, and the extra fields with their button", async () => {
    const resources = await editorAt("resources");
    const first = drawEditor(resources.h, resources.editor);
    expect(first.get(".fdn-skills-name").text()).toBe("notes/checklist.md");
    const input = field(first, `${englishStrings.skillRenameFile}: notes/checklist.md`);
    const rename = button(first.get(".fdn-skills-files").element, englishStrings.skillRenameFile);
    expect(rename.disabled).toBe(true);
    await type(input, "notes/list.md");
    expect(rename.disabled).toBe(false);
    input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); // Enter renames; it does not save the skill
    await flushPromises();
    expect(resources.editor.resources[0]!.path).toBe("notes/list.md");
    expect(resources.h.workshop.saves).toBe(0);
    await click(button(first, englishStrings.skillRemoveFile));
    expect(resources.editor.hasResources).toBe(false);
    expect(first.text()).toContain(englishStrings.skillNoResources);
    first.unmount();

    const unknown = await editorAt("unknownKeys");
    const second = drawEditor(unknown.h, unknown.editor);
    expect(button(second, englishStrings.skillSave).disabled).toBe(true);
    await click(button(second, englishStrings.skillDropUnknownKeys));
    expect(unknown.editor.hasUnknownKeys).toBe(false);
    expect(maybeButton(second, englishStrings.skillDropUnknownKeys)).toBeUndefined();
  });

  it("writes nothing but by Save: typing, the preview, the test, the model question and a file added do not", async () => {
    const { h, library: vm, editor } = await editorAt("new");
    h.model.loads("contract-review");
    h.rig.files.resource = textFile("notes.md", "Some notes.");
    const w = drawLibrary(h, vm);
    await type(field(w, englishStrings.skillName), "contract-review");
    await type(field(w, englishStrings.skillDescription), "Reviews a contract clause by clause.");
    await type(field(w, englishStrings.skillInstructions), "## Goal\nReview.");
    const preview = field(w, englishStrings.skillPreview);
    preview.checked = true;
    preview.dispatchEvent(new Event("change", { bubbles: true }));
    await type(field(w, englishStrings.skillTestPrompt), "review this contract clause");
    await click(button(w, englishStrings.skillTestRun));
    await click(button(w, englishStrings.skillAskModel));
    await click(button(w, englishStrings.skillAddFile));
    expect(editor.resources.map((r) => r.path)).toEqual(["notes.md"]);
    expect(h.workshop.saves).toBe(0);
    expect(await h.rig.isEmpty()).toBe(true);

    await click(button(w, englishStrings.skillSave));
    await waitUntil(() => vm.editor === undefined);
    await flushPromises();
    expect(h.workshop.saves).toBe(1);
    expect(await h.rig.onDisk("contract-review")).toBe(true);
    expect(roleOf(w, "status")[0]!.textContent).toBe(englishStrings.skillSaved("contract-review"));
  });

  it("saves with Enter in a field (a form), and Cancel and Escape close it without saving", async () => {
    const { h, editor } = await editorAt("newValid");
    const closed = vi.fn();
    editor.onClosed(closed);
    const w = drawEditor(h, editor);
    const form = field(w, englishStrings.skillName).closest("form")!;
    const save = button(w, englishStrings.skillSave);
    expect(save.form).toBe(form);
    expect(save.type).toBe("submit");
    await escape(w);
    expect(closed).toHaveBeenCalledWith({ saved: false, name: undefined });
    expect(h.workshop.saves).toBe(0);
    await click(button(w, englishStrings.skillCancel));
    expect(closed).toHaveBeenCalledTimes(2);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
    await waitUntil(() => h.workshop.saves === 1);
    expect(h.workshop.saves).toBe(1);
    expect(closed).toHaveBeenLastCalledWith({ saved: true, name: "contract-review" });
  });

  it("asks before replacing, with Cancel focused; Escape says no, and Replace writes", async () => {
    const { h, editor } = await editorAt("replace");
    const closed = vi.fn();
    editor.onClosed(closed);
    const w = drawEditor(h, editor);
    expect(editor.needsReplaceConfirmation).toBe(true);
    const group = roleOf(w, "group")[0]!;
    expect(group.textContent).toContain(editor.replaceBody);
    expect(document.activeElement).toBe(button(group, englishStrings.skillCancel));
    await escape(w);
    expect(editor.needsReplaceConfirmation).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    await nextTick();
    expect(document.activeElement).toBe(field(w, englishStrings.skillName));

    await click(button(w, englishStrings.skillSave));
    await click(button(roleOf(w, "group")[0]!, englishStrings.skillReplace));
    expect(closed).toHaveBeenCalledWith({ saved: true, name: "contract-review" });
  });

  it("says in an alert that the skill could not be written, and what a proposal is", async () => {
    const failed = await editorAt("saveFailed");
    const first = drawEditor(failed.h, failed.editor);
    expect(roleOf(first, "alert")[0]!.textContent).toBe(englishStrings.skillSaveFailed);
    first.unmount();

    const proposal = await editorAt("proposal");
    const second = drawEditor(proposal.h, proposal.editor);
    expect(second.text()).toContain(englishStrings.skillEditorProposal);
    expect(proposal.h.workshop.saves).toBe(0);
  });

  it("runs the test with Enter in its field and shows what the pre-selection says", async () => {
    const { h, editor } = await editorAt("edit");
    const w = drawEditor(h, editor);
    const prompt = field(w, englishStrings.skillTestPrompt);
    expect(button(w, englishStrings.skillTestRun).type).toBe("submit");
    await type(prompt, "Please review this contract clause");
    prompt.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(editor.hasTestResult).toBe(true);
    for (const line of editor.testMatches) expect(w.text()).toContain(line);
    for (const name of editor.testListed) expect(w.text()).toContain(name);
    expect(h.workshop.saves).toBe(0);
  });

  it("says the model's answer in a polite status, without an assertive or ticking region", async () => {
    const { h, editor } = await editorAt("answered");
    const w = drawEditor(h, editor);
    expect(editor.modelAnswerText.length).toBeGreaterThan(0);
    expect(roleOf(w, "status").some((r) => r.textContent!.includes(editor.modelAnswerText))).toBe(true);
    expect(w.text()).toContain(englishStrings.skillModelNote);
    expect(h.model.calls).toHaveLength(1);
    expect(w.element.querySelectorAll('[aria-live="assertive"], [role="timer"]')).toHaveLength(0);
  });

  it("puts the focus on the first field, also when it is read-only", async () => {
    const fresh = await editorAt("new");
    const first = drawEditor(fresh.h, fresh.editor);
    expect(document.activeElement).toBe(field(first, englishStrings.skillName));
    first.unmount();
    const view = await editorAt("view");
    const second = drawEditor(view.h, view.editor);
    expect(document.activeElement).toBe(field(second, englishStrings.skillName));
  });
});

describe("SkillDraft", () => {
  it("puts the focus in the guidance field, and Enter in it writes the draft", async () => {
    const h = new SkillHarness(englishStrings);
    harnesses.push(h);
    const model = new ScriptedModel().says(GOOD_ANSWER);
    const made = new SkillDraftViewModel({ workshop: h.workshop, model, conversation: () => CHAT, strings: h.source });
    const w = drawDraft(h, made);
    const input = field(w, englishStrings.skillDraftGuidance);
    expect(document.activeElement).toBe(input);
    await type(input, "Always flag liability caps.");
    expect(made.guidance).toBe("Always flag liability caps.");
    expect(button(w, englishStrings.skillDraftStart).type).toBe("submit");
    input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(model.calls).toHaveLength(1);
    expect(String(model.calls[0]!.messages[1]!.content)).toContain("Always flag liability caps.");
    expect(made.proposal).toBeDefined();
    expect(h.workshop.saves).toBe(0);
  });

  it("says in words that nothing is saved until Save, and offers the proposal's editor only when the app gave a way to it", async () => {
    const { h, draft } = await draftAt("ready");
    const open = vi.fn();
    const first = drawDraft(h, draft, open);
    expect(first.text()).toContain(englishStrings.skillDraftReady);
    expect(first.text()).toContain(englishStrings.skillEditorProposal);
    await click(button(first, englishStrings.skillEdit));
    expect(open).toHaveBeenCalledWith(draft.proposal);
    expect(h.workshop.saves).toBe(0);
    first.unmount();
    const second = drawDraft(h, draft);
    expect(maybeButton(second, englishStrings.skillEdit)).toBeUndefined();
  });

  it("marks the state: working is busy and Escape stops it, failed and unreadable are alerts, the others statuses", async () => {
    const working = await draftAt("working");
    const w = drawDraft(working.h, working.draft);
    expect(column(w).attributes("aria-busy")).toBe("true");
    expect(button(w, englishStrings.skillDraftStart).disabled).toBe(true);
    expect(roleOf(w, "status")[0]!.textContent).toBe(englishStrings.skillDraftWorking);
    await escape(w);
    expect(working.draft.isWorking).toBe(false);
    w.unmount();

    for (const [state, text] of [["failed", englishStrings.skillDraftFailed], ["unreadable", englishStrings.skillDraftUnreadable]] as const) {
      const made = await draftAt(state);
      const view = drawDraft(made.h, made.draft);
      expect(roleOf(view, "alert")[0]!.textContent).toBe(text);
      view.unmount();
    }
    for (const [state, text] of [["noChat", englishStrings.skillDraftNoChat], ["noModel", englishStrings.skillDraftNoModel], ["readyWithProblems", englishStrings.skillDraftBroken]] as const) {
      const made = await draftAt(state);
      const view = drawDraft(made.h, made.draft);
      expect(roleOf(view, "status")[0]!.textContent).toBe(text);
      view.unmount();
    }
  });
});
