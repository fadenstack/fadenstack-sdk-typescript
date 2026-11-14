<script setup lang="ts">
/** A list of what the checks found: errors in the danger colour, warnings in the warning colour. */
import type { SkillIssueView } from "@fadenstack/ui";

defineProps<{
  items: readonly SkillIssueView[];
  id?: string;
}>();
</script>

<template>
  <ul v-if="items.length > 0" :id="id" class="fdn-skills-issues">
    <li v-for="(item, i) in items" :key="i" :class="item.isError ? 'fdn-skills-issue fdn-skills-issue-error' : 'fdn-skills-issue'" dir="auto">{{ item.text }}</li>
  </ul>
</template>
