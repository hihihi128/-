<script setup lang="ts">
import { computed } from 'vue';
import { boundedPercent, intensitySegments, validRange } from '../weatherPresentation';

type Props = { mode: 'observed'; value: number } | { mode: 'forecast'; range: [number, number]; horizonLaps: number; issuedLap: number };
// Vue's runtime prop validator cannot discriminate a union, so optional runtime
// fields retain the explicit public union above without false missing-prop warnings.
const props = defineProps<{ mode: Props['mode']; value?: number; range?: [number, number]; horizonLaps?: number; issuedLap?: number }>();
const observed = computed(() => props.mode === 'observed' ? intensitySegments(props.value ?? Number.NaN) : []);
const range = computed(() => props.mode === 'forecast' && props.range ? validRange(props.range) : null);
const observedValue = computed(() => props.mode === 'observed' ? boundedPercent(props.value ?? Number.NaN) : null);
const observedText = computed(() => observedValue.value === null ? '暂不可用' : observedValue.value === 0 ? '无降雨' : `${Math.round(observedValue.value)}%`);
const rangeText = computed(() => range.value ? `${range.value[0]}–${range.value[1]}%` : '暂不可用');
</script>

<template>
  <section v-if="mode === 'observed'" class="rain-gauge observed" role="meter" aria-labelledby="observed-intensity-title" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="observedValue ?? undefined" :aria-valuetext="`当前降雨强度实测：${observedText}`">
    <div class="gauge-head"><div><div id="observed-intensity-title" class="tiny muted">当前降雨强度 · 实测</div><b class="gauge-value">{{ observedText }}</b></div><span class="gauge-kind">实况</span></div>
    <div class="gauge-track" aria-hidden="true"><i v-for="(fill, index) in observed" :key="index" class="level-segment"><i :style="{ transform: `scaleX(${fill})` }" /></i></div>
    <div class="gauge-ticks" aria-hidden="true"><span>0 · 低</span><span>50</span><span>100 · 高</span></div>
  </section>
  <figure v-else class="rain-gauge forecast" :aria-label="`预报降雨强度范围：${rangeText}，未来 ${horizonLaps ?? 0} 圈，第 ${issuedLap ?? 0} 圈发布；这是不确定的范围而非当前读数。`">
    <figcaption class="gauge-head"><div><div class="tiny muted">预报降雨强度范围 · 未来 {{ horizonLaps ?? 0 }} 圈</div><b class="gauge-value">{{ rangeText }}</b></div><span class="gauge-kind">范围预报</span></figcaption>
    <div v-if="range" class="range-track" aria-hidden="true"><i class="range-band" :style="{ left: `${range[0]}%`, width: `${range[1] - range[0]}%` }" /><i class="endpoint low" :style="{ left: `${range[0]}%` }" /><i class="endpoint high" :style="{ left: `${range[1]}%` }" /></div>
    <div v-else class="range-track unavailable" aria-hidden="true">暂无有效强度范围</div>
    <div class="gauge-ticks" aria-hidden="true"><span>0 · 低</span><span>50</span><span>100 · 高</span></div>
  </figure>
</template>

<style scoped>
.rain-gauge { margin:0; padding:10px; border:1px solid var(--line2); background:var(--bg); }.gauge-head { display:flex; align-items:start; justify-content:space-between; gap:8px; }.gauge-value { display:block; font:700 25px/1 var(--font-num); margin-top:3px; }.gauge-kind { border:1px solid var(--line2); padding:2px 6px; color:var(--cyan); font-size:10px; }.gauge-track,.range-track { position:relative; display:flex; height:19px; margin-top:12px; overflow:hidden; border:1px solid #4a5262; background:#11151c; }.level-segment { position:relative; flex:1; border-right:2px solid var(--bg); }.level-segment:last-child { border:0; }.level-segment > i { position:absolute; inset:0; transform-origin:left; background:linear-gradient(90deg,var(--blue),var(--cyan)); }.gauge-ticks { display:flex; justify-content:space-between; margin-top:3px; font-size:10px; color:var(--muted); }.range-band { position:absolute; top:0; bottom:0; min-width:2px; background:repeating-linear-gradient(135deg,#7fdcff 0 4px,#28526a 4px 8px); }.endpoint { position:absolute; top:-2px; bottom:-2px; width:3px; background:#fff; box-shadow:0 0 0 1px #000; }.range-track.unavailable { display:grid; place-items:center; color:var(--muted); font-size:11px; }.forecast .gauge-kind { color:var(--yellow); border-color:#725f19; }
</style>
