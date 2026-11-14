<script setup lang="ts">
/**
 * The skill editor's content (sdk/51 F04), drawn inside a shell: the name and description with the checks' words as you type, the
 * instructions with a Markdown preview (the chat's own rendering), the `faden.yaml` fields, the files, the checks, Save (on only when
 * the view model says so), Cancel and the Try panel. Every command is called in the event's own turn, and nothing is saved but by Save
 * (or by confirming a replacement). A skill's text is untrusted: it is drawn as text and as Markdown blocks, never as HTML. Parity with
 * `SkillEditorBody` in @fadenstack/ui-react.
 */
import { computed, ref, useId } from "vue";

import type { SkillEditorViewModel, StringsSource } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Markdown from "./markdown/Markdown.vue";
import SkillIssues from "./SkillIssues.vue";
import SkillResourceRow from "./SkillResourceRow.vue";
import { useFirstFocus } from "./skills.js";

const props = defineProps<{
  editor: SkillEditorViewModel;
  strings: StringsSource;
}>();

const vm = useViewModel(() => props.editor);
const s = computed(() => {
  void vm.value; // a language change reaches the view model (`retext`) and draws this again
  return props.strings();
});
const id = useId();
const root = ref<HTMLElement | null>(null);

// The editor's first field takes the focus; the replace question's Cancel while it is open.
useFirstFocus(root, () => [props.editor, vm.value.needsReplaceConfirmation]);

const about = (subject: string) => vm.value.issues.filter((i) => i.subject === subject);
const invalid = (items: readonly { isError: boolean }[]) => (items.some((i) => i.isError) ? "true" : undefined);
const valueOf = (e: Event): string => (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;

function submit(): void {
  void vm.value.save(); // only the person's Save writes anything
}

function priority(e: Event): void {
  const n = (e.target as HTMLInputElement).valueAsNumber;
  vm.value.priority = Number.isFinite(n) ? n : 0;
}
</script>

<template>
  <div ref="root" class="fdn-skills-editor" :aria-busy="vm.isSaving">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ vm.heading }}</h2>
    <p v-if="vm.isProposal" class="fdn-wizard-note" dir="auto">{{ vm.proposalNote }}</p>
    <template v-if="vm.message">
      <p v-if="vm.message === s.skillSaveFailed" class="fdn-wizard-error" role="alert" dir="auto">{{ vm.message }}</p>
      <p v-else class="fdn-skills-message" role="status" dir="auto">{{ vm.message }}</p>
    </template>
    <div v-if="vm.needsReplaceConfirmation" class="fdn-card fdn-skills-ask" role="group" :aria-labelledby="`${id}-replace-title`">
      <h3 :id="`${id}-replace-title`" role="alert" dir="auto">{{ vm.replaceTitle }}</h3>
      <p dir="auto">{{ vm.replaceBody }}</p>
      <div class="fdn-wizard-actions">
        <button type="button" class="fdn-button" data-wizard-focus @click="vm.dismissReplace()">{{ s.skillCancel }}</button>
        <button type="button" class="fdn-button fdn-primary" :disabled="!vm.canConfirmReplace" @click="vm.confirmReplace()">{{ s.skillReplace }}</button>
      </div>
    </div>

    <form :id="`${id}-form`" class="fdn-wizard-form" novalidate @submit.prevent="submit">
      <div class="fdn-wizard-field">
        <label :for="`${id}-name`" dir="auto">{{ s.skillName }}</label>
        <input :id="`${id}-name`" type="text" autocomplete="off" :spellcheck="false" dir="ltr" :value="vm.name" :readonly="vm.isReadOnly"
          :aria-invalid="invalid(about('name'))" :aria-describedby="about('name').length > 0 ? `${id}-name-issues` : undefined"
          :data-wizard-focus="vm.needsReplaceConfirmation ? undefined : ''" @input="vm.name = valueOf($event)">
      </div>
      <SkillIssues :id="`${id}-name-issues`" :items="about('name')" />

      <div class="fdn-wizard-field">
        <label :for="`${id}-description`" dir="auto">{{ s.skillDescription }}</label>
        <textarea :id="`${id}-description`" rows="3" dir="auto" :value="vm.description" :readonly="vm.isReadOnly"
          :aria-invalid="invalid(about('description'))" :aria-describedby="about('description').length > 0 ? `${id}-description-issues` : undefined"
          @input="vm.description = valueOf($event)" />
      </div>
      <SkillIssues :id="`${id}-description-issues`" :items="about('description')" />

      <div class="fdn-skills-head">
        <label :for="`${id}-instructions`" dir="auto">{{ s.skillInstructions }}</label>
        <div class="fdn-wizard-check">
          <input :id="`${id}-preview`" type="checkbox" :checked="vm.showPreview" @change="vm.showPreview = ($event.target as HTMLInputElement).checked">
          <label :for="`${id}-preview`" dir="auto">{{ s.skillPreview }}</label>
        </div>
      </div>
      <textarea :id="`${id}-instructions`" class="fdn-skills-instructions" rows="10" dir="auto" :spellcheck="false" :value="vm.instructions"
        :readonly="vm.isReadOnly" :aria-invalid="invalid(about('instructions'))"
        :aria-describedby="about('instructions').length > 0 ? `${id}-instructions-issues` : undefined" @input="vm.instructions = valueOf($event)" />
      <SkillIssues :id="`${id}-instructions-issues`" :items="about('instructions')" />
      <div v-if="vm.showPreview" class="fdn-card fdn-skills-preview" role="region" :aria-label="s.skillPreview">
        <Markdown :blocks="vm.previewBlocks" :strings="s" />
      </div>

      <h3 dir="auto">{{ s.skillMatching }}</h3>
      <div class="fdn-wizard-field">
        <label :for="`${id}-title`" dir="auto">{{ s.skillTitleField }}</label>
        <input :id="`${id}-title`" type="text" autocomplete="off" dir="auto" :value="vm.extensionTitle" :readonly="vm.isReadOnly"
          @input="vm.extensionTitle = valueOf($event)">
      </div>
      <div class="fdn-wizard-field">
        <label :for="`${id}-keywords`" dir="auto">{{ s.skillKeywords }}</label>
        <input :id="`${id}-keywords`" type="text" autocomplete="off" dir="auto" :value="vm.keywordsText" :readonly="vm.isReadOnly"
          @input="vm.keywordsText = valueOf($event)">
      </div>
      <div class="fdn-wizard-field">
        <label :for="`${id}-tags`" dir="auto">{{ s.skillTags }}</label>
        <input :id="`${id}-tags`" type="text" autocomplete="off" dir="auto" :value="vm.tagsText" :readonly="vm.isReadOnly"
          @input="vm.tagsText = valueOf($event)">
      </div>
      <div class="fdn-wizard-field">
        <label :for="`${id}-filetypes`" dir="auto">{{ s.skillFileTypes }}</label>
        <input :id="`${id}-filetypes`" type="text" autocomplete="off" dir="ltr" :value="vm.fileTypesText" :readonly="vm.isReadOnly"
          @input="vm.fileTypesText = valueOf($event)">
      </div>
      <div class="fdn-wizard-field">
        <label :for="`${id}-tools`" dir="auto">{{ s.skillPreferredTools }}</label>
        <input :id="`${id}-tools`" type="text" autocomplete="off" dir="ltr" :value="vm.preferredToolsText" :readonly="vm.isReadOnly"
          @input="vm.preferredToolsText = valueOf($event)">
      </div>
      <div class="fdn-wizard-field">
        <label :for="`${id}-priority`" dir="auto">{{ s.skillPriority }}</label>
        <input :id="`${id}-priority`" type="number" min="0" max="100" step="1" dir="ltr" :value="vm.priority" :readonly="vm.isReadOnly" @input="priority">
      </div>
      <div class="fdn-wizard-field">
        <label :for="`${id}-activation`" dir="auto">{{ s.skillActivation }}</label>
        <select :id="`${id}-activation`" :value="vm.activation" :disabled="vm.isReadOnly" @change="vm.activation = valueOf($event)">
          <option v-for="o in vm.activationOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <div class="fdn-wizard-field">
        <label :for="`${id}-license`" dir="auto">{{ s.skillLicense }}</label>
        <input :id="`${id}-license`" type="text" autocomplete="off" dir="auto" :value="vm.license" :readonly="vm.isReadOnly"
          @input="vm.license = valueOf($event)">
      </div>
      <div class="fdn-wizard-field">
        <label :for="`${id}-compatibility`" dir="auto">{{ s.skillCompatibility }}</label>
        <input :id="`${id}-compatibility`" type="text" autocomplete="off" dir="auto" :value="vm.compatibility" :readonly="vm.isReadOnly"
          @input="vm.compatibility = valueOf($event)">
      </div>
      <div v-if="vm.canDropUnknownKeys" class="fdn-wizard-actions">
        <button type="button" class="fdn-button" @click="vm.dropUnknownKeys()">{{ s.skillDropUnknownKeys }}</button>
      </div>
    </form>

    <h3 dir="auto">{{ s.skillResources }}</h3>
    <p v-if="!vm.hasResources" class="fdn-muted" dir="auto">{{ s.skillNoResources }}</p>
    <ul v-else class="fdn-skills-files">
      <SkillResourceRow v-for="row in vm.resources" :key="row.path" :row="row" :strings="s" :read-only="vm.isReadOnly" />
    </ul>
    <div v-if="vm.canAddResource" class="fdn-wizard-actions">
      <button type="button" class="fdn-button" @click="vm.addResourceFromHost()">{{ s.skillAddFile }}</button>
    </div>

    <h3 dir="auto">{{ s.skillChecksHeading }}</h3>
    <p v-if="!vm.hasIssues" class="fdn-skills-ok" dir="auto">{{ s.skillChecksOk }}</p>
    <SkillIssues :items="vm.issues" />

    <div class="fdn-wizard-actions">
      <button v-if="!vm.isReadOnly" type="submit" class="fdn-button fdn-primary" :form="`${id}-form`" :disabled="!vm.canSave">{{ s.skillSave }}</button>
      <button type="button" class="fdn-button fdn-quiet" @click="vm.cancel()">{{ s.skillCancel }}</button>
    </div>

    <section class="fdn-card fdn-skills-try" :aria-labelledby="`${id}-try`">
      <h3 :id="`${id}-try`" dir="auto">{{ s.skillTestHeading }}</h3>
      <form class="fdn-wizard-form" novalidate @submit.prevent="vm.runTest()">
        <div class="fdn-wizard-field">
          <label :for="`${id}-prompt`" dir="auto">{{ s.skillTestPrompt }}</label>
          <input :id="`${id}-prompt`" type="text" autocomplete="off" dir="auto" :value="vm.testPrompt" @input="vm.testPrompt = valueOf($event)">
        </div>
        <div class="fdn-wizard-actions">
          <button type="submit" class="fdn-button">{{ s.skillTestRun }}</button>
          <button v-if="vm.canAskModel" type="button" class="fdn-button" :disabled="!vm.canAsk" @click="vm.askModel()">{{ s.skillAskModel }}</button>
        </div>
      </form>
      <p v-if="vm.canAskModel" class="fdn-muted" dir="auto">{{ vm.modelNote }}</p>
      <!-- What a test or a question says appears once, when it is answered: a polite status, nothing that ticks. -->
      <div class="fdn-wizard-live" role="status">
        <p v-if="vm.modelAnswerText" dir="auto">{{ vm.modelAnswerText }}</p>
        <template v-if="vm.hasTestResult">
          <p v-if="vm.testNote" dir="auto">{{ vm.testNote }}</p>
          <template v-if="vm.testListed.length > 0">
            <p><strong dir="auto">{{ s.skillTestListed }}</strong></p>
            <ul><li v-for="name in vm.testListed" :key="name" dir="auto">{{ name }}</li></ul>
          </template>
          <ul v-if="vm.testMatches.length > 0"><li v-for="line in vm.testMatches" :key="line" dir="auto">{{ line }}</li></ul>
          <template v-if="vm.testPreloaded.length > 0">
            <p><strong dir="auto">{{ s.skillTestPreloaded }}</strong></p>
            <ul><li v-for="name in vm.testPreloaded" :key="name" dir="auto">{{ name }}</li></ul>
          </template>
        </template>
      </div>
    </section>
  </div>
</template>
