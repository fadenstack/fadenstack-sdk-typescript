<script setup lang="ts">
/** A skill in the library list: its name and description, where it comes from, "not reviewed", its switch, and what may be done with it. */
import { useId } from "vue";

import type { SkillLibraryViewModel, SkillRowViewModel, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";

const props = defineProps<{
  library: SkillLibraryViewModel;
  row: SkillRowViewModel;
  strings: UiStrings;
}>();

const row = useViewModel(() => props.row);
const id = useId();
</script>

<template>
  <li class="fdn-card fdn-skills-row" :aria-labelledby="`${id}-name`">
    <div class="fdn-skills-row-head">
      <div>
        <div :id="`${id}-name`" class="fdn-skills-name" dir="auto">{{ row.name }}</div>
        <div class="fdn-muted" dir="auto">{{ row.description }}</div>
        <!-- A skill that cannot be read: why, and that it can be opened or deleted. -->
        <p v-if="row.isBroken" class="fdn-skills-issue fdn-skills-issue-error" dir="auto">{{ row.brokenText }}</p>
      </div>
      <label v-if="library.canToggle(row)" class="fdn-skills-switch">
        <input type="checkbox" role="switch" :checked="row.isEnabled" :aria-label="row.name" @change="library.toggle(row)">
        <span>{{ row.switchLabel }}</span>
      </label>
    </div>
    <div class="fdn-skills-badges">
      <span class="fdn-badge" dir="auto">{{ row.originLabel }}</span>
      <span v-if="row.isNotReviewed" class="fdn-badge fdn-class-write" dir="auto">{{ row.statusLabel }}</span>
    </div>
    <div class="fdn-wizard-actions">
      <button v-if="row.canOpen" type="button" class="fdn-button" :disabled="!library.canEdit(row)" :aria-label="row.isReadOnly ? row.viewLabel : row.editLabel"
        @click="library.edit(row)">{{ row.isReadOnly ? strings.skillView : strings.skillEdit }}</button>
      <button v-if="row.canDuplicate" type="button" class="fdn-button fdn-quiet" :disabled="!library.canDuplicate(row)" :aria-label="row.duplicateLabel"
        @click="library.duplicate(row)">{{ strings.skillDuplicate }}</button>
      <button v-if="row.canExport" type="button" class="fdn-button fdn-quiet" :disabled="!library.canExport(row)" :aria-label="row.exportLabel"
        @click="library.export(row)">{{ strings.skillExport }}</button>
      <button v-if="library.canAskDelete(row)" type="button" class="fdn-button fdn-quiet" :aria-label="row.deleteLabel"
        @click="library.askDelete(row)">{{ strings.skillDelete }}</button>
    </div>
  </li>
</template>
