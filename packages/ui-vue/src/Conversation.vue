<script setup lang="ts">
/** The scrolling conversation: the empty chat's greeting and suggestions, or the turns. */
import { useTemplateRef } from "vue";

import type { AgentChatViewModel } from "@fadenstack/ui";

import AgentAvatar from "./AgentAvatar.js";
import { useStickToBottom, useViewModel } from "./composables.js";
import TurnView from "./TurnView.vue";
import type { PartRenderer } from "./types.js";

const props = defineProps<{ chat: AgentChatViewModel; partRenderers?: readonly PartRenderer[] | undefined; agentColor?: string | undefined }>();
defineSlots<{ avatar?(): unknown }>();
const chat = useViewModel(() => props.chat);
useStickToBottom(useTemplateRef<HTMLDivElement>("body"));
</script>

<template>
  <div ref="body" class="fdn-body" role="log" aria-live="polite" aria-relevant="additions">
    <div class="fdn-turns">
      <div v-if="chat.isEmpty" class="fdn-empty">
        <div class="fdn-empty-mark"><slot name="avatar"><AgentAvatar :size="64" :color="agentColor" /></slot></div>
        <p v-if="chat.isReady" class="fdn-greeting" dir="auto">{{ chat.greeting }}</p>
        <div v-if="chat.suggestions.length > 0" class="fdn-suggestions">
          <button
            v-for="s in chat.suggestions"
            :key="s"
            type="button"
            class="fdn-suggestion"
            dir="auto"
            :disabled="!chat.isReady || chat.isBusy"
            @click="chat.send(s)"
          >
            {{ s }}
          </button>
        </div>
      </div>
      <template v-else>
        <button v-if="chat.hasEarlierTurns" type="button" class="fdn-earlier" @click="chat.loadEarlier()">{{ chat.strings.showEarlier }}</button>
        <TurnView v-for="turn in chat.turns" :key="turn.key" :turn="turn" :strings="chat.strings" :renderers="partRenderers" />
      </template>
    </div>
  </div>
</template>
