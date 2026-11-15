<script setup lang="ts">
/** A server found in the pasted configuration, with its tick box and what the person should know before ticking it. */
import type { ImportRowViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";

const props = defineProps<{ row: ImportRowViewModel }>();
const row = useViewModel(() => props.row);
</script>

<template>
  <li class="fdn-card fdn-tp-tool">
    <label class="fdn-wizard-check">
      <input type="checkbox" :checked="row.isTicked" :aria-label="row.tickName" @change="row.isTicked = ($event.target as HTMLInputElement).checked">
      <span class="fdn-tp-name" dir="auto">{{ row.label }}</span>
    </label>
    <div class="fdn-muted fdn-tp-where" dir="auto">{{ row.where }}</div>
    <p v-for="(n, i) in row.notes" :key="i" class="fdn-tp-help" dir="auto">{{ n }}</p>
  </li>
</template>
