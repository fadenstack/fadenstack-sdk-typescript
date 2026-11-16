<script setup lang="ts">
/**
 * The setting for old chats, where an app keeps its settings: a switch for automatic deletion, the two limits (days, chats), Save and
 * Cancel. Where the organisation decides (governed) or the machine policy on this computer fixes it, the values are shown (or one
 * sentence) and cannot be changed. The texts are the view model's; the checks and the buttons are too. Parity with `@fadenstack/ui-react`'s
 * `ChatRetentionSettings`; .NET: `ChatRetentionSettingsView` in both skins.
 */
import { computed, ref, useId } from "vue";

import type { ChatRetentionSettingsViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import SkillShell from "./SkillShell.vue";
import { useFirstFocus } from "./skills.js";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The setting's view model (`new ChatRetentionSettingsViewModel({ agent })`). Call its `load()` once when the page opens. */
  settings: ChatRetentionSettingsViewModel;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { theme: "system" });

const vm = useViewModel(() => props.settings);
const s = computed(() => vm.value.strings);
const id = useId();
const root = ref<InstanceType<typeof SkillShell> | null>(null);
useFirstFocus(root, () => props.settings);

function submit(): void {
  void vm.value.save();
}
</script>

<template>
  <SkillShell ref="root" :strings="s" :theme="theme" :busy="false">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ s.chatRetentionTitle }}</h2>
    <p v-if="vm.showNote" class="fdn-wizard-note" role="status" dir="auto">{{ vm.note }}</p>
    <form v-if="vm.showControls" class="fdn-wizard-form" novalidate @submit.prevent="submit">
      <div class="fdn-wizard-check">
        <input :id="`${id}-auto`" type="checkbox" role="switch" :checked="vm.autoDelete" :disabled="!vm.canEdit" :aria-describedby="`${id}-hint`" data-wizard-focus
          @change="vm.autoDelete = ($event.target as HTMLInputElement).checked">
        <label :for="`${id}-auto`" dir="auto">{{ s.chatRetentionAutoDelete }}</label>
      </div>
      <p :id="`${id}-hint`" class="fdn-wizard-note" dir="auto">{{ s.chatRetentionAutoDeleteHint }}</p>

      <div class="fdn-wizard-field">
        <label :for="`${id}-days`" dir="auto">{{ s.chatRetentionMaxAge }}</label>
        <input :id="`${id}-days`" type="text" inputmode="numeric" autocomplete="off" :value="vm.maxAgeDaysText" :disabled="!vm.limitsEnabled"
          :aria-invalid="vm.hasDaysError || undefined" :aria-describedby="vm.hasDaysError ? `${id}-days-error` : undefined"
          @input="vm.maxAgeDaysText = ($event.target as HTMLInputElement).value">
      </div>
      <p v-if="vm.hasDaysError" :id="`${id}-days-error`" class="fdn-wizard-error" role="alert" dir="auto">{{ vm.daysError }}</p>

      <div class="fdn-wizard-field">
        <label :for="`${id}-chats`" dir="auto">{{ s.chatRetentionMaxSessions }}</label>
        <input :id="`${id}-chats`" type="text" inputmode="numeric" autocomplete="off" :value="vm.maxSessionsText" :disabled="!vm.limitsEnabled"
          :aria-invalid="vm.hasChatsError || undefined" :aria-describedby="vm.hasChatsError ? `${id}-chats-error` : undefined"
          @input="vm.maxSessionsText = ($event.target as HTMLInputElement).value">
      </div>
      <p v-if="vm.hasChatsError" :id="`${id}-chats-error`" class="fdn-wizard-error" role="alert" dir="auto">{{ vm.chatsError }}</p>

      <div v-if="vm.canEdit" class="fdn-wizard-actions">
        <button type="submit" class="fdn-button fdn-primary" :disabled="!vm.canSave" :aria-label="s.chatRetentionSaveName" dir="auto">{{ s.chatRetentionSave }}</button>
        <button type="button" class="fdn-button" :disabled="!vm.canCancel" :aria-label="s.chatRetentionCancelName" dir="auto" @click="vm.cancel()">{{ s.chatRetentionCancel }}</button>
      </div>
      <p class="fdn-skills-message" role="status" dir="auto">{{ vm.statusText }}</p>
    </form>
  </SkillShell>
</template>
