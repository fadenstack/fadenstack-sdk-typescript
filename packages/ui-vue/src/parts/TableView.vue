<script setup lang="ts">
import type { TablePart, UiStrings } from "@fadenstack/ui";

/** A table a module adds. */
defineProps<{ part: TablePart; strings?: UiStrings }>();
</script>

<template>
  <div class="fdn-md-table">
    <div v-if="part.title" class="fdn-label">{{ part.title }}</div>
    <table dir="auto">
      <thead><tr><th v-for="(h, i) in part.headers" :key="i">{{ h }}</th></tr></thead>
      <tbody><tr v-for="(row, r) in part.rows" :key="r"><td v-for="(c, i) in row" :key="i">{{ c }}</td></tr></tbody>
    </table>
  </div>
</template>
