<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ history: number[] }>();
const W = 600;
const H = 150;
const plot = { left: 0, right: 0, top: 6, bottom: 6 };
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
const rainyLaps = computed(() => values.value.filter(value => value > 0).length);
const raceRainLaps = computed(() => values.value.filter(value => value > .25).length);
const summary = computed(() => rainyLaps.value
  ? `共 ${rainyLaps.value} 圈记录到降雨，其中 ${raceRainLaps.value} 圈达到雨战强度；峰值 ${Math.round(peak.value * 100)}%，出现在第 ${peakLap.value} 圈`
  : '全程无明显降雨');
const middleLap = computed(() => Math.max(1, Math.ceil(values.value.length / 2)));
</script>

<template>
  <figure class="rain-history">
    <figcaption class="spread chart-heading">
      <div>
        <strong>比赛降雨复盘</strong>
        <div class="tiny muted">逐圈实际降雨强度</div>
      </div>
      <span class="badge">{{ summary }}</span>
    </figcaption>
    <div class="chart-body">
      <div class="y-axis" aria-hidden="true"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
      <div class="plot">
        <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="`横轴为第 1 至 ${values.length} 圈，纵轴为实际降雨强度。${summary}`">
          <defs>
            <linearGradient id="rain-history-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#38bdf8" stop-opacity=".72" />
              <stop offset="1" stop-color="#38bdf8" stop-opacity=".08" />
            </linearGradient>
          </defs>
          <line v-for="tick in [0, .25, .5, .75, 1]" :key="tick" :x1="plot.left" :x2="W - plot.right" :y1="y(tick)" :y2="y(tick)" class="grid-line" />
          <path :d="areaPath" fill="url(#rain-history-fill)" />
          <path :d="linePath" class="rain-line" vector-effect="non-scaling-stroke" />
        </svg>
        <div class="x-axis" aria-hidden="true"><span>第 1 圈</span><span>第 {{ middleLap }} 圈</span><span>第 {{ values.length }} 圈</span></div>
      </div>
    </div>
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
.chart-body { display: flex; gap: 8px; }
.plot { flex: 1; min-width: 0; }
svg { width: 100%; height: 150px; display: block; }
.y-axis { width: 32px; height: 150px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; color: #8d96a8; font-size: 10px; line-height: 1; padding: 2px 0; }
.x-axis { display: flex; justify-content: space-between; color: #8d96a8; font-size: 10px; margin-top: 5px; }
.grid-line { stroke: #29303d; stroke-width: 1; stroke-dasharray: 3 4; }
.rain-line { fill: none; stroke: #7dd3fc; stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }
@media (max-width: 560px) {
  .chart-heading { align-items: stretch; flex-direction: column; }
  .chart-heading .badge { white-space: normal; }
  svg, .y-axis { height: 140px; }
}
</style>
