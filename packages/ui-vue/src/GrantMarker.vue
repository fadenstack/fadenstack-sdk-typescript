<script setup lang="ts">
/**
 * The marker for every grant of the device, across chats, for a host to show outside the chat (a title bar, a tray):
 * the time left by the server's clock, Stop, "Another 30 min" near the end, and one summary per grant that ended.
 */
import type { GrantMarkerViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ marker: GrantMarkerViewModel }>();
const marker = useViewModel(() => props.marker);
</script>

<template>
  <div v-if="marker.isOn || marker.summaries.length || marker.hasMessage" class="fdn-grants fdn-device-marker">
    <div v-if="marker.isOn" class="fdn-grant-marker" role="status">
      <Icon name="shield" :size="14" />
      <span class="fdn-grant-marker-text">{{ marker.markerText }}</span>
      <button v-if="marker.isEnding" type="button" class="fdn-button" @click="marker.keepGoing()">{{ marker.keepGoingText }}</button>
      <button type="button" class="fdn-button fdn-quiet" @click="marker.stop()">{{ marker.stopText }}</button>
    </div>
    <ul v-if="marker.entries.length > 1" class="fdn-grant-entries">
      <li v-for="entry in marker.entries" :key="entry.grantId" dir="auto">{{ entry.text }}</li>
    </ul>
    <div v-if="marker.hasMessage" class="fdn-banner" role="alert">{{ marker.message }}</div>
    <div v-for="summary in marker.summaries" :key="summary.grantId" class="fdn-grant-summary" role="status">
      <strong>{{ summary.title }}</strong>
      <div class="fdn-grant-summary-detail" dir="auto">{{ summary.detail }}</div>
      <button type="button" class="fdn-icon-button fdn-small" :aria-label="marker.dismissText" :title="marker.dismissText" @click="marker.dismiss(summary)">
        <Icon name="close" :size="14" />
      </button>
    </div>
  </div>
</template>
