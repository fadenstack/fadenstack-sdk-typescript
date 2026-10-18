<script setup lang="ts">
/**
 * The settings: the language to pick (or the one the organisation fixed), (the default slot) the host's own items,
 * and last About, which opens below the same gear.
 */
import { computed, useSlots, useTemplateRef } from "vue";

import type { AgentChatViewModel } from "@fadenstack/ui";

import AboutPanel from "./AboutPanel.vue";
import { useDismiss, useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ chat: AgentChatViewModel }>();
defineSlots<{ default?(): unknown }>();
const slots = useSlots();
const chat = useViewModel(() => props.chat);
const anchor = useTemplateRef<HTMLDivElement>("anchor");
const gear = useTemplateRef<HTMLButtonElement>("gear");
useDismiss(() => chat.value.isSettingsOpen, () => chat.value.setSettingsOpen(false), anchor);
useDismiss(() => chat.value.isAboutOpen, () => chat.value.setAboutOpen(false), anchor);
const languages = computed(() => chat.value.canChangeLanguage || chat.value.isLanguageLocked);

function closeAbout(returnFocus: boolean): void {
  chat.value.setAboutOpen(false);
  if (returnFocus) gear.value?.focus();
}
</script>

<template>
  <div ref="anchor" class="fdn-menu-anchor">
    <button
      ref="gear"
      type="button"
      :class="chat.isAboutOpen ? 'fdn-icon-button fdn-open' : 'fdn-icon-button'"
      :title="chat.strings.settings"
      :aria-label="chat.strings.settings"
      aria-haspopup="menu"
      :aria-expanded="chat.isSettingsOpen"
      @click="chat.setSettingsOpen(!chat.isSettingsOpen)"
    >
      <Icon name="settings" />
    </button>
    <div v-if="chat.isSettingsOpen" class="fdn-menu fdn-settings" role="menu" :aria-label="chat.strings.settings">
      <div v-if="languages" role="group" :aria-label="chat.strings.languageMenu">
        <div class="fdn-menu-heading">{{ chat.strings.languageMenu }}</div>
        <button
          v-for="o in chat.languageOptions"
          :key="o.id"
          type="button"
          role="menuitemradio"
          :aria-checked="o.selected"
          :disabled="!chat.canChangeLanguage"
          class="fdn-menu-item"
          :lang="o.lang"
          @click="chat.setLanguage(o.id)"
        >
          <span class="fdn-menu-check"><Icon v-if="o.selected" name="check" :size="14" /></span>
          <span class="fdn-menu-label">{{ o.label }}</span>
        </button>
        <div v-if="chat.isLanguageLocked" class="fdn-menu-note">{{ chat.strings.languageLocked }}</div>
      </div>
      <div v-if="slots.default" v-bind="languages ? { class: 'fdn-menu-extra' } : {}"><slot /></div>
      <div v-bind="languages || slots.default ? { class: 'fdn-menu-extra' } : {}">
        <button type="button" role="menuitem" aria-haspopup="dialog" class="fdn-menu-item" @click="chat.setAboutOpen(true)">
          <span class="fdn-menu-check" />
          <span class="fdn-menu-label">{{ chat.strings.about }}</span>
        </button>
      </div>
    </div>
    <AboutPanel v-if="chat.isAboutOpen" :chat="chat" @close="closeAbout" />
  </div>
</template>
