<script setup lang="ts">
/** A header in the sheet: its name, and its value as a password box, or as dots with Replace when it is the saved one (never shown). */
import type { SecretRowViewModel, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ row: SecretRowViewModel; strings: UiStrings }>();
const row = useViewModel(() => props.row);
</script>

<template>
  <div class="fdn-tp-row">
    <input type="text" :aria-label="`${strings.toolsRowName} (${strings.toolsFieldHeaders})`" autocomplete="off" :spellcheck="false" dir="ltr" :value="row.name"
      @input="row.name = ($event.target as HTMLInputElement).value">
    <template v-if="row.isKept">
      <span class="fdn-tp-dots" role="img" :aria-label="row.savedName">{{ strings.toolsValueSaved }}</span>
      <button type="button" class="fdn-button fdn-quiet" :aria-label="`${strings.toolsReplaceValue} ${row.name}`" dir="auto" @click="row.replace()">{{ strings.toolsReplaceValue }}</button>
    </template>
    <input v-else type="password" :aria-label="`${strings.toolsRowValue} ${row.name}`.trim()" autocomplete="new-password" :spellcheck="false" dir="ltr" :value="row.value"
      @input="row.value = ($event.target as HTMLInputElement).value">
    <button type="button" class="fdn-button fdn-quiet" :aria-label="`${strings.toolsRemoveRow} ${row.name}`.trim()" @click="row.remove()"><Icon name="close" :size="14" /></button>
  </div>
</template>
