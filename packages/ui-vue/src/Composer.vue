<script setup lang="ts">
/**
 * The message box: context chips, the text, send or stop. Enter sends, Shift+Enter is a new line, Esc stops. The
 * default slot holds the host's controls under the text (attach the page, the selection).
 */
import { onMounted, useTemplateRef, watch } from "vue";

import type { AgentChatViewModel } from "@fadenstack/ui";
import { composerKey, fitToContent, focusAtEnd } from "@fadenstack/ui-web";

import AttachmentChip from "./AttachmentChip.vue";
import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ chat: AgentChatViewModel; placeholder?: string | undefined }>();
defineSlots<{ default?(): unknown }>();
const chat = useViewModel(() => props.chat);
const box = useTemplateRef<HTMLTextAreaElement>("box");

watch(() => props.chat, (model, _previous, onCleanup) => {
  onCleanup(model.onComposerFocus(() => {
    if (box.value) focusAtEnd(box.value);
  }));
}, { immediate: true });

// Grows with its text, up to a third of the panel.
watch(() => chat.value.input, () => {
  if (box.value) fitToContent(box.value);
}, { flush: "post" });
onMounted(() => {
  if (box.value) fitToContent(box.value);
});

function send(): void {
  if (chat.value.canSend) void chat.value.send();
}

function onKey(e: KeyboardEvent): void {
  const action = composerKey(e, chat.value.isBusy);
  if (!action) return;
  e.preventDefault();
  if (action === "send") send();
  else chat.value.stop();
}
</script>

<template>
  <div class="fdn-composer">
    <div v-if="chat.attachments.length > 0" class="fdn-chips">
      <AttachmentChip v-for="a in chat.attachments" :key="a.key" :attachment="a" :chat="chat" :strings="chat.strings" />
    </div>
    <textarea
      ref="box"
      rows="1"
      dir="auto"
      :value="chat.input"
      :placeholder="placeholder ?? chat.strings.composerPlaceholder"
      :aria-label="placeholder ?? chat.strings.composerPlaceholder"
      @input="chat.setInput(($event.target as HTMLTextAreaElement).value)"
      @keydown="onKey"
    />
    <div class="fdn-composer-bar">
      <div class="fdn-composer-accessory"><slot /></div>
      <button
        v-if="chat.isBusy"
        type="button"
        class="fdn-send fdn-stop"
        :aria-label="chat.strings.stop"
        :title="`${chat.strings.stop} (Esc)`"
        @click="chat.stop()"
      >
        <Icon name="stop" />
      </button>
      <button v-else type="button" class="fdn-send" :aria-label="chat.strings.send" :title="chat.strings.send" :disabled="!chat.canSend" @click="send">
        <Icon name="send" />
      </button>
    </div>
  </div>
</template>
