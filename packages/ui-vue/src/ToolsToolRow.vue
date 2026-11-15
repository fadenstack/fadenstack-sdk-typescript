<script setup lang="ts">
/** A tool of a local server in the details: what the server says, the class it has now and the person's raise (none for a destructive tool). */
import { useId } from "vue";

import { LocalToolClass, type LocalToolRaise } from "@fadenstack/agents";
import type { LocalToolViewModel, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";

const props = defineProps<{ tool: LocalToolViewModel; strings: UiStrings }>();
const tool = useViewModel(() => props.tool);
const id = useId();
</script>

<template>
  <li class="fdn-card fdn-tp-tool">
    <div class="fdn-tp-name" dir="auto">{{ tool.name }}</div>
    <div v-if="tool.hasDescription" class="fdn-muted" dir="auto">{{ tool.description }}</div>
    <div class="fdn-skills-badges">
      <span v-for="hint in tool.hints" :key="hint" class="fdn-badge" dir="auto">{{ hint }}</span>
      <span class="fdn-badge" :class="tool.class === LocalToolClass.Write ? 'fdn-class-write' : tool.isDestructive ? 'fdn-class-destructive' : ''" dir="auto">{{ tool.classText }}</span>
    </div>
    <p v-if="tool.isDestructive" class="fdn-tp-help" dir="auto">{{ tool.destructiveHelp }}</p>
    <div v-else class="fdn-tp-tool-picker">
      <label :for="`${id}-raise`" dir="auto">{{ strings.toolsRaiseLabel }}</label>
      <select :id="`${id}-raise`" :aria-label="tool.raiseName" :value="tool.selectedRaise" :disabled="!tool.canRaise"
        @change="tool.selectedRaise = ($event.target as HTMLSelectElement).value as LocalToolRaise">
        <option v-for="o in tool.raiseOptions" :key="o.raise" :value="o.raise" :selected="o.raise === tool.selectedRaise">{{ o.text }}</option>
      </select>
    </div>
  </li>
</template>
