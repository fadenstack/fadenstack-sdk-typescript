<script setup lang="ts">
/**
 * The details of a local server: the status and switch, the facts (header names, never values), the trust mark, its tools with their
 * classes and raise pickers, Advanced with the plain-http switch where it applies (turning it on opens a warning that takes the focus
 * on Confirm, and changes nothing until it is confirmed), and Test, Restart, Edit and Remove, which asks first. Parity with
 * `Details` in `@fadenstack/ui-react`'s `ToolsPage`.
 */
import { computed, nextTick, ref, useId, watch } from "vue";

import type { ServerDetailsViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import ToolsToolRow from "./ToolsToolRow.vue";

const props = defineProps<{ details: ServerDetailsViewModel }>();
const details = useViewModel(() => props.details);
const s = computed(() => details.value.strings);
const id = useId();
const root = ref<HTMLElement | null>(null);

// The warning's Confirm (or the remove question's Keep) takes the focus; when the warning closes it goes back to the switch it came from.
watch([() => details.value.isPlainHttpWarningOpen, () => details.value.isConfirmingRemove] as const, ([warning, asking], [was]) => {
  void nextTick(() => {
    const el = root.value;
    if (!el) return;
    if (warning || asking) el.querySelector<HTMLElement>("[data-wizard-focus]")?.focus({ preventScroll: true });
    else if (was) el.querySelector<HTMLElement>("[data-plain-switch]")?.focus({ preventScroll: true });
  });
}, { flush: "post" });

function trust(e: Event): void {
  const box = e.target as HTMLInputElement;
  details.value.isTrusted = box.checked;
}

// The switch the person pressed goes back to how it stands (off, while the warning is open): Vue does not repaint a prop that did not change.
function plainHttp(e: Event): void {
  const box = e.target as HTMLInputElement;
  details.value.plainHttpOn = box.checked;
  box.checked = details.value.plainHttpOn;
}
</script>

<template>
  <div ref="root" class="fdn-skills-editor" :aria-busy="details.isBusy">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ details.drawerName }}</h2>
    <label class="fdn-skills-switch">
      <input type="checkbox" role="switch" :checked="details.server.isOn" :aria-label="details.server.switchName"
        @change="details.server.isOn = ($event.target as HTMLInputElement).checked">
      <span>{{ details.server.isOn ? s.skillOn : s.skillOff }}</span>
    </label>
    <p class="fdn-tp-status" :data-kind="details.server.statusKind" dir="auto"><span class="fdn-tp-dot" aria-hidden="true" /><span>{{ details.statusText }}</span></p>
    <dl class="fdn-tp-facts">
      <div v-for="f in details.facts" :key="f.label">
        <dt dir="auto">{{ f.label }}</dt>
        <dd :class="{ 'fdn-tp-mono': f.isMono, 'fdn-tp-muted': f.isMuted }" dir="auto">{{ f.value }}</dd>
      </div>
    </dl>

    <label class="fdn-skills-switch">
      <input type="checkbox" role="switch" :checked="details.isTrusted" :disabled="!details.canChangeMarks" :aria-label="details.trustedName"
        :aria-describedby="`${id}-trusted`" @change="trust">
      <span dir="auto">{{ s.toolsTrusted }}</span>
    </label>
    <p :id="`${id}-trusted`" class="fdn-tp-help" dir="auto">{{ details.trustedNote }}</p>
    <p class="fdn-tp-help" dir="auto">{{ s.toolsDrawerNote }}</p>

    <div class="fdn-tp-section">
      <h3 dir="auto">{{ details.toolsTitle }}</h3>
      <div class="fdn-wizard-field fdn-tp-filter">
        <input type="text" :aria-label="s.toolsDrawerFilterName" :placeholder="s.toolsDrawerFilterPlaceholder" autocomplete="off" :value="details.toolFilter" dir="auto"
          @input="details.toolFilter = ($event.target as HTMLInputElement).value">
      </div>
      <p v-if="details.hasNoToolsText" class="fdn-muted" role="status" dir="auto">{{ details.noToolsText }}</p>
      <ul class="fdn-tp-toollist">
        <ToolsToolRow v-for="tool in details.tools" :key="tool.name" :tool="tool" :strings="s" />
      </ul>
    </div>

    <div v-if="details.showsAdvanced" class="fdn-tp-section">
      <h3 dir="auto">{{ s.toolsAdvanced }}</h3>
      <label class="fdn-skills-switch">
        <input type="checkbox" role="switch" data-plain-switch :checked="details.plainHttpOn" :aria-describedby="`${id}-plain`" @change="plainHttp">
        <span dir="auto">{{ s.mcpPlainHttpSwitch }}</span>
      </label>
      <p :id="`${id}-plain`" class="fdn-tp-help" dir="auto">{{ s.mcpPlainHttpSwitchHelp }}</p>
      <p v-if="details.hasPlainHttpError" class="fdn-wizard-error" role="alert" dir="auto">{{ details.plainHttpError }}</p>
      <div v-if="details.isPlainHttpWarningOpen" class="fdn-card fdn-tp-warning" role="alertdialog" :aria-labelledby="`${id}-warn-title`" :aria-describedby="`${id}-warn-text`">
        <h3 :id="`${id}-warn-title`" dir="auto">{{ s.mcpPlainHttpWarningTitle }}</h3>
        <p :id="`${id}-warn-text`" dir="auto">{{ details.plainHttpWarningText }}</p>
        <div class="fdn-wizard-actions">
          <button type="button" class="fdn-button fdn-primary" data-wizard-focus dir="auto" @click="details.confirmPlainHttp()">{{ s.mcpPlainHttpConfirm }}</button>
          <button type="button" class="fdn-button" dir="auto" @click="details.cancelPlainHttp()">{{ s.mcpPlainHttpCancel }}</button>
        </div>
      </div>
    </div>

    <p v-if="details.hasTest" class="fdn-tp-result" role="status" dir="auto">{{ details.testText }}</p>
    <div v-if="details.isConfirmingRemove" class="fdn-card fdn-skills-ask" role="group" :aria-labelledby="`${id}-remove`">
      <h3 :id="`${id}-remove`" role="alert" dir="auto">{{ details.removeConfirmText }}</h3>
      <div class="fdn-wizard-actions">
        <button type="button" class="fdn-button" data-wizard-focus dir="auto" @click="details.keep()">{{ s.toolsRemoveKeep }}</button>
        <button type="button" class="fdn-button fdn-primary" :aria-label="details.removeName" dir="auto" @click="details.confirmRemove()">{{ s.toolsRemoveYes }}</button>
      </div>
    </div>
    <div v-else class="fdn-wizard-actions">
      <button type="button" class="fdn-button" :disabled="details.isBusy" dir="auto" @click="details.test()">{{ s.toolsTestTooltip }}</button>
      <button type="button" class="fdn-button" :disabled="!details.canRestart" dir="auto" @click="details.restart()">{{ s.toolsRestartTooltip }}</button>
      <button type="button" class="fdn-button" dir="auto" @click="details.edit()">{{ s.toolsEditTooltip }}</button>
      <button type="button" class="fdn-button fdn-quiet" dir="auto" @click="details.askRemove()">{{ s.toolsRemoveTooltip }}</button>
    </div>
    <div class="fdn-wizard-actions">
      <button type="button" class="fdn-button fdn-quiet" dir="auto" @click="details.close()">{{ s.toolsCloseDetails }}</button>
    </div>
  </div>
</template>
