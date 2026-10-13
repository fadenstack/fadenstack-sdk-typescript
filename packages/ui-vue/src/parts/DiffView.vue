<script setup lang="ts">
import type { DiffPart, UiStrings } from "@fadenstack/ui";
import { diffMarker } from "@fadenstack/ui-web";

/** A change a module proposes, line by line. */
defineProps<{ part: DiffPart; strings?: UiStrings }>();
</script>

<template>
  <div class="fdn-diff">
    <div class="fdn-label">{{ part.title }}</div>
    <pre><div v-for="(l, i) in part.lines" :key="i" :class="`fdn-diff-${l.kind}`">{{ diffMarker(l.kind) }}{{ l.text }}</div></pre>
  </div>
</template>
