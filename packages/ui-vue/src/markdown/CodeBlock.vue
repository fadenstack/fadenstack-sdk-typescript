<script setup lang="ts">
import type { UiStrings } from "@fadenstack/ui";

import CopyButton from "./CopyButton.vue";

/** A code block: its language and a copy button once it is complete. Code runs left to right in any language. */
const props = defineProps<{
  language: string | null;
  code: string;
  complete: boolean;
  strings: UiStrings;
  copy?: ((code: string) => void) | undefined;
}>();
const copyThis = () => props.copy?.(props.code);
</script>

<template>
  <div class="fdn-md-code" dir="ltr">
    <div class="fdn-md-code-bar">
      <span>{{ language ?? "" }}</span>
      <CopyButton v-if="copy && complete" :label="strings.copyCode" :strings="strings" :copy="copyThis" />
    </div>
    <pre><code>{{ code }}</code></pre>
  </div>
</template>
