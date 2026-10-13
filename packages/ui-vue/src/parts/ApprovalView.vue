<script setup lang="ts">
import type { ApprovalPart, UiStrings } from "@fadenstack/ui";
import { approvalIcon } from "@fadenstack/ui-web";

import { useViewModel } from "../composables.js";
import Icon from "../Icon.vue";

/** "Run delete_page?" with Allow, Allow for this chat, Allow always and Deny -- answered in place. */
const props = defineProps<{ part: ApprovalPart; strings: UiStrings }>();
const part = useViewModel(() => props.part);
</script>

<template>
  <div :class="part.isDangerous ? 'fdn-approval fdn-approval-danger' : 'fdn-approval'" role="group" :aria-label="part.title">
    <div class="fdn-approval-head">
      <Icon :name="approvalIcon(part)" />
      <strong>{{ part.title }}</strong>
      <span :class="`fdn-badge fdn-class-${part.request.toolClass}`">{{ part.classLabel }}</span>
    </div>
    <p v-if="part.reason" class="fdn-approval-reason" dir="auto">{{ part.reason }}</p>
    <pre v-if="part.argumentsText" class="fdn-approval-args" dir="auto">{{ part.argumentsText }}</pre>
    <div v-if="part.isPending" class="fdn-approval-actions">
      <button type="button" class="fdn-button fdn-primary" @click="part.allow()">{{ strings.allow }}</button>
      <button v-if="part.canAllowForSession" type="button" class="fdn-button" @click="part.allowForSession()">{{ strings.allowForChat }}</button>
      <button v-if="part.canAllowAlways" type="button" class="fdn-button" @click="part.allowAlways()">{{ strings.allowAlways }}</button>
      <button type="button" class="fdn-button fdn-quiet" @click="part.deny()">{{ strings.deny }}</button>
    </div>
    <div v-else :class="`fdn-approval-state fdn-approval-${part.state}`">{{ part.stateText }}</div>
  </div>
</template>
