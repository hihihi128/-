<script setup lang="ts">
import { computed } from 'vue';
import type { WeekendView } from '../../../engine/view';
import { intervalStyle, percent } from '../weatherPresentation';
import WeatherGlyph from './WeatherGlyph.vue';

const props = defineProps<{ weekend: WeekendView; sprint: boolean; raceLaps: number }>();
const sessions = computed(() => [
  { key: 'practice' as const, label: '练习赛', forecast: null },
  ...(props.sprint ? [{ key: 'sprintQualifying' as const, label: '冲刺排位', forecast: props.weekend.forecast.qualifying }, { key: 'sprint' as const, label: '冲刺赛', forecast: props.weekend.forecast.race }] : []),
  { key: 'qualifying' as const, label: '排位赛', forecast: props.weekend.forecast.qualifying },
  { key: 'race' as const, label: '正赛', forecast: props.weekend.forecast.race },
]);
const windowStyle = computed(() => intervalStyle(props.weekend.forecast.raceRainWindow ?? null, 1, props.raceLaps));
function status(weather: string | null) { return weather === 'wet' ? 'wet' : weather === 'dry' ? 'dry' : 'unknown'; }
function label(weather: string | null) { return weather === 'wet' ? '雨天实况' : weather === 'dry' ? '干地实况' : '天气尚未揭晓'; }
</script>

<template>
  <section class="weekend-weather card" aria-label="比赛周末天气预报"><div class="spread"><h3>周末天气</h3><span class="tiny muted">已揭晓为实况；未揭晓仅显示概率预报</span></div>
    <div class="session-tiles"><article v-for="session in sessions" :key="session.key" class="weather-tile"><WeatherGlyph :kind="status(weekend.weather[session.key])" :label="`${session.label}：${label(weekend.weather[session.key])}`" /><div><b>{{ session.label }}</b><span v-if="weekend.weather[session.key]" class="revealed">{{ label(weekend.weather[session.key]) }}</span><span v-else-if="session.forecast !== null" class="forecast-label">降雨概率 {{ percent(session.forecast) }}</span><span v-else class="muted">尚无概率预报</span></div></article></div>
    <figure class="weekend-arrival"><figcaption>正赛可能降雨到达窗口 · 不代表降雨持续时间</figcaption><div class="arrival-axis" aria-hidden="true"><i v-if="windowStyle" class="arrival-band" :style="windowStyle" /><span v-else>暂无明确降雨窗口</span></div><div class="axis-ticks"><span>第 1 圈</span><span>第 {{ raceLaps }} 圈</span></div></figure>
  </section>
</template>

<style scoped>
.weekend-weather { display:grid; gap:10px; }.weekend-weather h3 { margin:0; }.session-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(128px,1fr)); gap:7px; }.weather-tile { min-width:0; display:flex; align-items:center; gap:7px; padding:8px; background:var(--bg); border:1px solid var(--line); }.weather-tile b,.weather-tile span { display:block; }.weather-tile span { font-size:11px; }.revealed { color:var(--green); }.forecast-label { color:var(--cyan); }.weekend-arrival { margin:0; }.weekend-arrival figcaption { color:var(--muted); font-size:11px; }.arrival-axis { position:relative; display:grid; place-items:center; height:24px; margin-top:5px; overflow:hidden; border:1px solid var(--line2); color:var(--muted); font-size:10px; background:repeating-linear-gradient(90deg,#11151d 0 calc(20% - 1px),#293040 calc(20% - 1px) 20%); }.arrival-band { position:absolute; top:2px; bottom:2px; min-width:3px; background:repeating-linear-gradient(135deg,#7fdcff 0 4px,#315367 4px 8px); border-left:1px solid #fff; border-right:1px solid #fff; }.axis-ticks { display:flex; justify-content:space-between; font-size:10px; color:var(--muted); }
</style>
