<script setup lang="ts">
/**
 * The thinking pill: how long the agent thinks before it answers (Auto, Off, and the levels up to the server's maximum), with
 * what each level means. Enter or Space opens the menu, the arrows move, Enter or Space picks, Escape closes; the focus returns
 * to the pill. .NET: the pill beside the tool mode in `ChatView`.
 */
import { nextTick, useTemplateRef, watch } from "vue";

import type { AgentChatViewModel } from "@fadenstack/ui";
import { focusCurrentItem, menuKey } from "@fadenstack/ui-web";

import { useDismiss, useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ chat: AgentChatViewModel }>();
const chat = useViewModel(() => props.chat);
const anchor = useTemplateRef<HTMLDivElement>("anchor");
const pill = useTemplateRef<HTMLButtonElement>("pill");
const menu = useTemplateRef<HTMLDivElement>("menu");
const close = () => chat.value.setReasoningMenuOpen(false);
useDismiss(() => chat.value.isReasoningMenuOpen, close, anchor);
watch(() => chat.value.isReasoningMenuOpen, async (open) => {
  if (!open) return;
  await nextTick();
  if (menu.value) focusCurrentItem(menu.value);
}, { immediate: true, flush: "post" });

function onKeyDown(e: KeyboardEvent): void {
  if (menu.value && menuKey(menu.value, e) === "close") {
    close();
    pill.value?.focus();
  }
}

function pick(level: Parameters<AgentChatViewModel["selectReasoning"]>[0]): void {
  void chat.value.selectReasoning(level);
  pill.value?.focus();
}
</script>

<template>
  <div ref="anchor" class="fdn-menu-anchor">
    <button
      ref="pill"
      type="button"
      class="fdn-mode-button fdn-reasoning-button"
      aria-haspopup="menu"
      :aria-expanded="chat.isReasoningMenuOpen"
      :aria-label="chat.reasoningAutomationName"
      :title="chat.reasoningToolTip"
      :disabled="!chat.isReady"
      @click="chat.setReasoningMenuOpen(!chat.isReasoningMenuOpen)"
    >
      <Icon name="brain" :size="14" />
      <span>{{ chat.reasoningPillText }}</span>
      <Icon name="chevron" :size="14" />
    </button>
    <div v-if="chat.isReasoningMenuOpen" ref="menu" class="fdn-menu fdn-reasoning" role="menu" :aria-label="chat.strings.reasoningMenu" @keydown="onKeyDown">
      <div class="fdn-menu-heading">{{ chat.strings.reasoningMenu }}</div>
      <button
        v-for="o in chat.reasoningOptions"
        :key="o.level"
        type="button"
        role="menuitemradio"
        :aria-checked="o.selected"
        class="fdn-menu-item"
        @click="pick(o.level)"
      >
        <span class="fdn-menu-check"><Icon v-if="o.selected" name="check" :size="14" /></span>
        <span>
          <span class="fdn-menu-label">{{ o.label }}</span>
          <span class="fdn-menu-description">{{ o.description }}</span>
        </span>
      </button>
    </div>
  </div>
</template>
