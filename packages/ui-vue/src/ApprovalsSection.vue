<script setup lang="ts">
/** Settings -> Approvals: the grants the server holds and what was allowed always, each with Revoke. */
import type { GrantsViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";

const props = defineProps<{ grants: GrantsViewModel }>();
const grants = useViewModel(() => props.grants);
</script>

<template>
  <div role="group" :aria-label="grants.standingTitle" class="fdn-menu-extra">
    <div class="fdn-menu-heading">{{ grants.standingTitle }}</div>
    <div v-if="!grants.hasStanding" class="fdn-menu-note">{{ grants.standingEmpty }}</div>
    <div v-for="(item, index) in grants.standing" :key="index" :class="item.isBypass ? 'fdn-standing fdn-standing-bypass' : 'fdn-standing'">
      <span class="fdn-standing-title" dir="auto">{{ item.title }}</span>
      <button type="button" class="fdn-button fdn-quiet" :aria-label="`${grants.revokeText} ${item.title}`" @click="item.revoke()">{{ grants.revokeText }}</button>
    </div>
  </div>
</template>
