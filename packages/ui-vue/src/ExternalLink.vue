<script setup lang="ts">
/**
 * A link that opens in a new tab: without a way back to the panel or a Referer, its name saying so, and through the
 * chat's `openLink`, so a host can open it its own way.
 */
import type { AgentChatViewModel, PanelLink } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = withDefaults(defineProps<{ chat: AgentChatViewModel; link: PanelLink; linkClass: string; iconSize?: number }>(), { iconSize: 12 });
const chat = useViewModel(() => props.chat);

function open(e: MouseEvent): void {
  e.preventDefault();
  chat.value.openLink(props.link.href);
}
</script>

<template>
  <a
    :class="`${linkClass} fdn-external`"
    :href="link.href"
    target="_blank"
    rel="noopener noreferrer"
    :aria-label="`${link.label} ${chat.strings.opensInNewTab}`"
    @click="open"
  >{{ link.label }}<Icon name="external" :size="iconSize" /></a>
</template>
