<script setup lang="ts">
/** The chats on this device: open one, or delete it. */
import { useTemplateRef } from "vue";

import type { AgentChatViewModel } from "@fadenstack/ui";

import { useDismiss, useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ chat: AgentChatViewModel }>();
const chat = useViewModel(() => props.chat);
const anchor = useTemplateRef<HTMLDivElement>("anchor");
useDismiss(() => chat.value.isHistoryOpen, () => chat.value.setHistoryOpen(false), anchor);
</script>

<template>
  <div ref="anchor" class="fdn-menu-anchor">
    <button
      type="button"
      class="fdn-icon-button"
      :title="chat.strings.history"
      :aria-label="chat.strings.history"
      aria-haspopup="menu"
      :aria-expanded="chat.isHistoryOpen"
      :disabled="!chat.isReady"
      @click="chat.toggleHistory()"
    >
      <Icon name="history" />
    </button>
    <div v-if="chat.isHistoryOpen" class="fdn-menu fdn-history" role="menu" :aria-label="chat.strings.history">
      <div v-if="chat.sessions.length === 0" class="fdn-menu-note">{{ chat.strings.noHistory }}</div>
      <div v-for="session in chat.sessions" :key="session.id" :class="session.isCurrent ? 'fdn-history-item fdn-current' : 'fdn-history-item'">
        <button type="button" role="menuitem" class="fdn-history-open" :disabled="chat.isBusy" @click="chat.openSession(session.id)">
          <span class="fdn-history-title" dir="auto">{{ session.title }}</span>
          <span class="fdn-history-when">{{ session.whenText }}</span>
        </button>
        <button
          type="button"
          class="fdn-icon-button fdn-small"
          :title="chat.strings.deleteSession"
          :aria-label="`${chat.strings.deleteSession}: ${session.title}`"
          :disabled="chat.isBusy && session.isCurrent"
          @click="chat.deleteSession(session.id)"
        >
          <Icon name="trash" :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>
