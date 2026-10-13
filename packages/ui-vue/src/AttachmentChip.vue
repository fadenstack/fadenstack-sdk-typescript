<script setup lang="ts">
/** Context waiting in the composer: an implicit chip (the page, the open file) switches on and off; others are removed. */
import type { AgentChatViewModel, AttachmentViewModel, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ attachment: AttachmentViewModel; chat: AgentChatViewModel; strings: UiStrings }>();
const attachment = useViewModel(() => props.attachment);
</script>

<template>
  <span :class="attachment.implicit && !attachment.included ? 'fdn-chip fdn-chip-off' : 'fdn-chip'">
    <button
      v-if="attachment.implicit"
      type="button"
      class="fdn-chip-toggle"
      :aria-pressed="attachment.included"
      :title="strings.includeAttachment"
      @click="attachment.toggle()"
    >
      <Icon name="page" :size="12" />
      <span class="fdn-chip-title" dir="auto">{{ attachment.title }}</span>
      <span v-if="attachment.subtitle" class="fdn-chip-sub">{{ attachment.subtitle }}</span>
    </button>
    <template v-else>
      <Icon name="page" :size="12" />
      <span class="fdn-chip-title" dir="auto">{{ attachment.title }}</span>
      <span v-if="attachment.subtitle" class="fdn-chip-sub">{{ attachment.subtitle }}</span>
      <button type="button" class="fdn-chip-remove" :aria-label="`${strings.removeAttachment} ${attachment.title}`" @click="chat.removeAttachment(attachment)">
        <Icon name="close" :size="12" />
      </button>
    </template>
  </span>
</template>
