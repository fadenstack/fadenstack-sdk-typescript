<script setup lang="ts">
/**
 * "Your data in this browser", where an app keeps its settings (GDPR Art. 15, 17 and 20): "Export my data" and "Remove my data…" for this
 * app, "Export all my Fadenstack data" and "Remove all my Fadenstack data in this browser…" for every app. A removal asks first in a
 * dialog (the focus moves to it; Escape says no): for this app what goes and what stays because other apps use it, for all the apps
 * it affects. Then a result line. The texts, the checks and the buttons' state are the view model's. Parity with `@fadenstack/ui-react`'s
 * `MyDataSettings`.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";

import type { MyDataSettingsViewModel } from "@fadenstack/ui";
import { whenShown } from "@fadenstack/ui-web";

import { useViewModel } from "./composables.js";
import SkillShell from "./SkillShell.vue";
import { useFirstFocus } from "./skills.js";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The control's view model (`new MyDataSettingsViewModel({ agent })`). Call its `load()` once when the page opens (the skin calls `refresh()` each time it is shown); handle its `onSaveRequest`. */
  settings: MyDataSettingsViewModel;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { theme: "system" });

const vm = useViewModel(() => props.settings);
const s = computed(() => vm.value.strings);
const id = useId();
const root = ref<InstanceType<typeof SkillShell> | null>(null);
useFirstFocus(root, () => vm.value.phase);

// The record of tool calls grows as the agents work: read it each time the control is shown.
let stopShown: (() => void) | undefined;
onMounted(() => {
  const el = root.value?.$el as Element | undefined;
  if (el) stopShown = whenShown(el, () => { void vm.value.refresh(); });
});
onBeforeUnmount(() => stopShown?.());

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && vm.value.showConfirm) {
    e.preventDefault();
    e.stopPropagation();
    vm.value.cancel();
  }
}
</script>

<template>
  <SkillShell ref="root" :strings="s" :theme="theme" :busy="vm.isBusy" @keydown="onKeydown">
    <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ s.myDataTitle }}</h2>
    <p class="fdn-wizard-note" dir="auto">{{ s.myDataIntro }}</p>
    <div v-if="vm.showConfirm" class="fdn-card fdn-skills-ask" role="alertdialog" aria-modal="false" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-text`">
      <h3 :id="`${id}-title`" dir="auto">{{ vm.confirmTitle }}</h3>
      <div :id="`${id}-text`">
        <p v-for="(line, i) in vm.confirmLines" :key="i" dir="auto">{{ line }}</p>
      </div>
      <div class="fdn-wizard-actions">
        <button type="button" class="fdn-button" data-wizard-focus :aria-label="s.myDataCancelName" dir="auto" @click="vm.cancel()">{{ s.myDataCancel }}</button>
        <button type="button" class="fdn-button fdn-primary" :aria-label="vm.confirmName" dir="auto" @click="vm.confirm()">{{ vm.confirmLabel }}</button>
      </div>
    </div>
    <template v-else>
      <div class="fdn-wizard-actions">
        <button type="button" class="fdn-button" data-wizard-focus :disabled="!vm.canAct" :aria-label="s.myDataExportName" dir="auto" @click="vm.exportThisApp()">{{ s.myDataExport }}</button>
        <button type="button" class="fdn-button" :disabled="!vm.canAct" :aria-label="s.myDataRemoveName" dir="auto" @click="vm.askRemoveThisApp()">{{ s.myDataRemove }}</button>
      </div>
      <div class="fdn-wizard-actions">
        <button type="button" class="fdn-button fdn-quiet" :disabled="!vm.canAct" :aria-label="s.myDataExportAllName" dir="auto" @click="vm.exportAll()">{{ s.myDataExportAll }}</button>
        <button type="button" class="fdn-button fdn-quiet" :disabled="!vm.canAct" :aria-label="s.myDataRemoveAllName" dir="auto" @click="vm.askRemoveAll()">{{ s.myDataRemoveAll }}</button>
      </div>
      <template v-if="vm.hasAudit">
        <!-- The person's record of tool calls: how many entries since when, intact or damaged; and its export as a web page. -->
        <p v-if="vm.hasAuditLine" :class="vm.auditDamaged ? 'fdn-skills-message fdn-skills-message-warning' : 'fdn-skills-message'" data-audit-line dir="auto">{{ vm.auditLine }}</p>
        <div class="fdn-wizard-actions">
          <button type="button" class="fdn-button" :disabled="!vm.canAct" :aria-label="s.myDataAuditExportName" dir="auto" @click="vm.exportAudit()">{{ s.myDataAuditExport }}</button>
        </div>
      </template>
    </template>
    <p class="fdn-skills-message" :role="vm.isError ? 'alert' : 'status'" dir="auto">{{ vm.statusText }}</p>
  </SkillShell>
</template>
