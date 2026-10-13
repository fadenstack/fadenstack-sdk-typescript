<script setup lang="ts">
/** A host as Vue code would write one: the chat from a prop, a class and a theme on the panel, its own button. */
import type { AgentChatViewModel } from "@fadenstack/ui";
import { ChatPanel } from "@fadenstack/ui-vue";

defineProps<{ chat: AgentChatViewModel }>();
</script>

<template>
  <ChatPanel :chat="chat" class="host-panel" theme="dark">
    <template #header-extra>
      <button type="button" class="host-out">Sign out</button>
    </template>
  </ChatPanel>
</template>
