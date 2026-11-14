<script setup lang="ts">
/**
 * "Draft from this chat" (sdk/51 F04), drawn inside a shell: what the skill should be for (optional), the button that asks the model
 * once, the state in words, and the plain statement, in every state, that nothing is saved until Save in the editor the proposal opens
 * in ("Open the proposal" is the view model's `openProposal()`). The texts are the view model's. Enter in the field writes the draft;
 * Escape stops one that is on its way. Parity with `SkillDraftBody` in @fadenstack/ui-react.
 */
import { computed, ref, useId } from "vue";

import { SkillDraftState, type SkillDraftViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Spinner from "./Spinner.vue";
import { draftEscape, useFirstFocus } from "./skills.js";

const props = defineProps<{
  draft: SkillDraftViewModel;
}>();

const vm = useViewModel(() => props.draft);
const s = computed(() => vm.value.strings);
const id = useId();
const root = ref<HTMLElement | null>(null);
useFirstFocus(root, () => props.draft);

const failed = computed(() => vm.value.state === SkillDraftState.Failed || vm.value.state === SkillDraftState.Unreadable);
const statusClass = computed(() => (vm.value.isWorking ? "fdn-wizard-busy" : vm.value.state === SkillDraftState.Ready ? "fdn-skills-message" : "fdn-wizard-note"));

function submit(): void {
  void vm.value.draft(); // asks the model once; the proposal opens in the editor, unsaved
}
</script>

<template>
  <div ref="root" class="fdn-skills-draft" :aria-busy="vm.isWorking" @keydown="draftEscape(vm, $event)">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ s.skillDraftTitle }}</h2>
    <p class="fdn-wizard-note" dir="auto">{{ vm.standingNote }}</p>
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
      <div v-if="vm.canOpenProposal" class="fdn-wizard-actions">
        <button type="button" class="fdn-button" @click="vm.openProposal()">{{ s.skillDraftOpen }}</button>
      </div>
    </div>
  </div>
</template>