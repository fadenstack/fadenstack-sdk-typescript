<script setup lang="ts">
import type { ReasoningPart, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "../composables.js";
import Icon from "../Icon.vue";
import Spinner from "../Spinner.vue";

/** The model's reasoning: collapsed, "Thinking..." while it streams, then "Thought for 4 s". */
const props = defineProps<{ part: ReasoningPart; strings?: UiStrings }>();
const part = useViewModel(() => props.part);
</script>

<template>
  <div class="fdn-collapsible">
    <button type="button" class="fdn-collapsible-head" :aria-expanded="part.isExpanded" @click="part.toggle()">
      <Spinner v-if="part.isStreaming" />
      <Icon v-else name="brain" :size="14" />
      <span>{{ part.title }}</span>
      <span :class="part.isExpanded ? 'fdn-chevron fdn-open' : 'fdn-chevron'"><Icon name="chevron" :size="14" /></span>
    </button>
    <div v-if="part.isExpanded" class="fdn-reasoning" dir="auto">{{ part.text }}</div>
  </div>
</template>
