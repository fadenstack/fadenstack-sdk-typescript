<script setup lang="ts">
/**
 * A copy button that shows a tick for a moment after copying. A copy the agent's policy refused (`copy` gives `"refused"`) shows why
 * instead, and a copy the clipboard did not take shows nothing.
 */
import { onBeforeUnmount, ref } from "vue";

import type { UiStrings } from "@fadenstack/ui";
import { COPIED_MS } from "@fadenstack/ui-web";

import Icon from "../Icon.vue";

const props = defineProps<{ label: string; strings: UiStrings; copy: () => unknown }>();
const state = ref<"copied" | "refused" | undefined>();
let timer: ReturnType<typeof setTimeout> | undefined;

function onClick(): void {
  void Promise.resolve(props.copy()).then((result) => {
    if (result === "failed") return;
    state.value = result === "refused" ? "refused" : "copied";
    clearTimeout(timer);
    timer = setTimeout(() => (state.value = undefined), COPIED_MS);
  }, () => undefined);
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <button type="button" class="fdn-icon-button fdn-small" :aria-label="label"
    :title="state === 'copied' ? strings.copied : state === 'refused' ? strings.copyRefused : label" @click="onClick">
    <Icon :name="state === 'copied' ? 'check' : 'copy'" :size="14" />
  </button>
  <span v-if="state === 'refused'" class="fdn-copy-status fdn-refused" role="alert">{{ strings.copyRefused }}</span>
</template>
