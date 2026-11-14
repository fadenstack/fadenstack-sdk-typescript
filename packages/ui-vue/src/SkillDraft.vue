<script setup lang="ts">
/**
 * "Draft from this chat" (sdk/51 F04) in the wizard's column: what the skill should be for (optional), the button that asks the model
 * once, the state in words, and the plain statement that nothing is saved until Save in the editor the proposal opens in. The texts are
 * the view model's. Enter in the field writes the draft; Escape stops one that is on its way. Parity with `@fadenstack/ui-react`'s `SkillDraft`.
 */
import { computed } from "vue";

import type { SkillDraftViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import SkillDraftBody from "./SkillDraftBody.vue";
import SkillShell from "./SkillShell.vue";
import { draftEscape } from "./skills.js";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The draft's view model (`SkillLibraryViewModel.createDraft`, or one the app made). */
  draft: SkillDraftViewModel;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { theme: "system" });

const vm = useViewModel(() => props.draft);
const s = computed(() => vm.value.strings);
</script>

<template>
  <SkillShell :strings="s" :theme="theme" :busy="vm.isWorking" @keydown="draftEscape(vm, $event)">
    <SkillDraftBody :draft="draft" />
  </SkillShell>
</template>