<script setup lang="ts">
/** The round "working" indicator. */
withDefaults(defineProps<{ size?: number }>(), { size: 14 });
</script>

<template>
  <span class="fdn-spinner" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true" />
</template>
