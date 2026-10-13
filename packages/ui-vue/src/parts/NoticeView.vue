<script setup lang="ts">
import type { NoticePart, UiStrings } from "@fadenstack/ui";
import { noticeIcon, noticeRole } from "@fadenstack/ui-web";

import Icon from "../Icon.vue";

/** A notice: a refused message, a rate limit, a tool the server did not allow. */
defineProps<{ part: NoticePart; strings?: UiStrings }>();
</script>

<template>
  <div :class="`fdn-notice fdn-notice-${part.severity}`" :role="noticeRole(part.severity)">
    <Icon :name="noticeIcon(part.severity)" />
    <div dir="auto">
      <strong>{{ part.title }}</strong>
      <div>{{ part.message }}</div>
      <div v-if="part.detail" class="fdn-notice-detail">{{ part.detail }}</div>
    </div>
  </div>
</template>
