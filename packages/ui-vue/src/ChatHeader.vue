<script setup lang="ts">
/** The panel's top bar: the agent, the tool mode, the history, a new chat, and (the default slot) the host's own buttons. */
import type { AgentChatViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import HistoryMenu from "./HistoryMenu.vue";
import Icon from "./Icon.vue";
import ModeMenu from "./ModeMenu.vue";

const props = defineProps<{ chat: AgentChatViewModel }>();
defineSlots<{ default?(): unknown }>();
const chat = useViewModel(() => props.chat);
</script>

<template>
  <header class="fdn-header">
    <div class="fdn-header-title" :title="chat.title" dir="auto">{{ chat.title }}</div>
    <ModeMenu :chat="chat" />
    <HistoryMenu :chat="chat" />
    <button
      type="button"
      class="fdn-icon-button"
      :title="chat.strings.newChat"
      :aria-label="chat.strings.newChat"
      :disabled="!chat.isReady || chat.isBusy"
      @click="chat.newChat()"
    >
      <Icon name="plus" />
    </button>
    <slot />
  </header>
</template>
