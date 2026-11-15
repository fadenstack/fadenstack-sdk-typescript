import "./polyfill.js";
import { createRoot, type Root } from "react-dom/client";
import { createApp, type App } from "vue";

import { englishStrings } from "@fadenstack/ui";
import { ConnectionWizard as ReactWizard, SkillDraft as ReactDraft, SkillEditor as ReactEditor, SkillLibrary as ReactLibrary, ToolsPage as ReactTools } from "@fadenstack/ui-react";
import { ConnectionWizard as VueWizard, SkillDraft as VueDraft, SkillEditor as VueEditor, SkillLibrary as VueLibrary, ToolsPage as VueTools } from "@fadenstack/ui-vue";

import { ALL_STEPS, reach } from "../../packages/ui-react/test/wizardHarness.js";
import { DRAFT_STATES, EDITOR_STATES, LIBRARY_STATES, reachDraft, reachEditor, reachLibrary } from "../../packages/ui-react/test/skillHarness.js";
import { TOOLS_STATES, reachTools } from "../../packages/ui-react/test/toolsHarness.js";
import "../../packages/ui-web/styles.css";
import { runChecks, measureFocus, tabbableCount } from "./checks.js";

// Mounts one (skin, view, state, palette) in a 380 px column; render.mjs drives it. The states and their set-up are the tests' own
// (packages/ui-react/test/wizardHarness.ts and skillHarness.ts), so a render shows what the tests assert on.

export type Skin = "react" | "vue";
export type Palette = "light" | "dark" | "forced";
interface Disposable { dispose(): void }

const STATES: Record<string, readonly string[]> = {
  wizard: ALL_STEPS.filter((s) => s !== "finished"),
  library: LIBRARY_STATES,
  editor: EDITOR_STATES,
  draft: DRAFT_STATES,
  tools: TOOLS_STATES,
};

let reactRoot: Root | undefined;
let vueApp: App | undefined;
let harness: Disposable | undefined;

function unmount(): void {
  reactRoot?.unmount();
  vueApp?.unmount();
  harness?.dispose();
  reactRoot = vueApp = harness = undefined;
  document.getElementById("root")!.replaceChildren();
}

const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

async function show(skin: Skin, view: string, state: string, palette: Palette): Promise<number> {
  unmount();
  const theme = palette === "forced" ? "system" : palette;
  const host = document.getElementById("root")!;
  const mountReact = (element: unknown) => {
    reactRoot = createRoot(host);
    reactRoot.render(element as never);
  };
  const mountVue = (component: unknown, props: Record<string, unknown>) => {
    vueApp = createApp(component as never, { ...props, theme });
    vueApp.mount(host);
  };
  if (view === "wizard") {
    const { h, vm } = await reach(state as never, englishStrings);
    harness = h;
    if (skin === "react") mountReact(<ReactWizard wizard={vm} appName="Fadenstack Chrome" theme={theme} />);
    else mountVue(VueWizard, { wizard: vm, appName: "Fadenstack Chrome" });
  } else if (view === "library") {
    const { h, library } = await reachLibrary(state as never, englishStrings);
    harness = h;
    if (skin === "react") mountReact(<ReactLibrary library={library} theme={theme} />);
    else mountVue(VueLibrary, { library });
  } else if (view === "editor") {
    const { h, editor } = await reachEditor(state as never, englishStrings);
    harness = h;
    if (skin === "react") mountReact(<ReactEditor editor={editor} theme={theme} />);
    else mountVue(VueEditor, { editor });
  } else if (view === "tools") {
    const { h, tools } = await reachTools(state as never, englishStrings);
    harness = h;
    if (skin === "react") mountReact(<ReactTools tools={tools} theme={theme} />);
    else mountVue(VueTools, { tools });
  } else {
    const { h, draft } = await reachDraft(state as never, englishStrings);
    harness = h;
    if (skin === "react") mountReact(<ReactDraft draft={draft} theme={theme} />);
    else mountVue(VueDraft, { draft });
  }
  await document.fonts.ready;
  await frames();
  // A view taller than the window scrolls inside its own frame: the picture takes all of it (the frame's scroll height), not what shows.
  const frame = host.firstElementChild as HTMLElement | null;
  return Math.ceil(Math.max(host.getBoundingClientRect().height, frame?.scrollHeight ?? 0));
}

(window as unknown as Record<string, unknown>)["styleRenders"] = {
  states: STATES,
  show,
  runChecks: (palette: Palette) => runChecks(document.getElementById("root")!, palette),
  measureFocus: () => measureFocus(document.getElementById("root")!),
  tabbableCount: () => tabbableCount(document.getElementById("root")!),
  blur: () => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  },
};
