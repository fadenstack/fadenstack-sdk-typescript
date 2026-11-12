<script setup lang="ts">
/**
 * The skills to pick from, above the composer, narrowed by what follows the `$`. With a prompt store the user's own
 * prompts come first, in a section of their own; the headings between the sections are presentational.
 */
import { computed } from "vue";

import type { SkillPickerViewModel, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ picker: SkillPickerViewModel; strings: UiStrings; listId: string }>();
const picker = useViewModel(() => props.picker);
const prompts = computed(() => picker.value.promptOptions);

// Picked on press, before the text box loses the focus (and the caret its place).
function press(e: MouseEvent, index: number): void {
  e.preventDefault();
  const skill = picker.value.options[index];
  if (skill) picker.value.pick(skill);
}

function pressPrompt(e: MouseEvent, index: number): void {
  e.preventDefault();
  const prompt = prompts.value[index];
  if (prompt) picker.value.pickPrompt(prompt);
}

// Not a pick, and the text box keeps its focus.
function holdFocus(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

function remove(e: MouseEvent, id: string): void {
  e.stopPropagation();
  void picker.value.removePrompt(id);
}
</script>

<template>
  <div v-if="!picker.hasPromptStore" class="fdn-menu fdn-skill-picker">
    <span :id="`${picker.key}-label`" class="fdn-menu-heading">{{ strings.skills }}</span>
    <div v-if="picker.isLoading" class="fdn-menu-note" role="status">{{ strings.skillsLoading }}</div>
    <div v-else-if="picker.failed" class="fdn-menu-note" role="alert">{{ strings.skillsFailed }}</div>
    <div v-else-if="picker.options.length === 0" class="fdn-menu-note" role="status">
      {{ picker.hasSkills ? strings.noSkillMatches(picker.query) : strings.noSkills }}
    </div>
    <div :id="listId" class="fdn-skill-list" role="listbox" :aria-labelledby="`${picker.key}-label`">
      <div
        v-for="(s, i) in picker.options"
        :id="`${picker.key}-${i}`"
        :key="s.slug"
        role="option"
        :aria-selected="i === picker.activeIndex"
        class="fdn-menu-item fdn-skill-option"
        @mousedown="press($event, i)"
      >
        <span class="fdn-menu-check"><Icon name="sparkle" :size="14" /></span>
        <span>
          <span class="fdn-menu-label" dir="auto">{{ s.name }}</span>
          <span v-if="s.description" class="fdn-menu-description" dir="auto">{{ s.description }}</span>
        </span>
      </div>
    </div>
    <div v-if="picker.options.length > 0" class="fdn-menu-note fdn-skill-hint">{{ strings.skillPickerHint }}</div>
  </div>
  <div v-else class="fdn-menu fdn-skill-picker">
    <div :id="listId" class="fdn-skill-list" role="listbox" :aria-label="picker.hasSkillSection ? strings.promptsAndSkills : strings.myPrompts">
      <div class="fdn-menu-heading" role="presentation">{{ strings.myPrompts }}</div>
      <div v-if="prompts.length === 0" class="fdn-menu-note" role="presentation">
        {{ picker.hasPrompts ? strings.noPromptMatches(picker.query) : strings.noPrompts }}
      </div>
      <div
        v-for="(p, i) in prompts"
        :id="`${picker.key}-${i}`"
        :key="p.id"
        role="option"
        :aria-selected="i === picker.activeIndex"
        class="fdn-menu-item fdn-skill-option fdn-prompt-option"
        @mousedown="pressPrompt($event, i)"
      >
        <span class="fdn-menu-check"><Icon name="page" :size="14" /></span>
        <span>
          <span class="fdn-menu-label" dir="auto">{{ p.title }}</span>
          <span v-if="p.text !== p.title" class="fdn-menu-description" dir="auto">{{ p.text }}</span>
        </span>
        <button
          type="button"
          class="fdn-icon-button fdn-small fdn-prompt-delete"
          tabindex="-1"
          :title="strings.deletePrompt"
          :aria-label="`${strings.deletePrompt}: ${p.title}`"
          @mousedown="holdFocus"
          @click="remove($event, p.id)"
        >
          <Icon name="trash" :size="14" />
        </button>
      </div>
      <template v-if="picker.hasSkillSection">
        <div class="fdn-menu-heading" role="presentation">{{ strings.organisationSkills }}</div>
        <div v-if="picker.isLoading || picker.failed || picker.options.length === 0" role="presentation">
          <div v-if="picker.isLoading" class="fdn-menu-note" role="status">{{ strings.skillsLoading }}</div>
          <div v-else-if="picker.failed" class="fdn-menu-note" role="alert">{{ strings.skillsFailed }}</div>
          <div v-else class="fdn-menu-note" role="status">
            {{ picker.hasSkills ? strings.noSkillMatches(picker.query) : strings.noSkills }}
          </div>
        </div>
        <div
          v-for="(s, i) in picker.options"
          :id="`${picker.key}-${prompts.length + i}`"
          :key="s.slug"
          role="option"
          :aria-selected="prompts.length + i === picker.activeIndex"
          class="fdn-menu-item fdn-skill-option"
          @mousedown="press($event, i)"
        >
          <span class="fdn-menu-check"><Icon name="sparkle" :size="14" /></span>
          <span>
            <span class="fdn-menu-label" dir="auto">{{ s.name }}</span>
            <span v-if="s.description" class="fdn-menu-description" dir="auto">{{ s.description }}</span>
          </span>
        </div>
      </template>
    </div>
    <div v-if="picker.entries.length > 0" class="fdn-menu-note fdn-skill-hint">{{ strings.promptPickerHint }}</div>
  </div>
</template>
