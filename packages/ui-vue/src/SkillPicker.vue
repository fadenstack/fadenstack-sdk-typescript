<script setup lang="ts">
/** The skills to pick from, above the composer, narrowed by what follows the `$`. */
import type { SkillPickerViewModel, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ picker: SkillPickerViewModel; strings: UiStrings; listId: string }>();
const picker = useViewModel(() => props.picker);

// Picked on press, before the text box loses the focus (and the caret its place).
function press(e: MouseEvent, index: number): void {
  e.preventDefault();
  const skill = picker.value.options[index];
  if (skill) picker.value.pick(skill);
}
</script>

<template>
  <div class="fdn-menu fdn-skill-picker">
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
</template>
