<script setup lang="ts">
/** The tool-mode picker, with what each mode means and "Reset approvals". */
import { computed, useTemplateRef } from "vue";

import type { AgentChatViewModel } from "@fadenstack/ui";

import { useDismiss, useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ chat: AgentChatViewModel }>();
const chat = useViewModel(() => props.chat);
const anchor = useTemplateRef<HTMLDivElement>("anchor");
useDismiss(() => chat.value.isModeMenuOpen, () => chat.value.setModeMenuOpen(false), anchor);
const current = computed(() => chat.value.toolModes.find((o) => o.mode === chat.value.toolMode));
</script>

<template>
  <div ref="anchor" class="fdn-menu-anchor">
    <button
      type="button"
      class="fdn-mode-button"
      aria-haspopup="menu"
      :aria-expanded="chat.isModeMenuOpen"
      :aria-label="`${chat.strings.toolMode}: ${current?.label ?? ''}`"
      :title="`${chat.strings.toolMode}: ${chat.toolModeHint}`"
      :disabled="!chat.isReady"
      @click="chat.setModeMenuOpen(!chat.isModeMenuOpen)"
    >
      <Icon name="tool" :size="14" />
      <span>{{ current?.label }}</span>
      <Icon name="chevron" :size="14" />
    </button>
    <div v-if="chat.isModeMenuOpen" class="fdn-menu" role="menu" :aria-label="chat.strings.toolMode">
      <button
        v-for="o in chat.toolModes"
        :key="o.mode"
        type="button"
        role="menuitemradio"
        :aria-checked="o.mode === chat.toolMode"
        :disabled="!o.available"
        class="fdn-menu-item"
        @click="chat.selectToolMode(o.mode)"
      >
        <span class="fdn-menu-check"><Icon v-if="o.mode === chat.toolMode" name="check" :size="14" /></span>
        <span>
          <span class="fdn-menu-label">{{ o.label }}</span>
          <span class="fdn-menu-description">{{ o.description }}</span>
        </span>
      </button>
      <div v-if="chat.toolModeHint !== chat.strings.modes[chat.toolMode].description" class="fdn-menu-note">{{ chat.toolModeHint }}</div>
      <button type="button" role="menuitem" class="fdn-menu-item" @click="chat.resetApprovals()">
        <span class="fdn-menu-check" />
        <span class="fdn-menu-label">{{ chat.strings.resetApprovals }}</span>
      </button>
    </div>
  </div>
</template>
