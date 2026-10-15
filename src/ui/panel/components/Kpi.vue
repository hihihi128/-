<script setup lang="ts">
defineProps<{ label: string; value: string | number; sub?: string; tone?: 'ok' | 'warn' | 'bad' | '' }>();
</script>

<template>
  <div class="kpi" :class="tone">
    <div class="kpi-label">{{ label }}</div>
    <div class="kpi-value mono">{{ value }}</div>
    <div v-if="sub" class="kpi-sub">{{ sub }}</div>
  </div>
</template>

<style scoped>
.kpi {
  background: var(--bg2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 12px;
  min-width: 0;
}
.kpi-label {
  color: var(--muted);
  font-size: 12px;
}
.kpi-value {
  font-size: 20px;
  font-weight: 700;
  margin-top: 2px;
}
.kpi-sub {
  color: var(--muted);
  font-size: 11px;
  margin-top: 2px;
}
.kpi.ok .kpi-value {
  color: var(--green);
}
.kpi.warn .kpi-value {
  color: var(--yellow);
}
.kpi.bad .kpi-value {
  color: #ff7b7b;
}
</style>
