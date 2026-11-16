<script setup lang="ts">
/**
 * The web search settings sheet's body (sdk/51 F06): Off, Brave with the person's own key (a password box that is never filled from
 * the store; a kept key shows as "saved" with Replace and Remove key) or a SearXNG address. Parity with `WebSearchSheet` in
 * `@fadenstack/ui-react`. `ToolsPage` shows it in place of its list; `WebSearchSettings` in its own shell.
 */
import { computed, useId } from "vue";

import type { WebSearchChoice, WebSearchSettingsViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";

const props = defineProps<{ sheet: WebSearchSettingsViewModel }>();
const sheet = useViewModel(() => props.sheet);
const s = computed(() => sheet.value.strings);
const id = useId();

function pick(choice: WebSearchChoice): void {
  sheet.value.choice = choice;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  sheet.value.cancel();
  e.preventDefault();
  e.stopPropagation();
}
</script>

<template>
  <form class="fdn-tp-sheet" novalidate :aria-busy="sheet.isBusy" @submit.prevent="sheet.save()" @keydown="onKeyDown">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ sheet.title }}</h2>
    <p dir="auto">{{ s.webSearchIntro }}</p>
    <fieldset>
      <legend dir="auto">{{ s.webSearchChoiceName }}</legend>
      <div class="fdn-wizard-check">
        <input :id="`${id}-off`" type="radio" :name="`${id}-choice`" :checked="sheet.isOff" data-wizard-focus :aria-describedby="`${id}-off-help`" @change="pick('off')">
        <label :for="`${id}-off`" dir="auto">{{ s.webSearchChoiceOff }}</label>
      </div>
      <p :id="`${id}-off-help`" class="fdn-tp-help" dir="auto">{{ s.webSearchOffHelp }}</p>
      <div class="fdn-wizard-check">
        <input :id="`${id}-brave`" type="radio" :name="`${id}-choice`" :checked="sheet.isBrave" @change="pick('brave')">
        <label :for="`${id}-brave`" dir="auto">{{ s.webSearchChoiceBrave }}</label>
      </div>
      <div class="fdn-wizard-check">
        <input :id="`${id}-searxng`" type="radio" :name="`${id}-choice`" :checked="sheet.isSearxng" @change="pick('searxng')">
        <label :for="`${id}-searxng`" dir="auto">{{ s.webSearchChoiceSearxng }}</label>
      </div>
    </fieldset>

    <template v-if="sheet.isBrave">
      <div v-if="sheet.keyIsKept" class="fdn-tp-row">
        <span class="fdn-tp-dots" role="img" :aria-label="s.webSearchKeyKept">{{ s.toolsValueSaved }}</span>
        <span dir="auto">{{ s.webSearchKeyKept }}</span>
        <button type="button" class="fdn-button fdn-quiet" dir="auto" @click="sheet.replaceKey()">{{ s.webSearchKeyReplace }}</button>
        <button type="button" class="fdn-button fdn-quiet" dir="auto" @click="sheet.removeKey()">{{ s.webSearchKeyRemove }}</button>
      </div>
      <template v-else>
        <div class="fdn-wizard-field">
          <label :for="`${id}-key`" dir="auto">{{ s.webSearchKeyLabel }}</label>
          <input :id="`${id}-key`" type="password" autocomplete="off" :spellcheck="false" dir="ltr" :value="sheet.key" :aria-describedby="`${id}-key-help`"
            @input="sheet.key = ($event.target as HTMLInputElement).value">
        </div>
        <p v-if="sheet.keyIsRemoved" class="fdn-tp-result" role="status" dir="auto">{{ s.webSearchKeyRemoved }}</p>
        <div v-if="sheet.canRemoveKey" class="fdn-wizard-actions">
          <button type="button" class="fdn-button fdn-quiet" dir="auto" @click="sheet.removeKey()">{{ s.webSearchKeyRemove }}</button>
        </div>
      </template>
      <p :id="`${id}-key-help`" class="fdn-tp-help" dir="auto">{{ s.webSearchKeyHelp }}</p>
    </template>

    <template v-if="sheet.isSearxng">
      <div class="fdn-wizard-field">
        <label :for="`${id}-url`" dir="auto">{{ s.webSearchUrlLabel }}</label>
        <input :id="`${id}-url`" type="text" inputmode="url" autocomplete="off" :spellcheck="false" dir="ltr" :value="sheet.address" :aria-describedby="`${id}-url-help`"
          :aria-invalid="sheet.hasError ? true : undefined" @input="sheet.address = ($event.target as HTMLInputElement).value">
      </div>
      <p :id="`${id}-url-help`" class="fdn-tp-help" dir="auto">{{ s.webSearchUrlHelp }}</p>
    </template>

    <p v-if="!sheet.isOff" class="fdn-tp-help" dir="auto">{{ sheet.keptWhereText }}</p>
    <p v-if="!sheet.isOff" class="fdn-tp-help" dir="auto">{{ sheet.privacyText }}</p>
    <p v-if="sheet.hasError" class="fdn-wizard-error" role="alert" dir="auto">{{ sheet.errorText }}</p>
    <p v-if="sheet.hasSaved" class="fdn-tp-result" role="status" dir="auto">{{ sheet.savedText }}</p>
    <div class="fdn-wizard-actions">
      <button type="submit" class="fdn-button fdn-primary" :disabled="sheet.isBusy" dir="auto">{{ s.webSearchSave }}</button>
      <button type="button" class="fdn-button" dir="auto" @click="sheet.cancel()">{{ s.webSearchCancel }}</button>
    </div>
  </form>
</template>
