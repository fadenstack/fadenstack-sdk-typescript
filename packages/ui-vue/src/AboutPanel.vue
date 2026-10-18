<script setup lang="ts">
/**
 * About, below the settings' gear: the agent, the app it runs in, the SDK, the server, links, and "Copy details".
 * It takes the focus when it opens; `close(true)` gives it back to the gear.
 */
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";

import type { AgentChatViewModel } from "@fadenstack/ui";
import { COPIED_MS } from "@fadenstack/ui-web";

import { useViewModel } from "./composables.js";
import ExternalLink from "./ExternalLink.vue";
import Icon from "./Icon.vue";

const props = defineProps<{ chat: AgentChatViewModel }>();
const emit = defineEmits<{ close: [returnFocus: boolean] }>();
const chat = useViewModel(() => props.chat);
const about = computed(() => chat.value.about);
const closeButton = useTemplateRef<HTMLButtonElement>("closeButton");
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

onMounted(() => closeButton.value?.focus({ preventScroll: true }));
onBeforeUnmount(() => clearTimeout(timer));

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  emit("close", true);
}

function copy(): void {
  void chat.value.copyAboutDetails().then((done) => {
    if (!done) return;
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), COPIED_MS);
  });
}
</script>

<template>
  <div class="fdn-menu fdn-about" role="dialog" :aria-label="chat.strings.about" @keydown="onKeydown">
    <div class="fdn-about-head">
      <span class="fdn-about-title">{{ chat.strings.about }}</span>
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
    <div v-if="about.agent || about.agentDetails.length > 0" class="fdn-about-agent">
      <span v-if="about.agent" class="fdn-about-name" dir="auto">{{ about.agent }}</span>
      <span v-for="(line, i) in about.agentDetails" :key="i" class="fdn-about-line">{{ line }}</span>
    </div>
    <div class="fdn-about-environment">
      <span v-for="(line, i) in about.environment" :key="i" class="fdn-about-line" dir="auto">{{ line }}</span>
    </div>
    <div class="fdn-about-links">
      <ExternalLink v-for="link in about.links" :key="link.href" :chat="chat" :link="link" link-class="fdn-about-link" />
    </div>
    <button type="button" class="fdn-button" @click="copy">
      <Icon :name="copied ? 'check' : 'copy'" :size="14" />
      <span>{{ copied ? chat.strings.copied : chat.strings.copyDetails }}</span>
    </button>
  </div>
</template>
