<script setup lang="ts">
/**
 * The setting for content logging, where an app keeps its settings (8.1): only where the app offers it and the machine policy allows it, a
 * choice of 1 hour, 4 hours or 24 hours, Start and Stop, the end time while it is on, and what is logged. The texts are the view model's;
 * the buttons and their state are too. Parity with `@fadenstack/ui-react`'s `ContentLoggingSettings`; .NET: `ContentLoggingSettingsView`
 * in both skins.
 */
import { computed, ref, useId } from "vue";

import type { ContentLoggingSettingsViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import SkillShell from "./SkillShell.vue";
import { useFirstFocus } from "./skills.js";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The setting's view model (`new ContentLoggingSettingsViewModel({ agent })`). Call its `dispose()` when the page goes. */
  settings: ContentLoggingSettingsViewModel;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { theme: "system" });

const vm = useViewModel(() => props.settings);
const s = computed(() => vm.value.strings);
const id = useId();
const root = ref<InstanceType<typeof SkillShell> | null>(null);
useFirstFocus(root, () => props.settings);
</script>

<template>
  <SkillShell v-if="vm.isAvailable" ref="root" :strings="s" :theme="theme" :busy="false">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ s.contentLoggingTitle }}</h2>
    <p class="fdn-wizard-note" dir="auto">{{ vm.introText }}</p>
    <form class="fdn-wizard-form" novalidate @submit.prevent="vm.start()">
      <div class="fdn-wizard-field">
        <label :for="`${id}-duration`" dir="auto">{{ s.contentLoggingDuration }}</label>
        <select :id="`${id}-duration`" :value="vm.selectedIndex" :disabled="!vm.canStart" data-wizard-focus
          @change="vm.selectedIndex = Number(($event.target as HTMLSelectElement).value)">
          <option v-for="(choice, index) in vm.choices" :key="choice.durationMs" :value="index" :selected="index === vm.selectedIndex">{{ choice.text }}</option>
        </select>
      </div>
      <div class="fdn-wizard-actions">
        <button type="submit" class="fdn-button fdn-primary" :disabled="!vm.canStart" :aria-label="s.contentLoggingStartName" dir="auto">{{ s.contentLoggingStart }}</button>
        <button type="button" class="fdn-button" :disabled="!vm.canStop" :aria-label="s.contentLoggingStopName" dir="auto" @click="vm.stop()">{{ s.markerStop }}</button>
      </div>
      <p class="fdn-skills-message" role="status" dir="auto">{{ vm.onUntilText }}</p>
    </form>
  </SkillShell>
</template>
