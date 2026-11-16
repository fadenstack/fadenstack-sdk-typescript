<script setup lang="ts">
/**
 * "Stop everything", the emergency stop for an app's tray menu or title bar: an icon button named "Stop everything" with a tooltip, and
 * the line that says what it did. No confirmation. The texts and the stop are the view model's. Parity with `@fadenstack/ui-react`'s
 * `StopEverythingButton`.
 */
import { computed } from "vue";

import type { StopEverythingViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The control's view model (`new StopEverythingViewModel({ agents: () => [...] })`). */
  stop: StopEverythingViewModel;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { theme: "system" });

const vm = useViewModel(() => props.stop);
const s = computed(() => vm.value.strings);
</script>

<template>
  <div class="fdn-chat fdn-stop-everything" :data-theme="theme" :lang="s.language" :dir="s.direction">
    <button type="button" class="fdn-icon-button fdn-stop-everything-button" :aria-label="vm.name" :title="vm.toolTip" :disabled="!vm.canStop"
      :aria-busy="vm.isBusy" @click="vm.stop()">
      <Icon name="stop" :size="16" />
    </button>
    <span v-if="vm.hasResult" class="fdn-stop-everything-result" role="status" dir="auto">{{ vm.resultText }}</span>
  </div>
</template>
