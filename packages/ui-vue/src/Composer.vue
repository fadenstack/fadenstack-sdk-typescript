<script setup lang="ts">
/**
 * The message box: context chips, the text, send or stop. Enter sends, Shift+Enter is a new line, Esc stops. `$`
 * opens the skills to pick for the message; a pasted or dropped picture goes with it, for a model that sees
 * pictures. The default slot holds the host's controls under the text (attach the page, the selection).
 */
import { computed, onMounted, useTemplateRef, watch } from "vue";

import type { AgentChatViewModel } from "@fadenstack/ui";
import { composerKey, fitToContent, focusAtEnd, picturesIn, readPicture } from "@fadenstack/ui-web";

import AttachmentChip from "./AttachmentChip.vue";
import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";
import SkillPicker from "./SkillPicker.vue";

const props = defineProps<{ chat: AgentChatViewModel; placeholder?: string | undefined }>();
defineSlots<{ default?(): unknown }>();
const chat = useViewModel(() => props.chat);
const picker = useViewModel(() => props.chat.skillPicker);
const box = useTemplateRef<HTMLTextAreaElement>("box");

const listId = computed(() => `${picker.value.key}-list`);
const open = computed(() => picker.value.isOpen && chat.value.canPickSkills);
const active = computed(() => (open.value && picker.value.options.length > 0 ? `${picker.value.key}-${picker.value.activeIndex}` : undefined));

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
  const action = composerKey(e, chat.value.isBusy, open.value);
  if (!action) return;
  e.preventDefault();
  if (action === "send") send();
  else if (action === "stop") chat.value.stop();
  else if (action === "next") picker.value.move(1);
  else if (action === "previous") picker.value.move(-1);
  else if (action === "pick") picker.value.pick();
  else picker.value.close();
}

function addPictures(files: readonly File[], pasted: boolean): void {
  for (const file of files) {
    void readPicture(file).then(
      (picture) => chat.value.attachPicture({ dataUrl: picture.dataUrl, ...(pasted ? {} : { title: file.name }) }),
      () => chat.value.pictureNotRead(file.name),
    );
  }
}

function onPaste(e: ClipboardEvent): void {
  const pictures = picturesIn(e.clipboardData);
  if (pictures.length === 0) return; // text pastes as text
  e.preventDefault();
  addPictures(pictures, true);
}

function onDrop(e: DragEvent): void {
  const pictures = picturesIn(e.dataTransfer);
  if (pictures.length === 0) return; // other files are the host's
  e.preventDefault();
  e.stopPropagation();
  addPictures(pictures, false);
}
</script>

<template>
  <div class="fdn-composer" @drop="onDrop">
    <SkillPicker v-if="open" :picker="picker" :strings="chat.strings" :list-id="listId" />
    <div v-if="chat.attachments.length > 0 || chat.pickedSkills.length > 0" class="fdn-chips">
      <span v-for="s in chat.pickedSkills" :key="s.slug" class="fdn-chip fdn-chip-skill" :title="s.description || undefined">
        <Icon name="sparkle" :size="12" />
        <span class="fdn-chip-title" dir="auto">{{ s.name }}</span>
        <span class="fdn-chip-sub">{{ chat.strings.skill }}</span>
        <button type="button" class="fdn-chip-remove" :aria-label="`${chat.strings.removeAttachment} ${s.name}`" @click="chat.removeSkill(s.slug)">
          <Icon name="close" :size="12" />
        </button>
      </span>
      <AttachmentChip v-for="a in chat.attachments" :key="a.key" :attachment="a" :chat="chat" :strings="chat.strings" />
    </div>
    <textarea
      ref="box"
      rows="1"
      dir="auto"
      :value="chat.input"
      :placeholder="placeholder ?? chat.strings.composerPlaceholder"
      :aria-label="placeholder ?? chat.strings.composerPlaceholder"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="active"
      @input="chat.setInput(($event.target as HTMLTextAreaElement).value)"
      @paste="onPaste"
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
