<script setup lang="ts">
/**
 * Under the composer: that the answers come from an AI, and below it, on a line of its own, the muted Fadenstack
 * link (`branding`).
 */
import type { AgentChatViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import ExternalLink from "./ExternalLink.vue";

const props = defineProps<{ chat: AgentChatViewModel }>();
const chat = useViewModel(() => props.chat);
</script>

<template>
  <div v-if="chat.strings.aiNotice || chat.footerLink" class="fdn-footer">
    <p v-if="chat.strings.aiNotice" class="fdn-ai-notice" dir="auto">{{ chat.strings.aiNotice }}</p>
    <p v-if="chat.footerLink" class="fdn-footer-brand">
      <ExternalLink :chat="chat" :link="chat.footerLink" link-class="fdn-footer-link" :icon-size="0" />
    </p>
  </div>
</template>
