import { nextTick, onMounted, watch, type Ref } from "vue";

import type { SkillDraftViewModel, SkillEditorViewModel } from "@fadenstack/ui";

// What the skill views share (parity with @fadenstack/ui-react's SkillParts and the editor's Escape).


/**
 * A new state takes the focus: its first marked field, else its title, else the root itself. `source` says when the state changed
 * (the view's key), `enabled` when this view may take the focus (a library with an editor open leaves it to the editor).
 */
export function useFirstFocus(root: Ref<HTMLElement | { $el: Element } | null>, source: () => unknown, enabled: () => boolean = () => true): void {
  const run = (): void => {
    const held = root.value;
    const element = (held && "$el" in held ? held.$el : held) as HTMLElement | null;
    if (!element || !enabled()) return;
    const target = element.querySelector<HTMLElement>("[data-wizard-focus]") ?? element.querySelector<HTMLElement>("[data-wizard-title]") ?? element;
    target.focus({ preventScroll: true });
  };
  onMounted(run);
  watch(source, () => nextTick(run), { flush: "post" });
}

/** Escape says no to the replace question when it is open, else it is Cancel. */
export function editorEscape(vm: SkillEditorViewModel, e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (vm.needsReplaceConfirmation) vm.dismissReplace();
  else vm.cancel();
  e.preventDefault();
  e.stopPropagation();
}

/** Escape stops a draft that is on its way. */
export function draftEscape(vm: SkillDraftViewModel, e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented || !vm.isWorking) return;
  vm.cancel();
  e.preventDefault();
  e.stopPropagation();
}
