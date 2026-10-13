<script setup lang="ts">
/** Markdown blocks as Vue elements -- never as HTML. While the answer streams, only its last block is drawn again. */
import type { MarkdownBlock, UiStrings } from "@fadenstack/ui";

import MarkdownBlockView from "./MarkdownBlock.vue";

type TableBlock = Extract<MarkdownBlock, { kind: "table" }>;

defineProps<{
  blocks: readonly MarkdownBlock[];
  strings: UiStrings;
  /** Copies a code block (the part's clipboard). */
  copyCode?: ((code: string) => void) | undefined;
  /** Copies a table (tab-separated and as HTML); without it tables have no copy button. */
  copyTable?: ((table: TableBlock) => void) | undefined;
  /** A cursor after the last block while the answer streams. */
  streaming?: boolean;
}>();
</script>

<template>
  <div :class="streaming ? 'fdn-md fdn-md-streaming' : 'fdn-md'">
    <MarkdownBlockView v-for="block in blocks" :key="block.key" :block="block" :strings="strings" :copy-code="copyCode" :copy-table="copyTable" />
  </div>
</template>
