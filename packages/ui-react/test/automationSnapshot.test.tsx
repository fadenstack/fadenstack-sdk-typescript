// @vitest-environment jsdom
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { englishStrings } from "@fadenstack/ui";
import { ConnectionWizard, SkillDraft, SkillEditor, SkillLibrary, ToolsPage } from "@fadenstack/ui-react";

import { ALL_STEPS, reach } from "./wizardHarness.js";
import { DRAFT_STATES, EDITOR_STATES, LIBRARY_STATES, reachDraft, reachEditor, reachLibrary } from "./skillHarness.js";
import { TOOLS_STATES, reachTools } from "./toolsHarness.js";
import { collectAutomation, diffLines, finishSnapshot } from "./automationCollect.js";

// The automation snapshot of the wizard, skill and Tools views (React): for every view in every state, the controls and named elements a UI
// automation tool finds. The styling pass must not change a line. Record: FADEN_AUTOMATION_WRITE=1 npx vitest run <this file>.

const FILE = join(dirname(fileURLToPath(import.meta.url)), "automation-before.json");
const found: Record<string, string[]> = {};
const harnesses: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const h of harnesses.splice(0)) h.dispose();
  vi.restoreAllMocks();
});

const take = (key: string, container: HTMLElement) => {
  found[key] = collectAutomation(container);
};

describe("automation snapshot (React)", () => {
  it.each(ALL_STEPS)("ConnectionWizard: %s", async (step) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, vm } = await reach(step, englishStrings);
    harnesses.push(h);
    take(`wizard:${step}`, render(<ConnectionWizard wizard={vm} appName="Fadenstack Chrome" />).container);
  });
  it.each(LIBRARY_STATES)("SkillLibrary: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, library } = await reachLibrary(state, englishStrings);
    harnesses.push(h);
    take(`library:${state}`, render(<SkillLibrary library={library} />).container);
  });
  it.each(EDITOR_STATES)("SkillEditor: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, editor } = await reachEditor(state, englishStrings);
    harnesses.push(h);
    take(`editor:${state}`, render(<SkillEditor editor={editor} />).container);
  });
  it.each(DRAFT_STATES)("SkillDraft: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, draft } = await reachDraft(state, englishStrings);
    harnesses.push(h);
    take(`draft:${state}`, render(<SkillDraft draft={draft} />).container);
  });
  it.each(TOOLS_STATES)("ToolsPage: %s", async (state) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { h, tools } = await reachTools(state, englishStrings);
    harnesses.push(h);
    take(`tools:${state}`, render(<ToolsPage tools={tools} />).container);
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
