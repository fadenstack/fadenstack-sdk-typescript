<script setup lang="ts">
/**
 * A Copilot-style chat with an agent: streamed Markdown, tool lines, approval cards and notices in the order
 * they happened, a tool-mode picker, history, and a composer with context chips. It only renders: everything it
 * shows and does is the view model's, and every text is the chat's `strings` (their `lang` and `dir` too).
 */
import type { AgentChatViewModel } from "@fadenstack/ui";

import ChatHeader from "./ChatHeader.vue";
import Composer from "./Composer.vue";
import { useViewModel } from "./composables.js";
import Conversation from "./Conversation.vue";
import type { ChatTheme, PartRenderer } from "./types.js";

const props = withDefaults(defineProps<{
  chat: AgentChatViewModel;
  /** `system` (default) follows the browser's light or dark setting as it changes. */
  theme?: ChatTheme;
  placeholder?: string | undefined;
  /** Views for parts modules add. */
  partRenderers?: readonly PartRenderer[] | undefined;
  /** A custom agent's own thread colour for its avatar's middle plate. Fadenstack's own agents keep the rose. */
  agentColor?: string | undefined;
}>(), { theme: "system", placeholder: undefined, partRenderers: undefined, agentColor: undefined });

const slots = defineSlots<{
  /** The host's buttons in the header. */
  "header-extra"?(): unknown;
  /** The host's own items in the panel's settings, below the language (sign out, its own options). */
  "settings-extra"?(): unknown;
  /** The host's controls in the composer (attach the page, the selection). */
  "composer-accessory"?(): unknown;
  /** Shown above the composer (e.g. the file the agent works on). */
  "context-bar"?(): unknown;
  /** Shown instead of the chat while the agent needs a sign-in. */
  "sign-in"?(): unknown;
  /** Replaces the agent's avatar in the empty chat, e.g. with the host's own logo. */
  avatar?(): unknown;
}>();
const chat = useViewModel(() => props.chat);
</script>

<template>
  <div class="fdn-chat" :data-theme="theme" :lang="chat.strings.language" :dir="chat.strings.direction">
    <ChatHeader :chat="chat">
      <slot name="header-extra" />
      <template v-if="slots['settings-extra']" #settings><slot name="settings-extra" /></template>
    </ChatHeader>
    <div v-if="chat.signInRequired && slots['sign-in']" class="fdn-body fdn-body-center"><slot name="sign-in" /></div>
    <template v-else>
      <Conversation :chat="chat" :part-renderers="partRenderers" :agent-color="agentColor">
        <template v-if="slots.avatar" #avatar><slot name="avatar" /></template>
      </Conversation>
      <div v-if="chat.error && !chat.signInRequired" class="fdn-banner" role="alert">{{ chat.error }}</div>
      <slot name="context-bar" />
      <Composer :chat="chat" :placeholder="placeholder"><slot name="composer-accessory" /></Composer>
    </template>
  </div>
</template>
