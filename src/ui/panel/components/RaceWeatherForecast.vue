<script setup lang="ts">
import { computed } from 'vue';
import type { RaceForecast } from '../../../engine/types';
import { forecastSummary, lapWindowStyle, percent } from '../weatherPresentation';
import RainIntensityGauge from './RainIntensityGauge.vue';
import WeatherGlyph from './WeatherGlyph.vue';

const props = defineProps<{ rain: number; wetness: number; surface: 'dry' | 'damp' | 'wet'; forecast: RaceForecast; completedLaps: number; totalLaps: number }>();
const futureEnd = computed(() => Math.min(props.totalLaps, props.forecast.issuedLap + props.forecast.horizonLaps));
const hasFuture = computed(() => futureEnd.value > props.forecast.issuedLap);
const visibleLaps = computed(() => Math.max(0, futureEnd.value - props.forecast.issuedLap));
const arrival = computed(() => lapWindowStyle(props.forecast.arrivalLaps, visibleLaps.value));
const clippedArrival = computed<[number, number] | null>(() => {
  const range = props.forecast.arrivalLaps;
  if (!range || range[1] < 1 || range[0] > visibleLaps.value) return null;
  return [Math.max(1, range[0]), Math.min(visibleLaps.value, range[1])];
});
const arrivalLabel = computed(() => clippedArrival.value
  ? `预计 ${clippedArrival.value[0]}–${clippedArrival.value[1]} 圈后到达 · 第 ${props.forecast.issuedLap + clippedArrival.value[0]}–${props.forecast.issuedLap + clippedArrival.value[1]} 圈`
  : '暂无明确降雨窗口');
const ticks = computed(() => {
  if (!hasFuture.value) return [];
  const first = props.forecast.issuedLap + 1;
  const last = futureEnd.value;
  if (first === last) return [first];
  const middle = props.forecast.issuedLap + Math.ceil(visibleLaps.value / 2);
  return [...new Set([first, middle, last])];
});
const surfaceLabel = computed(() => `赛道湿度 ${Math.round(props.wetness * 100)}%`);
const summary = computed(() => forecastSummary(props.forecast.issuedLap, Math.max(0, futureEnd.value - props.forecast.issuedLap), props.forecast.intensityRange, props.forecast.arrivalLaps, props.forecast.rainProbability, props.forecast.confidence));
</script>

<template>
  <section class="race-weather" aria-label="赛道与短期天气预报">
    <header class="weather-title"><WeatherGlyph :kind="surface" :label="`当前${surfaceLabel}`" /><div><h3>赛道与短期预报</h3><b>{{ rain > 0 ? `降雨强度 ${Math.round(rain * 100)}%` : '当前无降雨' }} · {{ surfaceLabel }}</b><span class="tiny muted">第 {{ completedLaps }} / {{ totalLaps }} 圈 · 预报第 {{ forecast.issuedLap }} 圈发布</span></div></header>
    <div class="tyre-guide"><span><b>半雨胎</b> 适合赛道湿度 22%–81%</span><span><b>全雨胎</b> 适合赛道湿度 82%–100%</span></div>
    <RainIntensityGauge mode="observed" :value="rain" />
    <RainIntensityGauge mode="forecast" :range="forecast.intensityRange" :horizon-laps="Math.max(0, futureEnd - forecast.issuedLap)" :issued-lap="forecast.issuedLap" />
    <div class="weather-badges" role="group" aria-label="预报不确定性指标"><span>降雨概率 <b>{{ percent(forecast.rainProbability) }}</b></span><span>预报置信度 <b>{{ percent(forecast.confidence) }}</b></span></div>
    <figure v-if="hasFuture" class="arrival"><figcaption>可能到达窗口 · 不代表降雨持续时间</figcaption><div class="arrival-axis" aria-hidden="true"><i v-if="arrival" class="arrival-band" :style="arrival" /><span v-else class="arrival-none">暂无明确降雨窗口</span></div><div class="axis-ticks"><span v-for="tick in ticks" :key="tick">第 {{ tick }} 圈</span></div></figure>
    <p v-if="hasFuture" class="arrival-label">{{ arrivalLabel }}</p>
    <p v-else class="arrival empty">比赛即将结束，暂无后续圈数可供预报。</p>
    <p class="sr-summary">{{ summary }}</p>
  </section>
</template>

<style scoped>
.race-weather { display:grid; gap:9px; }.weather-title { display:flex; gap:9px; align-items:center; }.weather-title h3 { margin:0; }.weather-title b,.weather-title span { display:block; }.tyre-guide { display:grid; grid-template-columns:1fr 1fr; gap:7px; }.tyre-guide span { padding:6px 8px; border-left:3px solid var(--green); background:var(--bg3); font-size:11px; color:var(--muted); }.tyre-guide span:last-child { border-color:var(--blue); }.tyre-guide b { color:var(--text); }.weather-badges { display:grid; grid-template-columns:1fr 1fr; gap:7px; }.weather-badges span { border:1px solid var(--line); background:var(--bg3); padding:6px 8px; font-size:11px; color:var(--muted); }.weather-badges b { display:block; color:var(--text); font:700 17px/1.1 var(--font-num); margin-top:2px; }.arrival { margin:0; border-top:1px solid var(--line); padding-top:8px; }.arrival figcaption { font-size:11px; color:var(--muted); }.arrival-axis { position:relative; height:24px; margin-top:6px; border:1px solid var(--line2); background:repeating-linear-gradient(90deg,#11151d 0 calc(20% - 1px),#293040 calc(20% - 1px) 20%); }.arrival-band { position:absolute; top:2px; bottom:2px; min-width:3px; background:repeating-linear-gradient(135deg,#7fdcff 0 4px,#315367 4px 8px); border-left:1px solid #fff; border-right:1px solid #fff; }.arrival-none { display:grid; place-items:center; height:100%; color:var(--muted); font-size:10px; }.axis-ticks { display:flex; justify-content:space-between; color:var(--muted); font-size:10px; }.arrival-label { margin:0; color:var(--cyan); font-size:11px; }.empty { margin:0; }.sr-summary { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (max-width:767px) { .weather-badges,.tyre-guide { grid-template-columns:1fr; } }
</style>
