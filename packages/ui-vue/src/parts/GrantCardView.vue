<script setup lang="ts">
/** The grant card: "Work alongside you?", or the extension card with only what it adds. Not now first and focused. */
import { onMounted, useTemplateRef } from "vue";

import type { GrantPart, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "../composables.js";
import Icon from "../Icon.vue";

const props = defineProps<{ part: GrantPart; strings?: UiStrings }>();
const part = useViewModel(() => props.part);
const card = useTemplateRef<HTMLDivElement>("card");
onMounted(() => (card.value?.querySelector<HTMLElement>("[data-fdn-focus]") ?? card.value)?.focus());
</script>

<template>
  <div ref="card" class="fdn-approval fdn-grant" role="group" :aria-label="part.title" tabindex="-1">
    <div class="fdn-approval-head">
      <Icon name="shield" />
      <strong>{{ part.title }}</strong>
    </div>
    <p v-if="part.reason" class="fdn-approval-reason" dir="auto">{{ part.reason }}</p>
    <div v-if="part.hasPlaces" class="fdn-grant-places">
      <div class="fdn-label">{{ part.placesHeading }}</div>
      <ul>
        <li v-for="place in part.places" :key="place.place.identifier" :class="place.kept ? 'fdn-grant-place' : 'fdn-grant-place fdn-removed'">
          <span dir="auto">{{ place.label }}</span>
          <button
            v-if="part.isPending"
            type="button"
            class="fdn-button fdn-quiet"
            :aria-pressed="!place.kept"
            :aria-label="`${place.kept ? part.removeText : part.addBackText} ${place.label}`"
            @click="place.toggle()"
          >
            {{ place.kept ? part.removeText : part.addBackText }}
          </button>
        </li>
      </ul>
    </div>
    <div class="fdn-grant-durations" role="radiogroup" :aria-label="part.durationLabel">
      <button
        v-for="d in part.durations"
        :key="d.value"
        type="button"
        role="radio"
        :aria-checked="d.value === part.selectedDuration"
        :disabled="!part.isPending"
        :class="d.value === part.selectedDuration ? 'fdn-button fdn-selected' : 'fdn-button'"
        @click="part.selectDuration(d.value)"
      >{{ d.label }}</button>
    </div>
    <p class="fdn-approval-reason">{{ part.mayText }}</p>
    <p class="fdn-approval-reason">{{ part.stillAsksText }}</p>
    <div v-if="part.isPending" class="fdn-approval-pair fdn-grant-buttons">
      <template v-for="button in part.buttons" :key="button">
        <button v-if="button === 'notNow'" type="button" class="fdn-button fdn-quiet" data-fdn-focus="" @click="part.notNow()">{{ part.notNowText }}</button>
        <button v-else type="button" class="fdn-button fdn-primary" :disabled="!part.canAllow" @click="part.allow()">{{ part.allowText }}</button>
      </template>
    </div>
    <div v-else :class="`fdn-approval-state fdn-approval-${part.state}`" role="status">{{ part.stateText }}</div>
  </div>
</template>
