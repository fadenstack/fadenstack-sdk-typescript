<script setup lang="ts">
import type { ToolCallPart, UiStrings } from "@fadenstack/ui";
import { toolBadges, toolClassName, toolStatusIcon } from "@fadenstack/ui-web";

import { useViewModel } from "../composables.js";
import Icon from "../Icon.vue";
import Spinner from "../Spinner.vue";

/** One tool call: a line ("Ran read_page"), expandable to its input and output. */
const props = defineProps<{ part: ToolCallPart; strings: UiStrings }>();
const part = useViewModel(() => props.part);
</script>

<template>
  <div :class="toolClassName(part)">
    <button type="button" class="fdn-tool-line" :aria-expanded="part.isExpanded" :disabled="!part.hasDetails" @click="part.toggle()">
      <span class="fdn-tool-status"><Icon v-if="toolStatusIcon(part)" :name="toolStatusIcon(part)!" :size="14" /><Spinner v-else /></span>
      <span class="fdn-tool-title">{{ part.title }}</span>
      <span v-for="badge in toolBadges(part, strings)" :key="badge.className" :class="badge.className">{{ badge.text }}</span>
      <span class="fdn-tool-duration">{{ part.durationText }}</span>
      <span v-if="part.hasDetails" :class="part.isExpanded ? 'fdn-chevron fdn-open' : 'fdn-chevron'"><Icon name="chevron" :size="14" /></span>
    </button>
    <div v-if="part.isExpanded" class="fdn-tool-details">
      <template v-if="part.argumentsText">
        <div class="fdn-label">{{ strings.arguments }}</div>
        <pre dir="auto">{{ part.argumentsText }}</pre>
      </template>
      <template v-if="part.resultText">
        <div class="fdn-label">{{ strings.result }}</div>
        <pre dir="auto">{{ part.resultText }}</pre>
      </template>
    </div>
  </div>
</template>
