<script setup lang="ts">
/**
 * The Bypass confirmation: what no longer asks, what still asks, what the server records, how long (shortest first),
 * why. Not now comes first and takes the focus; Allow is never the default, and Enter and Escape never press it.
 */
import { onMounted, useTemplateRef } from "vue";

import type { BypassPart, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "../composables.js";
import Icon from "../Icon.vue";

const props = defineProps<{ part: BypassPart; strings?: UiStrings }>();
const part = useViewModel(() => props.part);
const card = useTemplateRef<HTMLDivElement>("card");
onMounted(() => (card.value?.querySelector<HTMLElement>("[data-fdn-focus]") ?? card.value)?.focus());

function ignore(event: KeyboardEvent): void {
  if (part.value.ignoresKey(event.key)) event.preventDefault();
}
function type(event: Event): void {
  part.value.reason = (event.target as HTMLInputElement).value;
}
</script>

<template>
  <div v-if="part.isShown" ref="card" class="fdn-approval fdn-bypass fdn-approval-danger" role="group" :aria-label="part.title" tabindex="-1">
    <div class="fdn-approval-head">
      <Icon name="warning" />
      <strong>{{ part.title }}</strong>
    </div>
    <p v-if="part.appReason" class="fdn-approval-reason" dir="auto">{{ part.appReason }}</p>
    <p class="fdn-approval-reason">{{ part.noLongerAsksText }}</p>
    <p class="fdn-approval-reason">{{ part.stillAsksText }}</p>
    <p class="fdn-approval-reason">{{ part.recordsText }}</p>
    <template v-if="part.isPending">
      <div class="fdn-grant-durations" role="radiogroup" :aria-label="part.durationLabel">
        <button
          v-for="d in part.durations"
          :key="d.value"
          type="button"
          role="radio"
          :aria-checked="d.value === part.selectedDuration"
          :class="d.value === part.selectedDuration ? 'fdn-button fdn-selected' : 'fdn-button'"
          @click="part.selectDuration(d.value)"
        >{{ d.label }}</button>
      </div>
      <p class="fdn-approval-reason">{{ part.noExtensionText }}</p>
      <label class="fdn-bypass-reason">
        <span class="fdn-label">{{ part.reasonLabel }}</span>
        <input type="text" :value="part.reason" :maxlength="part.reasonLength" dir="auto" @input="type" />
      </label>
      <p class="fdn-approval-reason">{{ part.reasonSeenText }}</p>
      <div class="fdn-approval-pair fdn-grant-buttons">
        <template v-for="button in part.buttons" :key="button">
          <button v-if="button === 'notNow'" type="button" class="fdn-button fdn-quiet" data-fdn-focus="" @click="part.notNow()">{{ part.notNowText }}</button>
          <button v-else type="button" class="fdn-button" :disabled="!part.canAllow" @keydown="ignore" @click="part.allow()">{{ part.allowText }}</button>
        </template>
      </div>
    </template>
    <div v-else class="fdn-approval-state" role="status">{{ part.stateText }}</div>
    <div v-if="part.isSigningIn" class="fdn-bypass-signin">
      <p v-if="part.signInCodeText" class="fdn-approval-reason">{{ part.signInCodeText }}</p>
      <button type="button" class="fdn-button" :aria-label="part.openAgainName" :disabled="!part.canOpenAgain" @keydown="ignore" @click="part.openAgain()">{{ part.openAgainText }}</button>
    </div>
    <button v-if="part.canClose" type="button" class="fdn-button fdn-quiet" @click="part.close()">{{ part.closeText }}</button>
  </div>
</template>
