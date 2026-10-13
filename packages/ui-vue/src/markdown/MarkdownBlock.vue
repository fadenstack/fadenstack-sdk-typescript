<script setup lang="ts">
/**
 * One Markdown block. Blocks are immutable, so Vue draws a block again only when it was replaced: while an answer
 * streams, only the last one. Text blocks take their direction from their own text (`dir="auto"`).
 */
import type { MarkdownBlock as Block, UiStrings } from "@fadenstack/ui";
import { headingTag } from "@fadenstack/ui-web";

import CodeBlock from "./CodeBlock.vue";
import Inlines from "./Inlines.js";
import MarkdownTable from "./MarkdownTable.vue";

type TableBlock = Extract<Block, { kind: "table" }>;

defineProps<{
  block: Block;
  strings: UiStrings;
  copyCode?: ((code: string) => void) | undefined;
  copyTable?: ((table: TableBlock) => void) | undefined;
}>();
</script>

<template>
  <p v-if="block.kind === 'paragraph'" dir="auto"><Inlines :inlines="block.inlines" :strings="strings" /></p>
  <component :is="headingTag(block.level)" v-else-if="block.kind === 'heading'" :class="`fdn-md-h${block.level}`" dir="auto"><Inlines :inlines="block.inlines" :strings="strings" /></component>
  <CodeBlock
    v-else-if="block.kind === 'code'"
    :language="block.language"
    :code="block.code"
    :complete="block.complete"
    :strings="strings"
    :copy="copyCode"
  />
  <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'" :start="block.ordered ? block.start : undefined">
    <li v-for="(item, i) in block.items" :key="i" v-bind="item.checked === undefined ? {} : { class: 'fdn-md-task' }" dir="auto">
      <input v-if="item.checked !== undefined" type="checkbox" :checked="item.checked" readonly disabled>
      <template v-for="b in item.blocks" :key="b.key">
        <span v-if="b.kind === 'paragraph'" class="fdn-md-li"><Inlines :inlines="b.inlines" :strings="strings" /></span>
        <MarkdownBlock v-else :block="b" :strings="strings" :copy-code="copyCode" :copy-table="copyTable" />
      </template>
    </li>
  </component>
  <blockquote v-else-if="block.kind === 'quote'" dir="auto">
    <MarkdownBlock v-for="b in block.blocks" :key="b.key" :block="b" :strings="strings" :copy-code="copyCode" :copy-table="copyTable" />
  </blockquote>
  <MarkdownTable v-else-if="block.kind === 'table'" :block="block" :strings="strings" :copy="copyTable" />
  <hr v-else-if="block.kind === 'rule'">
</template>
