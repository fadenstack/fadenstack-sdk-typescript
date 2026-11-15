// @vitest-environment jsdom
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { englishStrings } from "@fadenstack/ui";
import { ConnectionWizard, SkillDraft, SkillEditor, SkillLibrary } from "@fadenstack/ui-vue";

import { ALL_STEPS, reach } from "../../ui-react/test/wizardHarness.js";
import { DRAFT_STATES, EDITOR_STATES, LIBRARY_STATES, reachDraft, reachEditor, reachLibrary } from "../../ui-react/test/skillHarness.js";
import { collectAutomation, diffLines, finishSnapshot } from "../../ui-react/test/automationCollect.js";

// The automation snapshot of the wizard and skill views (Vue): see the React file. Record: FADEN_AUTOMATION_WRITE=1 npx vitest run <this file>.

const FILE = join(dirname(fileURLToPath(import.meta.url)), "automation-before.json");
const found: Record<string, string[]> = {};
const harnesses: { dispose(): void }[] = [];
const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  for (const h of harnesses.splice(0)) h.dispose();
  vi.restoreAllMocks();
});

const take = (key: string, component: never, props: Record<string, unknown>) => {
  const w = mount(component, { props, attachTo: document.body });
  wrappers.push(w);
  found[key] = collectAutomation(w.element as Element);
};

describe("automation snapshot (Vue)", () => {
  it.each(ALL_STEPS)("ConnectionWizard: %s", async (step) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { h, vm } = await reach(step, englishStrings);
    harnesses.push(h);
    take(`wizard:${step}`, ConnectionWizard as never, { wizard: vm, appName: "Fadenstack Chrome" });
  });
  it.each(LIBRARY_STATES)("SkillLibrary: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, library } = await reachLibrary(state, englishStrings);
    harnesses.push(h);
    take(`library:${state}`, SkillLibrary as never, { library });
  });
  it.each(EDITOR_STATES)("SkillEditor: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, editor } = await reachEditor(state, englishStrings);
    harnesses.push(h);
    take(`editor:${state}`, SkillEditor as never, { editor });
  });
  it.each(DRAFT_STATES)("SkillDraft: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, draft } = await reachDraft(state, englishStrings);
    harnesses.push(h);
    take(`draft:${state}`, SkillDraft as never, { draft });
  });
});

describe("automation snapshot: the recorded file", () => {
  it("has no lost and no new line", () => {
    const keys = Object.keys(found);
    expect(keys.length).toBeGreaterThan(40);
    const { write, before } = finishSnapshot(FILE, found);
    if (write) return;
    const problems: string[] = [];
    for (const key of new Set([...Object.keys(before!), ...keys])) {
      for (const line of diffLines(before![key] ?? [], found[key] ?? [])) problems.push(`${key}  ${line}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
