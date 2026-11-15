<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { MAX_REASON_CHARS } from "@fadenstack/agents";
import type { ApprovalPart, UiStrings } from "@fadenstack/ui";
import { approvalIcon } from "@fadenstack/ui-web";

import { useViewModel } from "../composables.js";
import Icon from "../Icon.vue";

/** "Run delete_page?" with Allow, Allow for this chat, Allow always and Deny -- answered in place. */
const props = defineProps<{ part: ApprovalPart; strings: UiStrings }>();
const part = useViewModel(() => props.part);
const why = ref<HTMLButtonElement | null>(null);
const box = ref<HTMLTextAreaElement | null>(null);

// "Say why" moves the focus into the box it opened.
watch(() => part.value.isReasonOpen, (open) => {
  if (open) void nextTick(() => box.value?.focus());
});

/** Esc in the box closes it without deciding, and puts the focus back on "Say why". */
function closeReason(): void {
  props.part.toggleReason();
  queueMicrotask(() => why.value?.focus());
}
</script>

<template>
  <div :class="part.isDangerous ? 'fdn-approval fdn-approval-danger' : 'fdn-approval'" role="group" :aria-label="part.title">
    <div class="fdn-approval-head">
      <Icon :name="approvalIcon(part)" />
      <strong><template v-for="(p, i) in part.titleParts" :key="i"><code v-if="p.code">{{ p.text }}</code><template v-else>{{ p.text }}</template></template></strong>
    </div>
    <div class="fdn-approval-source">
      <span :class="`fdn-badge fdn-class-${part.request.toolClass}`">{{ part.classLabel }}</span>
      <span v-if="part.hasSourceLine" class="fdn-approval-from"><Icon name="extension" :size="14" /><span>{{ part.sourceLine }}</span></span>
    </div>
    <p v-if="part.reason" class="fdn-approval-reason" dir="auto">{{ part.reason }}</p>
    <p v-if="part.target" class="fdn-approval-target" dir="auto">{{ part.target }}</p>
    <pre v-if="part.argumentsText" class="fdn-approval-args" dir="auto">{{ part.argumentsText }}</pre>
    <div v-if="part.isPending" class="fdn-approval-actions">
      <textarea
        v-if="part.isReasonOpen"
        :id="`${part.request.callId}-why`"
        ref="box"
        class="fdn-approval-why-box"
        :rows="3"
        :maxlength="MAX_REASON_CHARS"
        dir="auto"
        :value="part.denyReason"
        :placeholder="strings.denyReasonPlaceholder"
        :aria-label="strings.denyReasonName"
        @input="part.setDenyReason(($event.target as HTMLTextAreaElement).value)"
        @keydown.esc.stop.prevent="closeReason()"
      />
      <template v-if="part.timeGrantChoices.length">
        <p class="fdn-approval-reason">{{ part.timeGrantHint }}</p>
        <div class="fdn-approval-pair">
          <button v-for="choice in part.timeGrantChoices" :key="choice.minutes" type="button" class="fdn-button" @click="part.allowForTime(choice.minutes)">{{ choice.label }}</button>
        </div>
      </template>
      <div class="fdn-approval-pair">
        <button type="button" class="fdn-button fdn-primary" @click="part.allow()">{{ strings.allow }}</button>
        <button v-if="part.canAllowForSession" type="button" class="fdn-button" @click="part.allowForSession()">{{ strings.allowForChat }}</button>
      </div>
      <div class="fdn-approval-pair">
        <button v-if="part.canAllowAlways" type="button" class="fdn-button" @click="part.allowAlways()">{{ strings.allowAlways }}</button>
        <button type="button" class="fdn-button fdn-quiet" @click="part.deny()">{{ strings.deny }}</button>
      </div>
      <button ref="why" type="button" class="fdn-link fdn-approval-why" :aria-expanded="part.isReasonOpen"
        :aria-controls="`${part.request.callId}-why`" @click="part.toggleReason()">{{ strings.sayWhy }}</button>
    </div>
    <template v-else>
      <div :class="`fdn-approval-state fdn-approval-${part.state}`">{{ part.stateText }}</div>
      <p v-if="part.declinedReasonText" class="fdn-approval-declined" dir="auto" :title="part.declinedReasonText">{{ part.declinedReasonText }}</p>
    </template>
  </div>
</template>
