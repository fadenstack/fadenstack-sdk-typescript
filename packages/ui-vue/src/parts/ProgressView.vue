<script setup lang="ts">
import type { ProgressPart, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "../composables.js";

/** Progress a module reports, from 0 to 1. */
const props = defineProps<{ part: ProgressPart; strings?: UiStrings }>();
const part = useViewModel(() => props.part);
</script>

<template>
  <div class="fdn-progress">
    <span>{{ part.label }}</span>
    <progress :value="part.value" :max="1" :aria-label="part.label" />
  </div>
</template>
