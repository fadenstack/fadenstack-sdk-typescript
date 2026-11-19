<script setup lang="ts">
/**
 * "Report a problem", a sheet like About below the settings' gear: to whom the report goes, and the lines the mail will contain, in a
 * read-only text region. It takes the focus when it opens; Escape and Close give it back to what opened it (About's button has gone with
 * About, so the gear then; `close(true)`). The SDK sends nothing: "Write mail" opens the host's mail link, "Copy details" copies the text.
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
const view = computed(() => chat.value.reportProblem);
const closeButton = useTemplateRef<HTMLButtonElement>("closeButton");
const copied = ref(false);
const opener = typeof document === "undefined" ? null : document.activeElement;
let timer: ReturnType<typeof setTimeout> | undefined;

onMounted(() => closeButton.value?.focus({ preventScroll: true }));
onBeforeUnmount(() => clearTimeout(timer));

function close(): void {
  if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) {
    emit("close", false);
    opener.focus({ preventScroll: true });
  } else {
    emit("close", true);
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  close();
}

function copy(): void {
  void chat.value.copyReportDetails().then((done) => {
    if (!done) return;
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), COPIED_MS);
  });
}
</script>

<template>
  <div class="fdn-menu fdn-about fdn-report" role="dialog" :aria-label="view.title" @keydown="onKeydown">
    <div class="fdn-about-head">
      <span class="fdn-about-title">{{ view.title }}</span>
      <button ref="closeButton" type="button" class="fdn-icon-button fdn-small" :title="view.close" :aria-label="view.close" @click="close">
        <Icon name="close" :size="14" />
      </button>
    </div>
    <p class="fdn-report-goes" dir="auto">{{ view.goesTo }}</p>
    <div v-if="view.help" class="fdn-about-links">
      <ExternalLink :chat="chat" :link="view.help" link-class="fdn-about-link" />
    </div>
    <p class="fdn-about-line">{{ view.contains }}</p>
    <textarea
      class="fdn-report-preview"
      readonly
      :spellcheck="false"
      :rows="Math.min(14, view.preview.split('\n').length)"
      :aria-label="view.contains"
      dir="auto"
      :value="view.preview"
    ></textarea>
    <p class="fdn-about-line">{{ view.noChats }}</p>
    <div class="fdn-report-actions">
      <button v-if="view.canWriteMail" type="button" class="fdn-button" @click="chat.writeReportMail()">
        <Icon name="external" :size="14" />
        <span>{{ view.writeMail }}</span>
      </button>
      <button type="button" class="fdn-button" @click="copy">
        <Icon :name="copied ? 'check' : 'copy'" :size="14" />
        <span>{{ copied ? chat.strings.copied : view.copyDetails }}</span>
      </button>
    </div>
  </div>
</template>
