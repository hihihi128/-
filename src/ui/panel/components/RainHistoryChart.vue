<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ history: number[] }>();
const W = 600;
const H = 180;
const plot = { left: 46, right: 14, top: 16, bottom: 30 };
const values = computed(() => props.history.map(value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0));
const width = W - plot.left - plot.right;
const height = H - plot.top - plot.bottom;
const x = (index: number) => plot.left + (index / Math.max(1, values.value.length - 1)) * width;
const y = (value: number) => plot.top + (1 - value) * height;
const linePath = computed(() => values.value.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' '));
const areaPath = computed(() => values.value.length
  ? `${linePath.value} L${x(values.value.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`
  : '');
const peak = computed(() => Math.max(0, ...values.value));
const peakLap = computed(() => Math.max(1, values.value.indexOf(peak.value) + 1));
const rainyLaps = computed(() => values.value.filter(value => value >= .05).length);
const summary = computed(() => rainyLaps.value
  ? `共 ${rainyLaps.value} 圈有明显降雨，峰值 ${Math.round(peak.value * 100)}%，出现在第 ${peakLap.value} 圈`
  : '全程无明显降雨');
const middleLap = computed(() => Math.max(1, Math.ceil(values.value.length / 2)));
</script>

<template>
  <figure class="rain-history" :aria-label="`比赛降雨复盘：${summary}`">
    <div class="spread chart-heading">
      <div>
        <strong>比赛降雨复盘</strong>
        <div class="tiny muted">逐圈实际降雨强度</div>
      </div>
      <span class="badge">{{ summary }}</span>
    </div>
    <svg :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="横轴为比赛圈数，纵轴为实际降雨强度">
      <defs>
        <linearGradient id="rain-history-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#38bdf8" stop-opacity=".72" />
          <stop offset="1" stop-color="#38bdf8" stop-opacity=".08" />
        </linearGradient>
      </defs>
      <g v-for="tick in [0, .25, .5, .75, 1]" :key="tick">
        <line :x1="plot.left" :x2="W - plot.right" :y1="y(tick)" :y2="y(tick)" class="grid-line" />
        <text x="4" :y="y(tick) + 4" class="axis">{{ Math.round(tick * 100) }}%</text>
      </g>
      <path :d="areaPath" fill="url(#rain-history-fill)" />
      <path :d="linePath" class="rain-line" />
      <text :x="plot.left" :y="H - 8" class="lap-label">第 1 圈</text>
      <text :x="x(middleLap - 1)" :y="H - 8" text-anchor="middle" class="lap-label">第 {{ middleLap }} 圈</text>
      <text :x="W - plot.right" :y="H - 8" text-anchor="end" class="lap-label">第 {{ values.length }} 圈</text>
    </svg>
  </figure>
</template>

<style scoped>
.rain-history {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(56, 189, 248, .08), transparent 54%), var(--bg);
}
.chart-heading { align-items: flex-start; margin-bottom: 8px; }
svg { width: 100%; height: 180px; display: block; }
.grid-line { stroke: #29303d; stroke-width: 1; stroke-dasharray: 3 4; }
.rain-line { fill: none; stroke: #7dd3fc; stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }
.axis, .lap-label { fill: #8d96a8; font-size: 10px; }
@media (max-width: 560px) {
  .chart-heading { align-items: stretch; flex-direction: column; }
  .chart-heading .badge { white-space: normal; }
  svg { height: 150px; }
}
</style>
