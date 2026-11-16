<script setup lang="ts">
/**
 * The band in the chat while content logging is on (8.1): until when, what is written to the logs, and Stop. Nothing while it is off. The
 * texts are the view model's. Parity with `@fadenstack/ui-react`'s `ContentLoggingBand`; .NET: the band in `ChatView` in both skins.
 */
import type { ContentLoggingBandViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ band: ContentLoggingBandViewModel }>();
const band = useViewModel(() => props.band);
</script>

<template>
  <div v-if="band.isShown" class="fdn-grant-marker fdn-content-logging-band" role="status">
    <Icon name="warning" :size="14" />
    <span class="fdn-grant-marker-text">{{ band.text }}</span>
    <button type="button" class="fdn-button fdn-quiet" :aria-label="band.stopName" @click="band.stop()">{{ band.stopText }}</button>
  </div>
</template>
