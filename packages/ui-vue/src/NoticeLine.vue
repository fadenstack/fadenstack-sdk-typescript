<script setup lang="ts">
/** Under the composer: that the answers come from an AI, then the muted Fadenstack link (`branding`). */
import type { AgentChatViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import ExternalLink from "./ExternalLink.vue";

const props = defineProps<{ chat: AgentChatViewModel }>();
const chat = useViewModel(() => props.chat);
</script>

<template>
  <p v-if="chat.strings.aiNotice || chat.footerLink" class="fdn-ai-notice">
    <span v-if="chat.strings.aiNotice" dir="auto">{{ chat.strings.aiNotice }}</span>
    <span v-if="chat.strings.aiNotice && chat.footerLink" class="fdn-ai-notice-separator" aria-hidden="true">·</span>
    <ExternalLink v-if="chat.footerLink" :chat="chat" :link="chat.footerLink" link-class="fdn-footer-link" :icon-size="10" />
  </p>
</template>
