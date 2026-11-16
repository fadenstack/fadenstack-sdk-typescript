<script setup lang="ts">
/**
 * The web search settings as a view of its own (sdk/51 F06), for an app that has a Tools page of its own (the desktop). The same
 * sheet opens inside `ToolsPage` on "In this app". Parity with `WebSearchSettings` in `@fadenstack/ui-react`.
 */
import { computed, ref } from "vue";

import type { WebSearchSettingsViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import SkillShell from "./SkillShell.vue";
import { useFirstFocus } from "./skills.js";
import type { ChatTheme } from "./types.js";
import WebSearchSheet from "./WebSearchSheet.vue";

const props = withDefaults(defineProps<{
  /** The sheet's view model (`new WebSearchSettingsViewModel({ store })`); the app calls `retext()` when the language changes and `dispose()` when it is done. */
  settings: WebSearchSettingsViewModel;

  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { theme: "system" });

const vm = useViewModel(() => props.settings);
const s = computed(() => vm.value.strings);
const shell = ref<{ $el: Element } | null>(null);
useFirstFocus(shell, () => "sheet");
</script>

<template>
  <SkillShell ref="shell" :strings="s" :theme="theme" :busy="vm.isBusy" extra-class="fdn-websearch">
    <WebSearchSheet :sheet="settings" />
  </SkillShell>
</template>
