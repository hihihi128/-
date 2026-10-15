<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ series: Array<{ name: string; color: string; data: number[] }>; maxPos: number }>();
const W = 600;
const H = 160;
const laps = computed(() => Math.max(1, ...props.series.map(s => s.data.length)));
function path(data: number[]): string {
  const pts: string[] = [];
  data.forEach((p, i) => {
    if (!p) return;
    const x = (i / Math.max(1, laps.value - 1)) * (W - 30) + 20;
    const y = ((p - 1) / Math.max(1, props.maxPos - 1)) * (H - 20) + 10;
    pts.push(`${pts.length ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
  });
  return pts.join(' ');
}
</script>

<template>
  <div>
    <svg :viewBox="`0 0 ${W} ${H}`" class="chart" preserveAspectRatio="none">
      <line v-for="p in maxPos" :key="p" x1="20" :x2="W - 10" :y1="((p - 1) / Math.max(1, maxPos - 1)) * (H - 20) + 10" :y2="((p - 1) / Math.max(1, maxPos - 1)) * (H - 20) + 10" class="grid-line" />
      <text v-for="p in maxPos" :key="'t' + p" x="2" :y="((p - 1) / Math.max(1, maxPos - 1)) * (H - 20) + 14" class="axis">{{ p }}</text>
      <path v-for="s in series" :key="s.name" :d="path(s.data)" :stroke="s.color" fill="none" stroke-width="2.5" stroke-linejoin="round" />
    </svg>
    <div class="row tiny muted">
      <span v-for="s in series" :key="s.name"><span class="swatch" :style="{ background: s.color }"></span>{{ s.name }}</span>
      <span>（纵轴：名次，横轴：圈数 1~{{ laps }}）</span>
    </div>
  </div>
</template>

<style scoped>
.chart {
  width: 100%;
  height: 160px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.grid-line {
  stroke: #222733;
  stroke-width: 1;
}
.axis {
  fill: #6b7180;
  font-size: 9px;
}
</style>
