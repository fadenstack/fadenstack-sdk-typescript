<script setup lang="ts">
/** A `markdown` fence: its content rendered, or its source (a code block) by the switch in the header. */
import { ref } from "vue";

import type { MarkdownBlock as Block, UiStrings } from "@fadenstack/ui";

import CodeBlock from "./CodeBlock.vue";
import MarkdownBlockView from "./MarkdownBlock.vue";

type TableBlock = Extract<Block, { kind: "table" }>;

defineProps<{
  block: Extract<Block, { kind: "preview" }>;
  strings: UiStrings;
  copyCode?: ((code: string) => void) | undefined;
  copyTable?: ((table: TableBlock) => void) | undefined;
  downloadTable?: ((table: TableBlock) => void) | undefined;
}>();
const source = ref(false);
</script>

<template>
  <div class="fdn-md-preview">
    <div class="fdn-md-preview-bar" role="group">
      <button type="button" class="fdn-md-switch" :aria-pressed="!source" @click="source = false">{{ strings.markdownPreview }}</button>
      <button type="button" class="fdn-md-switch" :aria-pressed="source" @click="source = true">{{ strings.markdownSource }}</button>
    </div>
    <CodeBlock
      v-if="source"
      :language="block.source.language"
      :code="block.source.code"
      :complete="block.source.complete"
      :strings="strings"
      :copy="copyCode"
    />
    <div v-else class="fdn-md-preview-body">
      <MarkdownBlockView v-for="b in block.blocks" :key="b.key" :block="b" :strings="strings" :copy-code="copyCode" :copy-table="copyTable" :download-table="downloadTable" />
    </div>
  </div>
</template>
