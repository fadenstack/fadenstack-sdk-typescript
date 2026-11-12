<script setup lang="ts">
import type { MarkdownBlock, UiStrings } from "@fadenstack/ui";

import Icon from "../Icon.vue";
import CopyButton from "./CopyButton.vue";
import Inlines from "./Inlines.js";

type TableBlock = Extract<MarkdownBlock, { kind: "table" }>;

/** A table of an answer, with a copy button (tab-separated and as HTML) when the part can copy. */
const props = defineProps<{
  block: TableBlock;
  strings: UiStrings;
  copy?: ((table: TableBlock) => void) | undefined;
  /** Saves the table as a CSV file; without it there is no download button. */
  download?: ((table: TableBlock) => void) | undefined;
}>();
const align = (i: number) => (props.block.align[i] ? { textAlign: props.block.align[i]! } : undefined);
const copyThis = () => props.copy?.(props.block);
const downloadThis = () => props.download?.(props.block);
</script>

<template>
  <div class="fdn-md-table">
    <div class="fdn-md-table-scroll">
      <table dir="auto">
        <thead>
          <tr>
            <th v-for="(cell, i) in block.header" :key="i" :style="align(i)"><Inlines :inlines="cell" :strings="strings" /></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, r) in block.rows" :key="r">
            <td v-for="(cell, i) in row" :key="i" :style="align(i)"><Inlines :inlines="cell" :strings="strings" /></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="copy || download" class="fdn-md-table-bar">
      <CopyButton v-if="copy" :label="strings.copyTable" :strings="strings" :copy="copyThis" />
      <button v-if="download" type="button" class="fdn-icon-button fdn-small" :aria-label="strings.downloadCsv" :title="strings.downloadCsv" @click="downloadThis">
        <Icon name="download" :size="14" />
      </button>
    </div>
  </div>
</template>
