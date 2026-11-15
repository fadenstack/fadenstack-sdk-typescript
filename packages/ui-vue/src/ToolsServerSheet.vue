<script setup lang="ts">
/**
 * The sheet that adds a server or edits one: its name, its address, its headers as masked rows with Replace, the longest call and
 * whether to switch it on; Test, Add (Save when editing) and Cancel. A typed header value is cleared when the sheet is saved or
 * closed. Parity with `ServerSheet` in `@fadenstack/ui-react`'s `ToolsPage`.
 */
import { computed, useId } from "vue";

import type { ServerSheetViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import ToolsHeaderRow from "./ToolsHeaderRow.vue";

const props = defineProps<{ sheet: ServerSheetViewModel }>();
const sheet = useViewModel(() => props.sheet);
const s = computed(() => sheet.value.strings);
const id = useId();
</script>

<template>
  <form class="fdn-tp-sheet" novalidate :aria-busy="sheet.isBusy" @submit.prevent="sheet.save()">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ sheet.title }}</h2>
    <div class="fdn-wizard-field">
      <label :for="`${id}-label`" dir="auto">{{ s.toolsFieldLabel }}</label>
      <input :id="`${id}-label`" type="text" autocomplete="off" :spellcheck="false" dir="ltr" :value="sheet.label" :aria-describedby="`${id}-label-help`" data-wizard-focus
        @input="sheet.label = ($event.target as HTMLInputElement).value">
    </div>
    <p :id="`${id}-label-help`" class="fdn-tp-help" dir="auto">{{ s.toolsFieldLabelHelp }}</p>
    <div class="fdn-wizard-field">
      <label :for="`${id}-url`" dir="auto">{{ s.toolsFieldUrl }}</label>
      <input :id="`${id}-url`" type="text" inputmode="url" autocomplete="off" :spellcheck="false" dir="ltr" :value="sheet.url" :aria-describedby="`${id}-url-help`"
        @input="sheet.url = ($event.target as HTMLInputElement).value">
    </div>
    <p :id="`${id}-url-help`" class="fdn-tp-help" dir="auto">{{ s.toolsFieldUrlHelp }}</p>

    <fieldset>
      <legend dir="auto">{{ s.toolsFieldHeaders }}</legend>
      <ToolsHeaderRow v-for="(row, i) in sheet.headerRows" :key="i" :row="row" :strings="s" />
      <div class="fdn-wizard-actions">
        <button type="button" class="fdn-button fdn-quiet" dir="auto" @click="sheet.addHeader()">{{ s.toolsAddRow }}</button>
      </div>
      <p class="fdn-tp-help" dir="auto">{{ s.toolsSecretsNote }}</p>
    </fieldset>

    <div class="fdn-wizard-field">
      <label :for="`${id}-timeout`" dir="auto">{{ s.toolsFieldTimeout }}</label>
      <input :id="`${id}-timeout`" type="number" inputmode="numeric" min="5" max="600" :value="sheet.timeoutText" @input="sheet.timeoutText = ($event.target as HTMLInputElement).value">
    </div>
    <div class="fdn-wizard-check">
      <input :id="`${id}-enabled`" type="checkbox" :checked="sheet.enabled" @change="sheet.enabled = ($event.target as HTMLInputElement).checked">
      <label :for="`${id}-enabled`" dir="auto">{{ s.toolsFieldEnabled }}</label>
    </div>

    <p v-if="sheet.hasError" class="fdn-wizard-error" role="alert" dir="auto">{{ sheet.errorText }}</p>
    <p v-if="sheet.hasTest" class="fdn-tp-result" role="status" dir="auto">{{ sheet.testText }}</p>
    <div class="fdn-wizard-actions">
      <button type="submit" class="fdn-button fdn-primary" :disabled="sheet.isBusy" dir="auto">{{ sheet.primaryText }}</button>
      <button type="button" class="fdn-button" :disabled="sheet.isBusy" dir="auto" @click="sheet.test()">{{ s.toolsTestButton }}</button>
      <button type="button" class="fdn-button" dir="auto" @click="sheet.cancel()">{{ s.toolsCancel }}</button>
    </div>
    <div v-if="sheet.isAdding" class="fdn-wizard-actions">
      <button type="button" class="fdn-button fdn-quiet" dir="auto" @click="sheet.importMore()">{{ s.toolsPasteMore }}</button>
    </div>
  </form>
</template>
