<script setup lang="ts">
/** The panel's icons, inline (no icon library): 16 px, `currentColor`. The paths are @fadenstack/ui-web's. */
import { iconPaths, type IconName } from "@fadenstack/ui-web";

withDefaults(defineProps<{ name: IconName; size?: number; label?: string }>(), { size: 16, label: undefined });
</script>

<template>
  <svg
    class="fdn-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
    :aria-hidden="label ? undefined : true"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    focusable="false"
  >
    <path :d="iconPaths[name]" />
  </svg>
</template>
