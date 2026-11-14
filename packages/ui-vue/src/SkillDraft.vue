<script setup lang="ts">
/**
 * "Draft from this chat" (sdk/51 F04) in the wizard's column: what the skill should be for (optional), the button that asks the model
 * once, the state in words, and the plain statement that nothing is saved until Save in the editor the proposal opens in. Enter in the
 * field writes the draft; Escape stops one that is on its way. Parity with `@fadenstack/ui-react`'s `SkillDraft`.
 */
import { computed, getCurrentInstance, ref, useId } from "vue";

import { SkillDraftState, type SkillDraftViewModel, type SkillEditorViewModel, type StringsSource } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import SkillShell from "./SkillShell.vue";
import Spinner from "./Spinner.vue";
import { defaultStrings, useFirstFocus } from "./skills.js";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The draft's view model (`SkillLibraryViewModel.createDraft`, or one the app made). */
  draft: SkillDraftViewModel;
  /** The texts, asked for on every draw so that a language change shows at once. English by default. */
  strings?: StringsSource;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { strings: defaultStrings, theme: "system" });

const emit = defineEmits<{
  /** "Edit": the app shows the proposal's editor again. The button shows only when something listens (the library opens it by itself). */
  "open-proposal": [editor: SkillEditorViewModel];
}>();

const self = getCurrentInstance();
const hasListener = (): boolean => self?.vnode.props?.["onOpenProposal"] !== undefined;
const vm = useViewModel(() => props.draft);
const s = computed(() => {
  void vm.value;
  return props.strings();
});
const id = useId();
const shell = ref<{ $el: Element } | null>(null);
useFirstFocus(shell, () => props.draft);

const failed = computed(() => vm.value.state === SkillDraftState.Failed || vm.value.state === SkillDraftState.Unreadable);
const statusClass = computed(() => (vm.value.isWorking ? "fdn-wizard-busy" : vm.value.state === SkillDraftState.Ready ? "fdn-skills-message" : "fdn-wizard-note"));

function submit(): void {
  void vm.value.draft(); // asks the model once; the proposal opens in the editor, unsaved
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented || !vm.value.isWorking) return;
  vm.value.cancel();
  e.preventDefault();
  e.stopPropagation();
}
</script>

<template>
  <SkillShell ref="shell" :strings="s" :theme="theme" :busy="vm.isWorking" @keydown="onKeyDown">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ s.skillDraftTitle }}</h2>
    <form class="fdn-wizard-form" novalidate @submit.prevent="submit">
      <div class="fdn-wizard-field">
        <label :for="`${id}-guidance`" dir="auto">{{ s.skillDraftGuidance }}</label>
        <input :id="`${id}-guidance`" type="text" autocomplete="off" dir="auto" :value="vm.guidance" :readonly="vm.isWorking" data-wizard-focus
          @input="vm.guidance = ($event.target as HTMLInputElement).value">
      </div>
      <div class="fdn-wizard-actions">
        <button type="submit" class="fdn-button fdn-primary" :disabled="!vm.canDraft">{{ s.skillDraftStart }}</button>
      </div>
    </form>
    <p v-if="failed" class="fdn-wizard-error" role="alert" dir="auto">{{ vm.statusText }}</p>
    <p v-else-if="vm.statusText" :class="statusClass" role="status" dir="auto"><Spinner v-if="vm.isWorking" /><span>{{ vm.statusText }}</span></p>
    <div v-if="vm.proposal" class="fdn-card fdn-skills-ask">
      <p dir="auto">{{ vm.proposal.proposalNote }}</p>
      <div v-if="hasListener()" class="fdn-wizard-actions">
        <button type="button" class="fdn-button" @click="emit('open-proposal', vm.proposal!)">{{ s.skillEdit }}</button>
      </div>
    </div>
  </SkillShell>
</template>
