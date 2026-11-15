<script setup lang="ts">
/** A local server as a card: its name (which opens the details), where it came from, its switch, its status and up to three tool chips. */
import type { LocalServerViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";

const props = defineProps<{ server: LocalServerViewModel }>();
const server = useViewModel(() => props.server);
</script>

<template>
  <li class="fdn-card fdn-tp-card" :data-selected="server.isSelected ? '' : undefined">
    <div class="fdn-tp-card-head">
      <span class="fdn-tp-tile"><Icon name="extension" :size="16" /></span>
      <button type="button" class="fdn-tp-open" :aria-label="server.openName" @click="server.open()">
        <span class="fdn-skills-name" dir="auto">{{ server.label }}</span>
        <span class="fdn-tp-where" dir="auto" :title="server.originText">{{ server.originText }}</span>
      </button>
      <label class="fdn-skills-switch">
        <input type="checkbox" role="switch" :checked="server.isOn" :aria-label="server.switchName" @change="server.isOn = ($event.target as HTMLInputElement).checked">
        <span>{{ server.isOn ? server.strings.skillOn : server.strings.skillOff }}</span>
      </label>
    </div>
    <p class="fdn-tp-status" :data-kind="server.statusKind" :title="server.statusTip || undefined" dir="auto">
      <span class="fdn-tp-dot" aria-hidden="true" /><span>{{ server.statusText }}</span>
    </p>
    <ul v-if="server.hasChips" class="fdn-tp-chips">
      <li v-for="(chip, i) in server.chips" :key="i" class="fdn-tp-chip" :class="{ 'fdn-tp-chip-warn': chip.mayDelete, 'fdn-tp-chip-more': chip.isMore }"
        :title="chip.tip" :aria-label="chip.mayDelete ? chip.tip : undefined">{{ chip.name }}</li>
    </ul>
    <div v-if="server.hasFix" class="fdn-wizard-actions">
      <button type="button" class="fdn-button fdn-quiet" dir="auto" @click="server.fix()">{{ server.fixText }}</button>
    </div>
  </li>
</template>
