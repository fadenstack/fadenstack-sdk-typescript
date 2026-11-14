<script setup lang="ts">
/**
 * The skill editor (sdk/51 F04) in the wizard's column: the name and description with the checks' words as you type, the instructions
 * with a Markdown preview, the `faden.yaml` fields, the files, the checks, Save (on only when the view model says so), Cancel and the
 * Try panel. It only renders; every command is called in the event's own turn, and nothing is saved but by Save. Parity with
 * `@fadenstack/ui-react`'s `SkillEditor`.
 */
import { computed } from "vue";

import type { SkillEditorViewModel, StringsSource } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import SkillEditorBody from "./SkillEditorBody.vue";
import SkillShell from "./SkillShell.vue";
import { defaultStrings, editorEscape } from "./skills.js";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The editor's view model (new, edit, a bundled skill to read, or a draft's proposal). Closing it (Save, Cancel) is the app's: `onClosed`. */
  editor: SkillEditorViewModel;
  /** The texts, asked for on every draw so that a language change shows at once: the function the view model was given. English by default. */
  strings?: StringsSource;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { strings: defaultStrings, theme: "system" });

const vm = useViewModel(() => props.editor);
const s = computed(() => {
  void vm.value;
  return props.strings();
});
</script>

<template>
  <SkillShell :strings="s" :theme="theme" :busy="vm.isSaving" @keydown="editorEscape(vm, $event)">
    <SkillEditorBody :editor="editor" :strings="strings" />
  </SkillShell>
</template>
