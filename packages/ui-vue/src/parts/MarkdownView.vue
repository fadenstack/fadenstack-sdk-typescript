<script setup lang="ts">
import type { MarkdownBlock, MarkdownPart, UiStrings } from "@fadenstack/ui";

import { useViewModel } from "../composables.js";
import Markdown from "../markdown/Markdown.vue";

const props = defineProps<{ part: MarkdownPart; strings: UiStrings }>();
const part = useViewModel(() => props.part);
// The same functions for the part's life, so blocks that did not change are not drawn again while it streams.
const copyCode = (code: string) => props.part.copyCode(code);
const copyTable = (table: Extract<MarkdownBlock, { kind: "table" }>) => props.part.copyTable(table);
</script>

<template>
  <Markdown :blocks="part.blocks" :strings="strings" :streaming="part.isStreaming" :copy-code="copyCode" :copy-table="copyTable" />
</template>
