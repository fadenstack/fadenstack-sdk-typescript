<script setup lang="ts">
/**
 * The paste-import sheet: the person pastes the MCP configuration of another app, reads it, ticks servers and imports them (every one
 * switched off). The pasted text is gone once it was read. Parity with `ImportSheet` in `@fadenstack/ui-react`'s `ToolsPage`.
 */
import { computed, useId } from "vue";

import type { ImportSheetViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import ToolsImportRow from "./ToolsImportRow.vue";

const props = defineProps<{ sheet: ImportSheetViewModel }>();
const sheet = useViewModel(() => props.sheet);
const s = computed(() => sheet.value.strings);
const id = useId();
</script>

<template>
  <div class="fdn-tp-sheet" :aria-busy="sheet.isBusy">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ s.toolsImportTitle }}</h2>
    <p dir="auto">{{ s.toolsPasteIntro }}</p>
    <div class="fdn-wizard-field">
      <label :for="`${id}-text`" dir="auto">{{ s.toolsPasteField }}</label>
      <textarea :id="`${id}-text`" rows="6" autocomplete="off" :spellcheck="false" dir="ltr" :value="sheet.text" data-wizard-focus
        @input="sheet.text = ($event.target as HTMLTextAreaElement).value" />
    </div>
    <div class="fdn-wizard-actions">
      <button type="button" class="fdn-button" :disabled="!sheet.canRead" dir="auto" @click="sheet.read()">{{ s.toolsPasteRead }}</button>
    </div>
    <template v-if="sheet.hasStatus">
      <p v-if="sheet.statusIsProblem" class="fdn-wizard-error" role="alert" dir="auto">{{ sheet.statusText }}</p>
      <p v-else class="fdn-tp-result" role="status" dir="auto">{{ sheet.statusText }}</p>
    </template>
    <ul v-if="sheet.candidates.length > 0" class="fdn-tp-toollist">
      <ToolsImportRow v-for="c in sheet.candidates" :key="c.label" :row="c" />
    </ul>
    <div v-if="sheet.hasSkipped" class="fdn-tp-section">
      <h3 dir="auto">{{ s.toolsSkippedTitle }}</h3>
      <ul class="fdn-tp-toollist">
        <li v-for="(k, i) in sheet.skipped" :key="i" class="fdn-card fdn-tp-tool">
          <div class="fdn-tp-name" dir="auto">{{ k.name }}</div>
          <div class="fdn-muted" dir="auto">{{ k.reason }}</div>
        </li>
      </ul>
    </div>
    <p v-if="sheet.hasResult" class="fdn-tp-result" role="status" dir="auto">{{ sheet.resultText }}</p>
    <div class="fdn-wizard-actions">
      <button type="button" class="fdn-button fdn-primary" :disabled="!sheet.canImport" dir="auto" @click="sheet.importSelected()">{{ s.toolsImportButton }}</button>
      <button type="button" class="fdn-button" dir="auto" @click="sheet.cancel()">{{ s.toolsCancel }}</button>
    </div>
  </div>
</template>
