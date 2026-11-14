<script setup lang="ts">
/**
 * The skill library (sdk/51 F04) in the wizard's column: the skills with where each comes from, "not reviewed" for the person's own and
 * its switch; New and Import; Edit (View for a bundled one), Duplicate, Export and Delete on each row, with the confirmations the view
 * model asks for. When an editor is open (new, edit, a draft's proposal) it is drawn in place of the list. Import is a file input for a
 * zip (and the library's own drop point, `importFrom`); Export is the app's `SkillFileHost.saveExport` (`browserSkillFiles()` is a
 * download). Every command is called in the event's own turn. Parity with `@fadenstack/ui-react`'s `SkillLibrary`.
 */
import { computed, ref, useId } from "vue";

import type { SkillLibraryViewModel } from "@fadenstack/ui";
import { readFileBytes } from "@fadenstack/ui-web";

import { useViewModel } from "./composables.js";
import SkillDraftBody from "./SkillDraftBody.vue";
import SkillEditorBody from "./SkillEditorBody.vue";
import SkillIssues from "./SkillIssues.vue";
import SkillRow from "./SkillRow.vue";
import SkillShell from "./SkillShell.vue";
import Spinner from "./Spinner.vue";
import { editorEscape, useFirstFocus } from "./skills.js";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The library's view model; the app calls `refresh()` (and `retext()` when the language changes). */
  library: SkillLibraryViewModel;

  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { theme: "system" });

const vm = useViewModel(() => props.library);
const s = computed(() => vm.value.strings); // the view model's texts
const id = useId();
const shell = ref<{ $el: Element } | null>(null);
const picker = ref<HTMLInputElement | null>(null);

const asking = computed(() => (vm.value.pendingDelete !== undefined ? "delete" : vm.value.pendingImport !== undefined ? "import" : "list"));

// The list's first button, or the question that opened (the editor focuses itself).
useFirstFocus(shell, () => `${vm.value.editor === undefined}|${asking.value}`, () => vm.value.editor === undefined); // a value, so only a new state (not every change) moves the focus

function onKeyDown(e: KeyboardEvent): void {
  const v = vm.value;
  if (v.editor) return editorEscape(v.editor, e);
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (v.pendingDelete) v.cancelDelete();
  else if (v.pendingImport) v.cancelImport();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function chosen(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // the same file can be chosen again
  if (!file) return;
  void readFileBytes(file).then((bytes) => vm.value.importFrom({ name: file.name, bytes })).catch(() => undefined);
}
</script>

<template>
  <SkillShell ref="shell" :strings="s" :theme="theme" :busy="vm.isLoading || (vm.editor?.isSaving ?? false)" @keydown="onKeyDown">
    <SkillEditorBody v-if="vm.editor" :editor="vm.editor" />
    <template v-else>
      <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ s.skillLibraryTitle }}</h2>
      <p v-if="vm.messageIsError" class="fdn-wizard-error" role="alert" dir="auto">{{ vm.message }}</p>
      <p v-else-if="vm.messageIsWarning" class="fdn-skills-message fdn-skills-message-warning" role="status" dir="auto">{{ vm.message }}</p>
      <p v-else-if="vm.messageIsInformation" class="fdn-skills-message" role="status" dir="auto">{{ vm.message }}</p>
      <template v-if="vm.note">
        <p v-if="vm.failed" class="fdn-wizard-error" role="alert" dir="auto">{{ vm.note }}</p>
        <p v-else class="fdn-wizard-busy" role="status" dir="auto"><Spinner v-if="vm.isLoading" /><span>{{ vm.note }}</span></p>
      </template>

      <div class="fdn-wizard-actions">
        <button type="button" class="fdn-button fdn-primary" :disabled="!vm.canNew" :data-wizard-focus="asking === 'list' ? '' : undefined"
          @click="vm.newSkill()">{{ s.skillNew }}</button>
        <button type="button" class="fdn-button" :disabled="!vm.canImport" @click="picker?.click()">{{ s.skillImport }}</button>
        <button v-if="vm.hasDraft" type="button" class="fdn-button" :disabled="!vm.canToggleDraft" @click="vm.toggleDraft()">{{ s.skillDraftTitle }}</button>
      </div>
      <!-- "Draft from this chat": only when the app gave the library its conversation. -->
      <SkillDraftBody v-if="vm.draft && vm.draftOpen" :draft="vm.draft" />
      <label :for="`${id}-zip`" class="fdn-sr-only">{{ s.skillImport }}</label>
      <input :id="`${id}-zip`" ref="picker" class="fdn-sr-only" type="file" accept=".zip" tabindex="-1" aria-hidden="true" @change="chosen">

      <div v-if="vm.pendingDelete" class="fdn-card fdn-skills-ask" role="group" :aria-labelledby="`${id}-delete-title`">
        <h3 :id="`${id}-delete-title`" role="alert" dir="auto">{{ vm.deleteTitle }}</h3>
        <p dir="auto">{{ vm.deleteBody }}</p>
        <div class="fdn-wizard-actions">
          <button type="button" class="fdn-button" data-wizard-focus @click="vm.cancelDelete()">{{ s.skillCancel }}</button>
          <button type="button" class="fdn-button fdn-primary" :disabled="!vm.canConfirmDelete" @click="vm.confirmDelete()">{{ s.skillDelete }}</button>
        </div>
      </div>

      <form v-if="vm.pendingImport" novalidate @submit.prevent="vm.confirmImport()">
        <div class="fdn-card fdn-skills-ask" role="group" :aria-labelledby="`${id}-import-title`">
          <h3 :id="`${id}-import-title`" role="alert" dir="auto">{{ vm.importTitle }}</h3>
          <p dir="auto">{{ vm.importBody }}</p>
          <SkillIssues :items="vm.importIssues" />
          <div class="fdn-wizard-actions">
            <button type="button" class="fdn-button" :data-wizard-focus="!vm.canConfirmImport || vm.importReplaces ? '' : undefined"
              @click="vm.cancelImport()">{{ s.skillCancel }}</button>
            <button v-if="vm.pendingImport.ok" type="submit" class="fdn-button fdn-primary" :disabled="!vm.canConfirmImport"
              :data-wizard-focus="vm.canConfirmImport && !vm.importReplaces ? '' : undefined">{{ vm.importReplaces ? s.skillReplace : s.skillImport }}</button>
          </div>
        </div>
      </form>

      <ul v-if="vm.rows.length > 0" class="fdn-skills-list">
        <SkillRow v-for="row in vm.rows" :key="row.name" :library="vm" :row="row" :strings="s" />
      </ul>
    </template>
  </SkillShell>
</template>
