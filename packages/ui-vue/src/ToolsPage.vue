<script setup lang="ts">
/**
 * The Tools view (sdk/51 F05) in the wizard's column: a header, the policy, the tabs "On this computer" and "On your server", a filter
 * and Add; the person's MCP servers as cards (a card's name opens its details, with the trust mark, each tool's class and the
 * plain-http switch under Advanced); the add and edit sheet and the paste-import sheet in place of the list; the organisation's tools
 * by server, read only. A header value is a password box that is cleared when the sheet is saved or closed; a saved one shows as dots
 * and Replace. Turning the plain-http switch on opens a warning that takes the focus on its Confirm. Esc closes the top layer.
 * Parity with `@fadenstack/ui-react`'s `ToolsPage`.
 */
import { computed, nextTick, ref, useId } from "vue";

import { ImportSheetViewModel, ServerSheetViewModel, type ToolsPageViewModel } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";
import SkillShell from "./SkillShell.vue";
import Spinner from "./Spinner.vue";
import { useFirstFocus } from "./skills.js";
import ToolsCloudGroup from "./ToolsCloudGroup.vue";
import ToolsDetails from "./ToolsDetails.vue";
import ToolsImportSheet from "./ToolsImportSheet.vue";
import ToolsServerCard from "./ToolsServerCard.vue";
import ToolsServerSheet from "./ToolsServerSheet.vue";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The page's view model; the app calls `open()` when it shows it (and `retext()` when the language changes). */
  tools: ToolsPageViewModel;

  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { theme: "system" });

const vm = useViewModel(() => props.tools);
const s = computed(() => vm.value.strings);
const id = useId();
const shell = ref<{ $el: Element } | null>(null);

// A new layer takes the focus: its first marked field, else its title.
useFirstFocus(shell, () => {
  const v = vm.value;
  return v.sheet ? `sheet:${v.sheet instanceof ServerSheetViewModel ? v.sheet.title : "import"}` : v.details ? `details:${v.details.label}` : "main";
});

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (!vm.value.closeTop()) return;
  e.preventDefault();
  e.stopPropagation();
}

function tabKeys(e: KeyboardEvent): void {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const tabs = vm.value.tabs;
  const step = (e.key === "ArrowLeft") !== (s.value.direction === "rtl") ? -1 : 1;
  const to = tabs[Math.min(tabs.length - 1, Math.max(0, tabs.indexOf(vm.value.tab) + step))]!;
  vm.value.selectTab(to);
  e.preventDefault();
  void nextTick(() => document.getElementById(`${id}-${to}-tab`)?.focus());
}
</script>

<template>
  <SkillShell ref="shell" :strings="s" :theme="theme" :busy="vm.isLoadingCloud" extra-class="fdn-toolspage" @keydown="onKeyDown">
    <ToolsServerSheet v-if="vm.sheet instanceof ServerSheetViewModel" :sheet="vm.sheet" />
    <ToolsImportSheet v-else-if="vm.sheet instanceof ImportSheetViewModel" :sheet="vm.sheet" />
    <ToolsDetails v-else-if="vm.details" :details="vm.details" />
    <template v-else>
      <h2 class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ s.toolsTitle }}</h2>
      <p class="fdn-muted" dir="auto">{{ s.toolsIntro }}</p>
      <p v-if="vm.needsSignIn" class="fdn-wizard-note" role="status" dir="auto">{{ s.toolsSignInNeeded }}</p>
      <template v-if="vm.showsLists">
        <p v-if="vm.showsBanner" class="fdn-wizard-note" role="status" dir="auto">{{ vm.bannerText }}</p>
        <div class="fdn-tp-bar">
          <div class="fdn-tp-tabs" role="tablist" :aria-label="s.toolsTitle" @keydown="tabKeys">
            <button :id="`${id}-app-tab`" type="button" role="tab" class="fdn-tp-tab" :aria-selected="vm.showsApp" :aria-controls="`${id}-app`"
              :tabindex="vm.showsApp ? 0 : -1" dir="auto" @click="vm.selectTab('app')">{{ vm.appTabText }}</button>
            <button :id="`${id}-computer-tab`" type="button" role="tab" class="fdn-tp-tab" :aria-selected="vm.showsLocal" :aria-controls="`${id}-computer`"
              :tabindex="vm.showsLocal ? 0 : -1" dir="auto" @click="vm.selectTab('computer')">{{ vm.localTabText }}</button>
            <button v-if="vm.showsServerTab" :id="`${id}-server-tab`" type="button" role="tab" class="fdn-tp-tab" :aria-selected="vm.showsServer" :aria-controls="`${id}-server`"
              :tabindex="vm.showsServer ? 0 : -1" dir="auto" @click="vm.selectTab('server')">{{ vm.serverTabText }}</button>
          </div>
          <span v-if="vm.showsLocalChip" class="fdn-badge fdn-tp-policy" :class="{ 'fdn-tp-policy-warning': vm.policyIsWarning }" :title="vm.policyTip" dir="auto">
            <Icon :name="vm.policyIsWarning ? 'warning' : 'check'" :size="12" />{{ vm.policyText }}
          </span>
        </div>
        <div class="fdn-wizard-field fdn-tp-filter">
          <input type="text" :aria-label="s.toolsFilterPlaceholder" :placeholder="s.toolsFilterPlaceholder" autocomplete="off" :value="vm.filter" dir="auto"
            @input="vm.filter = ($event.target as HTMLInputElement).value">
        </div>

        <div v-if="vm.showsApp" :id="`${id}-app`" class="fdn-tp-section" role="tabpanel" :aria-labelledby="`${id}-app-tab`">
          <p v-if="vm.showsAppEmpty" class="fdn-muted" role="status" dir="auto">{{ vm.appEmptyText }}</p>
          <p v-if="vm.showsAppNoMatch" class="fdn-muted" role="status" dir="auto">{{ vm.appNoMatchText }}</p>
          <section v-if="vm.appTools.length > 0" class="fdn-card">
            <ul class="fdn-tp-cloud-list">
              <li v-for="t in vm.appTools" :key="t.name" class="fdn-tp-cloud-tool">
                <div>
                  <div class="fdn-tp-name" dir="auto">{{ t.name }}</div>
                  <div v-if="t.hasDescription" class="fdn-muted" dir="auto">{{ t.description }}</div>
                </div>
                <span class="fdn-badge" dir="auto">{{ t.classLabel }}</span>
              </li>
            </ul>
          </section>
        </div>

        <div v-else-if="vm.showsLocal" :id="`${id}-computer`" class="fdn-tp-section" role="tabpanel" :aria-labelledby="`${id}-computer-tab`">
          <h3 dir="auto">{{ s.toolsSectionServers }}</h3>
          <p class="fdn-muted" dir="auto">{{ s.toolsSectionServersHelp }}</p>
          <p v-if="vm.hasListNote" class="fdn-wizard-note" role="status" dir="auto">{{ vm.listNote }}</p>
          <div class="fdn-wizard-actions">
            <button type="button" class="fdn-button fdn-primary" dir="auto" @click="vm.addServer()"><Icon name="plus" :size="14" /> {{ s.toolsAddServer }}</button>
            <button type="button" class="fdn-button fdn-quiet" dir="auto" @click="vm.importServers()">{{ s.toolsPasteMore }}</button>
          </div>
          <div v-if="vm.showsEmpty" class="fdn-card fdn-tp-empty">
            <h3 dir="auto">{{ s.toolsEmptyTitle }}</h3>
            <p dir="auto">{{ s.toolsEmptyText }}</p>
          </div>
          <p v-if="vm.showsNoMatch" class="fdn-muted" role="status" dir="auto">{{ s.toolsNoToolsMatch }}</p>
          <ul v-if="vm.servers.length > 0" class="fdn-skills-list">
            <ToolsServerCard v-for="server in vm.servers" :key="server.label" :server="server" />
          </ul>
        </div>

        <div v-else :id="`${id}-server`" class="fdn-tp-section" role="tabpanel" :aria-labelledby="`${id}-server-tab`">
          <p class="fdn-muted" dir="auto">{{ s.toolsCloudIntro }}</p>
          <p v-if="vm.isLoadingCloud" class="fdn-wizard-busy" role="status" dir="auto"><Spinner /><span>{{ s.toolsLoading }}</span></p>
          <p v-if="vm.hasCloudMessage" class="fdn-muted" role="status" dir="auto">{{ vm.cloudMessage }}</p>
          <div v-if="vm.canRetry" class="fdn-wizard-actions">
            <button type="button" class="fdn-button" dir="auto" @click="vm.retry()">{{ s.toolsTryAgain }}</button>
          </div>
          <ToolsCloudGroup v-for="group in vm.cloudGroups" :key="group.server" :group="group" />
        </div>
      </template>
    </template>
  </SkillShell>
</template>
