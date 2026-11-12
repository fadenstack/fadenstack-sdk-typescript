<script setup lang="ts">
/**
 * Everything of the chat's grants above the composer: the cards waiting for the person, the Bypass confirmation, the
 * running-grant marker with Stop and "Another 30 min", the Bypass marker with Stop, and the line that says Bypass ended.
 */
import type { GrantsViewModel, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";
import BypassCardView from "./parts/BypassCardView.vue";
import GrantCardView from "./parts/GrantCardView.vue";

const props = defineProps<{ grants: GrantsViewModel; strings: UiStrings }>();
const grants = useViewModel(() => props.grants);
</script>

<template>
  <div
    v-if="grants.cards.length || grants.bypassCard || grants.hasMarker || grants.hasBypass || grants.hasBypassEnded || grants.message"
    class="fdn-grants"
  >
    <GrantCardView v-for="part in grants.cards" :key="part.key" :part="part" />
    <BypassCardView v-if="grants.bypassCard" :part="grants.bypassCard" />
    <div v-if="grants.hasMarker" class="fdn-grant-marker" role="status">
      <Icon name="shield" :size="14" />
      <span class="fdn-grant-marker-text">{{ grants.markerText }}</span>
      <button v-if="grants.isEnding" type="button" class="fdn-button" @click="grants.keepGoing()">{{ grants.keepGoingText }}</button>
      <button type="button" class="fdn-button fdn-quiet" @click="grants.stop()">{{ grants.stopText }}</button>
    </div>
    <div v-if="grants.hasBypass" class="fdn-grant-marker fdn-bypass-marker" role="status">
      <Icon name="warning" :size="14" />
      <span class="fdn-grant-marker-text">{{ grants.bypassText }}</span>
      <span class="fdn-muted">{{ grants.bypassRecordedText }}</span>
      <button type="button" class="fdn-button fdn-quiet" :aria-label="grants.bypassStopName" @click="grants.stopBypass()">{{ strings.markerStop }}</button>
    </div>
    <div v-if="grants.hasBypassEnded" class="fdn-grant-marker fdn-bypass-ended" role="status">
      <span class="fdn-grant-marker-text">{{ grants.bypassEndedText }}</span>
      <button v-if="grants.canSwitchOnAgain" type="button" class="fdn-button" :aria-label="grants.switchOnAgainName" @click="grants.switchOnAgain()">{{ grants.switchOnAgainText }}</button>
      <button type="button" class="fdn-icon-button fdn-small" :aria-label="grants.closeText" :title="grants.closeText" @click="grants.dismissBypassEnded()">
        <Icon name="close" :size="14" />
      </button>
    </div>
    <div v-if="grants.message" class="fdn-banner" role="alert">{{ grants.message }}</div>
  </div>
</template>
