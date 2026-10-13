<script setup lang="ts">
/** A copy button that shows a tick for a moment after copying. */
import { onBeforeUnmount, ref } from "vue";

import type { UiStrings } from "@fadenstack/ui";
import { COPIED_MS } from "@fadenstack/ui-web";

import Icon from "../Icon.vue";

const props = defineProps<{ label: string; strings: UiStrings; copy: () => void }>();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function onClick(): void {
  props.copy();
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => (copied.value = false), COPIED_MS);
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <button type="button" class="fdn-icon-button fdn-small" :aria-label="label" :title="copied ? strings.copied : label" @click="onClick">
    <Icon :name="copied ? 'check' : 'copy'" :size="14" />
  </button>
</template>
