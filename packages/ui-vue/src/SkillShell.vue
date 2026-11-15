<script setup lang="ts">
/** The skill views' shell: the wizard's own column, a little wider (parity with `Shell` in @fadenstack/ui-react). A listener on it (`@keydown`) lands on the root. */
import type { UiStrings } from "@fadenstack/ui";

import type { ChatTheme } from "./types.js";

defineProps<{
  strings: UiStrings;
  theme: ChatTheme;
  busy: boolean;
  /** A class of the view that uses the shell (the Tools view's `fdn-tools`). */
  extraClass?: string;
}>();
</script>

<template>
  <div class="fdn-chat fdn-wizard fdn-skills" :class="extraClass" :data-theme="theme" :lang="strings.language" :dir="strings.direction">
    <div class="fdn-wizard-column fdn-skills-column" tabindex="-1" :aria-busy="busy">
      <slot />
    </div>
  </div>
</template>
