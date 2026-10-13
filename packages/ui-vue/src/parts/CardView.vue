<script setup lang="ts">
import type { CardPart, UiStrings } from "@fadenstack/ui";

/** A card a module adds: a title, a subtitle and fields. */
defineProps<{ part: CardPart; strings?: UiStrings }>();
</script>

<template>
  <div class="fdn-card" dir="auto">
    <strong>{{ part.title }}</strong>
    <div v-if="part.subtitle" class="fdn-muted">{{ part.subtitle }}</div>
    <dl>
      <div v-for="(f, i) in part.fields" :key="i"><dt>{{ f.label }}</dt><dd>{{ f.value }}</dd></div>
    </dl>
  </div>
</template>
