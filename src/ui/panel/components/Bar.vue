<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{ label?: string; value: number; max?: number; min?: number; color?: string; mark?: number | null; digits?: number; hint?: string }>(),
  { max: 100, min: 0, color: 'var(--team)', mark: null, digits: 1 },
);
const pct = computed(() => Math.max(0, Math.min(100, ((props.value - props.min) / (props.max - props.min)) * 100)));
const refPct = computed(() => (props.mark === null ? null : Math.max(0, Math.min(100, ((props.mark - props.min) / (props.max - props.min)) * 100))));
</script>

<template>
  <div class="bar" :class="{ nolabel: !label }" :title="hint">
    <span v-if="label" class="bar-label">{{ label }}</span>
    <div class="bar-track">
      <div class="bar-fill" :style="{ width: pct + '%', background: color }"></div>
      <div v-if="refPct !== null" class="bar-ref" :style="{ left: refPct + '%' }"></div>
    </div>
    <span class="bar-val mono">{{ value.toFixed(digits) }}</span>
  </div>
</template>

<style scoped>
.bar {
  display: grid;
  grid-template-columns: auto 1fr 42px;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.bar.nolabel {
  grid-template-columns: 1fr 42px;
}
.bar-label {
  color: var(--muted);
  min-width: 56px;
}
.bar-track {
  position: relative;
  height: 7px;
  border-radius: 4px;
  background: var(--bg);
  border: 1px solid var(--line);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 4px;
}
.bar-ref {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: #fff;
  opacity: 0.7;
}
.bar-val {
  text-align: right;
}
</style>
