<script setup lang="ts">
/**
 * Tools, below the settings' gear: what the agent can use, read only. "In this app" lists the app's own tools with what each
 * does to things; "From your organisation's server" lists the server's tools by MCP server, each with whether it is available.
 * Descriptions are plain text, whatever a server wrote. It takes the focus when it opens; `close(true)` gives it back to the gear.
 */
import { computed, onMounted, useTemplateRef } from "vue";

import type { AgentChatViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ chat: AgentChatViewModel }>();
const emit = defineEmits<{ close: [returnFocus: boolean] }>();
const chat = useViewModel(() => props.chat);
const tools = useViewModel(() => props.chat.tools);
const app = computed(() => tools.value.hostTools);
const closeButton = useTemplateRef<HTMLButtonElement>("closeButton");

onMounted(() => closeButton.value?.focus({ preventScroll: true }));

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  emit("close", true);
}
</script>

<template>
  <div class="fdn-menu fdn-tools" role="dialog" :aria-label="chat.strings.tools" :aria-busy="tools.isLoading" @keydown="onKeydown">
    <div class="fdn-about-head">
      <span class="fdn-about-title">{{ chat.strings.tools }}</span>
      <button
        ref="closeButton"
        type="button"
        class="fdn-icon-button fdn-small"
        :title="chat.strings.close"
        :aria-label="chat.strings.close"
        @click="emit('close', true)"
      >
        <Icon name="close" :size="14" />
      </button>
    </div>
    <div class="fdn-tools-section" role="group" :aria-labelledby="`${tools.key}-app`">
      <div :id="`${tools.key}-app`" class="fdn-menu-heading">{{ chat.strings.toolsInApp }}</div>
      <div v-if="app.length === 0" class="fdn-menu-note">{{ chat.strings.toolsNoneInApp }}</div>
      <ul v-else class="fdn-tools-list">
        <li v-for="t in app" :key="t.name" class="fdn-tools-row">
          <div class="fdn-tools-row-head">
            <span class="fdn-tools-name" dir="auto">{{ t.name }}</span>
            <span :class="`fdn-badge fdn-class-${t.toolClass}`">{{ t.classLabel }}</span>
          </div>
          <div v-if="t.description" class="fdn-tools-desc" dir="auto">{{ t.description }}</div>
        </li>
      </ul>
    </div>
    <div class="fdn-tools-section" role="group" :aria-labelledby="`${tools.key}-server`">
      <div :id="`${tools.key}-server`" class="fdn-menu-heading">{{ chat.strings.toolsFromServer }}</div>
      <div v-if="tools.isLoading" class="fdn-menu-note" role="status">{{ chat.strings.toolsLoading }}</div>
      <div v-else-if="tools.failed" class="fdn-tools-failed">
        <div class="fdn-menu-note" role="alert">{{ chat.strings.toolsFailed }}</div>
        <button type="button" class="fdn-button" @click="tools.load()">{{ chat.strings.retry }}</button>
      </div>
      <div v-else-if="tools.isServerEmpty" class="fdn-menu-note" role="status">{{ chat.strings.toolsNone }}</div>
      <template v-else>
        <div v-for="group in tools.serverGroups" :key="group.server" class="fdn-tools-group" role="group" :aria-label="group.server">
          <div class="fdn-tools-server" dir="auto">{{ group.server }}</div>
          <ul class="fdn-tools-list">
            <li v-for="t in group.tools" :key="t.name" class="fdn-tools-row">
              <div class="fdn-tools-row-head">
                <span class="fdn-tools-name" dir="auto">{{ t.name }}</span>
                <span :class="`fdn-badge fdn-tools-status fdn-tools-${t.status}`">{{ t.statusLabel }}</span>
              </div>
              <div v-if="t.description" class="fdn-tools-desc" dir="auto">{{ t.description }}</div>
            </li>
          </ul>
        </div>
      </template>
    </div>
  </div>
</template>
