<script setup lang="ts">
withDefaults(defineProps<{ kind: 'dry' | 'wet' | 'damp' | 'unknown'; label?: string }>(), { label: '' });
</script>

<template>
  <svg class="weather-glyph" viewBox="0 0 48 48" role="img" :aria-label="label || (kind === 'dry' ? '晴朗' : kind === 'wet' ? '雨天' : kind === 'damp' ? '潮湿' : '天气未知')">
    <template v-if="kind === 'dry'">
      <circle cx="24" cy="24" r="8" /><path d="M24 4v7M24 37v7M4 24h7M37 24h7M10 10l5 5M33 33l5 5M38 10l-5 5M15 33l-5 5" />
    </template>
    <template v-else-if="kind === 'unknown'"><path d="M17 17a9 9 0 0 1 17 4 7 7 0 1 1 1 14H15a8 8 0 1 1 2-18Z" /><path d="M24 20v8M24 33h.01" /></template>
    <template v-else>
      <path d="M15 27a9 9 0 0 1 17-3 7 7 0 1 1 2 13H15a8 8 0 1 1 0-10Z" />
      <path v-if="kind === 'wet'" d="M17 40l-2 4M25 40l-2 4M33 40l-2 4" /><path v-else d="M18 41h15" />
    </template>
  </svg>
</template>

<style scoped>
.weather-glyph { width:42px; height:42px; fill:none; stroke:var(--cyan); stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; flex:none; }
</style>
