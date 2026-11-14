<script setup lang="ts">
/** One file of the skill: its path and size, and the name to rename it to (Enter renames; it does not save the skill). */
import { useId } from "vue";

import type { SkillResourceViewModel, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";

const props = defineProps<{
  row: SkillResourceViewModel;
  strings: UiStrings;
  readOnly: boolean;
}>();

const vm = useViewModel(() => props.row);
const id = useId();

function size(): string {
  try {
    return new Intl.NumberFormat(props.strings.language, { style: "unit", unit: "byte", unitDisplay: "short" }).format(vm.value.size);
  } catch {
    return String(vm.value.size);
  }
}
</script>

<template>
  <li class="fdn-card fdn-skills-row">
    <span class="fdn-skills-name" dir="ltr">{{ vm.path }}</span>
    <span class="fdn-muted">{{ size() }}</span>
    <form class="fdn-wizard-form" novalidate @submit.prevent="vm.rename()">
      <div class="fdn-wizard-field">
        <label :for="`${id}-path`" dir="auto">{{ `${strings.skillRenameFile}: ${vm.path}` }}</label>
        <input :id="`${id}-path`" type="text" autocomplete="off" :spellcheck="false" dir="ltr" :value="vm.newPath" :readonly="readOnly"
          @input="vm.newPath = ($event.target as HTMLInputElement).value">
      </div>
      <div v-if="!readOnly" class="fdn-wizard-actions">
        <button type="submit" class="fdn-button" :disabled="!vm.canRename">{{ strings.skillRenameFile }}</button>
        <button v-if="vm.canRemove" type="button" class="fdn-button fdn-quiet" @click="vm.remove()">{{ strings.skillRemoveFile }}</button>
      </div>
    </form>
  </li>
</template>
