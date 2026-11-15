<script setup lang="ts">
/** The cloud tools of one MCP server of the organisation: a card with a collapsible, read-only list. */
import { useId } from "vue";

import type { CloudGroupViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ group: CloudGroupViewModel }>();
const group = useViewModel(() => props.group);
const id = useId();
</script>

<template>
  <section class="fdn-card" :aria-labelledby="`${id}-name`">
    <div class="fdn-tp-group-head">
      <button type="button" class="fdn-tp-group-toggle" :aria-expanded="group.isExpanded" :aria-controls="`${id}-list`"
        :aria-label="group.isExpanded ? group.collapseName : group.expandName" @click="group.toggle()">
        <Icon name="chevron" :size="16" /><span :id="`${id}-name`" dir="auto">{{ group.server }}</span>
      </button>
      <span class="fdn-muted" dir="auto">{{ group.summary }}</span>
    </div>
    <ul v-if="group.isExpanded" :id="`${id}-list`" class="fdn-tp-cloud-list">
      <li v-for="t in group.tools" :key="t.name" class="fdn-tp-cloud-tool" :data-muted="t.isMuted ? '' : undefined" :data-off="t.isOff ? '' : undefined">
        <div>
          <div class="fdn-tp-name" dir="auto">{{ t.name }}</div>
          <div v-if="t.hasDescription" class="fdn-muted" dir="auto">{{ t.description }}</div>
        </div>
        <span class="fdn-badge" dir="auto">{{ t.stateText }}</span>
      </li>
    </ul>
  </section>
</template>
