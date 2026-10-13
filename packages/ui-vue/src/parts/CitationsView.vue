<script setup lang="ts">
import type { CitationsPart, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "../composables.js";
import Icon from "../Icon.vue";

/** "Used 3 references", expandable. */
const props = defineProps<{ part: CitationsPart; strings?: UiStrings }>();
const part = useViewModel(() => props.part);
</script>

<template>
  <div class="fdn-collapsible">
    <button type="button" class="fdn-collapsible-head" :aria-expanded="part.isExpanded" @click="part.toggle()">
      <Icon name="book" :size="14" />
      <span>{{ part.title }}</span>
      <span :class="part.isExpanded ? 'fdn-chevron fdn-open' : 'fdn-chevron'"><Icon name="chevron" :size="14" /></span>
    </button>
    <ol v-if="part.isExpanded" class="fdn-citations">
      <li v-for="(c, i) in part.citations" :key="i" dir="auto">{{ c.title }}<span v-if="c.detail" class="fdn-muted"> · {{ c.detail }}</span></li>
    </ol>
  </div>
</template>
