<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { act, store } from '../bridge';
import Tyre from './Tyre.vue';
import type { EnergyMode, PaceMode, PitTiming, TeamOrders } from '../../../engine/types';

const v = computed(() => store.view!);
const live = computed(() => v.value.weekend?.liveRace ?? null);
const carById = computed(() => new Map(live.value?.playerCars.map(car => [car.driverId, car]) ?? []));
const drivers = computed(() => v.value.drivers.filter(d => carById.value.has(d.id)));
const names = computed(() => new Map(v.value.drivers.map(d => [d.id, d.name])));
const shortNames = computed(() => new Map(v.value.drivers.map(d => [d.id, d.short])));
const selections = reactive<Record<string, { pit: 'auto' | 'stay_out' | 'box'; compound: string; repairWing: boolean; paceMode: PaceMode; energyMode: EnergyMode; pitTiming: PitTiming }>>({});
const orders = reactive<TeamOrders>({ mode: 'free', favorDriverId: null });
const activeWindowId = computed(() => live.value?.pendingDecision?.id ?? '');
const tyrePickerDriverId = ref('');
function resetDrafts() {
  for (const id of Object.keys(selections)) delete selections[id];
  Object.assign(orders, live.value?.teamOrders ?? { mode: 'free', favorDriverId: null });
}
watch(activeWindowId, resetDrafts, { immediate: true });

function choice(id: string) {
  const current = carById.value.get(id);
  if (!selections[id]) selections[id] = { pit: 'auto', compound: current?.tyre ?? v.value.rules.dryCompounds[0] ?? v.value.rules.wetCompound, repairWing: false, paceMode: (current?.paceMode ?? 'balanced') as PaceMode, energyMode: (current?.energyMode ?? 'balanced') as EnergyMode, pitTiming: (current?.pitTiming ?? 'standard') as PitTiming };
  return selections[id];
}
function weatherLabel() {
  if (!live.value) return '';
  const rain = Math.round(live.value.weather.rain * 100);
  return `${rain ? `降雨 ${rain}%` : '无降雨'} · ${live.value.weather.surface === 'dry' ? '干地' : live.value.weather.surface === 'damp' ? '潮湿' : '湿地'}`;
}
function reasonLabel(reason: string) { return ({ grid: '发车', pit_opportunity: '进站机会', weather_change: '天气变化', sc: '安全车', vsc: '虚拟安全车', red_flag: '红旗暂停', incident: '事故与损伤' } as Record<string, string>)[reason] ?? reason; }
function driverName(id: string) { return names.value.get(id) ?? id; }
function driverShort(id: string) { return shortNames.value.get(id) ?? driverName(id); }
function isEligible(id: string) { return !!live.value?.pendingDecision?.eligibleDriverIds.includes(id); }
function tyreOptions() { return Object.keys(v.value.labels.tyres); }
function openTyrePicker(driverId: string) { tyrePickerDriverId.value = driverId; }
function closeTyrePicker() { tyrePickerDriverId.value = ''; }
function selectRedFlagTyre(compound: string) {
  const draft = choice(tyrePickerDriverId.value);
  draft.pit = 'box';
  draft.compound = compound;
  closeTyrePicker();
}
async function start() { await act({ type: 'START_RACE', kind: v.value.season.phase === 'sprint' ? 'sprint' : 'race' }); }
async function advance(until: 'next_lap' | 'next_decision') {
  if (!live.value) return;
  await act({ type: 'ADVANCE_RACE', sessionId: live.value.id, expectedRevision: live.value.revision, until });
}
async function tactics() {
  if (!live.value) return;
  await act({ type: 'SET_RACE_TACTICS', sessionId: live.value.id, expectedRevision: live.value.revision, drivers: drivers.value.filter(d => live.value?.timing.find(t => t.driverId === d.id)?.status === 'running').map(d => ({ driverId: d.id, paceMode: choice(d.id).paceMode, energyMode: choice(d.id).energyMode, pitTiming: choice(d.id).pitTiming })), orders: { ...orders } });
}
async function resolve() {
  if (!live.value?.pendingDecision) return;
  // Retired cars remain in timing, but are never submitted to a decision window.
  const eligible = new Set(live.value.pendingDecision.eligibleDriverIds);
  await act({ type: 'RESOLVE_RACE_DECISION', sessionId: live.value.id, expectedRevision: live.value.revision, windowId: live.value.pendingDecision.id, drivers: drivers.value.filter(d => eligible.has(d.id)).map(d => { const draft = choice(d.id); return { driverId: d.id, pit: draft.pit, ...(draft.pit === 'box' ? { compound: draft.compound } : {}), repairWing: draft.repairWing, paceMode: draft.paceMode, energyMode: draft.energyMode, pitTiming: draft.pitTiming }; }), orders: { ...orders } });
}
async function autoFinish() {
  if (!live.value) return;
  await act({ type: live.value.kind === 'sprint' ? 'RUN_SPRINT' : 'RUN_RACE' });
}
</script>

<template>
  <section v-if="live" class="live stack" aria-label="实时比赛指挥">
    <div class="race-ribbon" :class="{ pause: !!live.pendingDecision, control: !!live.raceControl }">
      <div><div class="tiny muted">当前圈 / {{ live.totalLaps }}</div><b class="lap mono">{{ live.completedLaps }}</b></div>
      <div class="grow"><b>{{ live.pendingDecision ? '比赛已暂停，等待你的指令' : live.raceControl === 'red_flag' ? '红旗暂停' : live.restart ? `${live.restart === 'standing' ? '静态' : '滚动'}重启准备中` : live.raceControl === 'sc' ? '安全车部署中' : live.raceControl === 'vsc' ? '虚拟安全车部署中' : '比赛进行中' }}</b><div class="small muted">{{ weatherLabel() }}<span v-if="live.raceControl"> · {{ live.raceControl === 'red_flag' ? 'RED FLAG' : live.raceControl.toUpperCase() }}</span></div></div>
      <span v-if="live.pendingDecision" class="badge warn">{{ live.pendingDecision.reasons.map(reasonLabel).join(' · ') }}</span>
      <div v-else class="race-actions"><button class="primary" :disabled="store.busy" @click="advance('next_decision')">推进至下一窗口</button><button :disabled="store.busy" @click="autoFinish">自动完成比赛</button></div>
    </div>

    <div class="live-grid">
      <div class="stack">
        <div class="cars-grid">
          <article v-for="d in drivers" :key="d.id" class="card driver-card">
            <div class="spread"><div><h3>{{ driverShort(d.id) }} <span class="small muted">{{ d.name }}</span></h3><div class="tiny muted">{{ live.timing.find(t => t.driverId === d.id)?.gap ?? '—' }}</div></div><b class="position">P{{ live.timing.find(t => t.driverId === d.id)?.pos ?? 'DNF' }}</b></div>
            <div v-for="car in [carById.get(d.id)!]" :key="d.id" class="telemetry">
              <div><span class="tiny muted">轮胎</span><b><Tyre :c="car.tyre" /> {{ car.tyreAge }} 圈</b></div>
              <div><span class="tiny muted">能量</span><b class="mono">{{ Math.round(car.energy) }}%</b><i class="energy"><i :style="{ width: `${car.energy}%` }"></i></i></div>
              <div><span class="tiny muted">赛车状态</span><b :class="car.damage || car.partial ? 'neg' : 'pos'">{{ car.damage ? '前翼受损' : car.partial ? '机械异常' : '正常' }}</b></div>
            </div>
            <div class="tactic-fields">
              <label class="field">节奏<select v-model="choice(d.id).paceMode" :disabled="store.busy"><option value="conserve">保守</option><option value="balanced">均衡</option><option value="push">进攻</option></select></label>
              <label class="field">能量<select v-model="choice(d.id).energyMode" :disabled="store.busy"><option value="harvest">回收</option><option value="balanced">均衡</option><option value="deploy">释放</option></select></label>
              <label class="field">进站时机<select v-model="choice(d.id).pitTiming" :disabled="store.busy"><option value="early">提前</option><option value="standard">标准</option><option value="late">推迟</option></select></label>
            </div>
          </article>
        </div>
        <div class="card"><div class="spread"><h3>已发生事件</h3><span class="tiny muted">仅显示已发生信息</span></div><div class="events"><div v-for="event in [...live.events].reverse()" :key="event.id"><span class="mono muted">L{{ event.lap }}</span> {{ event.text }}</div><div v-if="!live.events.length" class="muted small">尚无公开事件。</div></div></div>
      </div>

      <aside class="stack">
        <section class="card weather"><h3>赛道与短期预报</h3><div class="weather-now">{{ weatherLabel() }}</div><div class="forecast"><span>未来 {{ live.weather.forecast.horizonLaps }} 圈<template v-if="live.weather.forecast.arrivalLaps"> · 约 {{ live.weather.forecast.arrivalLaps[0] }}–{{ live.weather.forecast.arrivalLaps[1] }} 圈后</template></span><b>{{ Math.round(live.weather.forecast.rainProbability * 100) }}% 降雨概率</b><span>强度 {{ Math.round(live.weather.forecast.intensityRange[0] * 100) }}–{{ Math.round(live.weather.forecast.intensityRange[1] * 100) }}% · {{ Math.round(live.weather.forecast.confidence * 100) }}% 置信度</span></div><p class="tiny muted">预报只覆盖短期并可能偏差，不代表未来真实天气。</p></section>
        <section v-if="live.pendingDecision" class="card decision"><h3>{{ live.pendingDecision.reasons.map(reasonLabel).join(' / ') }}决策</h3><p class="small muted">{{ live.pendingDecision.reasons.includes('red_flag') ? '红旗暂停期间换胎不计进站时间或进站次数；两车一起确认。' : `预计进站损失约 ${live.pendingDecision.expectedPitLoss.toFixed(1)} 秒；两车一起确认。` }}</p>
          <div v-for="d in drivers" :key="d.id" class="decision-driver" :class="{ muted: !isEligible(d.id) }">
            <b>{{ driverShort(d.id) }}</b>
            <template v-if="isEligible(d.id)">
              <div v-if="live.pendingDecision.reasons.includes('red_flag')" class="red-flag-options">
                <div class="seg">
                  <button :class="{ on: choice(d.id).pit === 'auto' }" @click="choice(d.id).pit = 'auto'">保留轮胎</button>
                  <button :class="{ on: choice(d.id).pit === 'box' }" @click="openTyrePicker(d.id)">{{ choice(d.id).pit === 'box' ? `更换为${v.labels.tyres[choice(d.id).compound]?.name ?? choice(d.id).compound}` : '免费换胎…' }}</button>
                </div>
              </div>
              <template v-else>
                <div class="seg"><button :class="{ on: choice(d.id).pit === 'auto' }" @click="choice(d.id).pit = 'auto'">自动</button><button :class="{ on: choice(d.id).pit === 'stay_out' }" @click="choice(d.id).pit = 'stay_out'">留在赛道</button><button :class="{ on: choice(d.id).pit === 'box' }" @click="choice(d.id).pit = 'box'">进站</button></div>
                <label v-if="choice(d.id).pit === 'box'" class="field">轮胎<select v-model="choice(d.id).compound"><option v-for="compound in tyreOptions()" :key="compound" :value="compound">{{ v.labels.tyres[compound]?.name ?? compound }}</option></select></label>
              </template>
              <label v-if="carById.get(d.id)?.damage" class="repair-choice"><input v-model="choice(d.id).repairWing" type="checkbox" /> {{ live.pendingDecision.reasons.includes('red_flag') ? '红旗下免费更换前翼' : '同时维修前翼' }}</label>
            </template>
            <span v-else class="tiny">此窗口无需该车操作</span>
          </div>
          <label class="field">车队指令<select v-model="orders.mode"><option value="free">自由比赛</option><option value="hold">保持位置</option><option value="favor">偏向车手</option></select></label><label v-if="orders.mode === 'favor'" class="field">优先车手<select v-model="orders.favorDriverId"><option v-for="d in drivers" :key="d.id" :value="d.id">{{ d.name }}</option></select></label><button class="primary confirm" :disabled="store.busy" @click="resolve">确认指令并继续比赛</button></section>
        <section v-else class="card"><h3>实时策略</h3><p class="small muted">节奏、能量与进站时机会在下一圈生效；比赛可逐圈推进或交给下一决策窗口。</p><button :disabled="store.busy" @click="tactics">应用两车策略</button><button :disabled="store.busy" @click="advance('next_lap')">推进一圈</button></section>
      </aside>
    </div>
    <Teleport to="body">
      <div v-if="tyrePickerDriverId" class="tyre-modal-backdrop" role="presentation" @click.self="closeTyrePicker">
        <section class="tyre-modal" role="dialog" aria-modal="true" aria-label="选择红旗重启轮胎">
          <div class="spread"><div><div class="tiny muted">红旗免费换胎</div><h3>选择 {{ driverShort(tyrePickerDriverId) }} 的重启轮胎</h3></div><button aria-label="关闭" @click="closeTyrePicker">×</button></div>
          <div class="tyre-modal-grid">
            <button v-for="compound in tyreOptions()" :key="compound" :class="{ on: choice(tyrePickerDriverId).compound === compound }" @click="selectRedFlagTyre(compound)"><Tyre :c="compound" /> <b>{{ v.labels.tyres[compound]?.name ?? compound }}</b></button>
          </div>
          <button class="ghost" @click="closeTyrePicker">取消</button>
        </section>
      </div>
    </Teleport>
  </section>
  <section v-else class="card start-race"><h3>实时正赛</h3><p class="small muted">发车后引擎会在关键事件暂停。自动完成仍可从上方“推进”操作继续。</p><button class="primary" :disabled="store.busy" @click="start">开始实时{{ v.season.phase === 'sprint' ? '冲刺赛' : '正赛' }}</button></section>
</template>

<style scoped>
.race-ribbon { display:flex; align-items:center; gap:12px; padding:11px 14px; border:1px solid var(--line); border-left:4px solid var(--green); background:var(--bg2); }.race-ribbon.pause { border-left-color:var(--yellow); }.race-ribbon.control { border-left-color:var(--orange); }.lap { display:block; font-size:28px; line-height:1; }.live-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(290px,.52fr); gap:12px; }.cars-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }.position { font-size:23px; font-style:italic; }.telemetry { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:10px 0; }.telemetry span,.telemetry b { display:block; }.energy { display:block; height:4px; background:var(--bg4); margin-top:4px; }.energy i { display:block; height:100%; background:var(--cyan); }.tactic-fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; }.tactic-fields select { width:100%; }.events { max-height:170px; overflow:auto; margin-top:8px; }.events div { padding:4px 0; border-bottom:1px solid var(--line); font-size:12px; }.weather-now { margin:8px 0; font-weight:700; }.forecast { display:grid; gap:3px; border:1px solid var(--line); padding:9px; background:var(--bg); font-size:12px; }.forecast b { color:var(--cyan); }.decision-driver { display:grid; gap:7px; padding:10px 0; border-bottom:1px solid var(--line); }.decision-driver .seg { width:max-content; }.red-flag-options { display:grid; gap:5px; }.repair-choice { display:flex; align-items:center; gap:7px; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--bg); font-size:12px; }.decision .field { margin-top:10px; }.decision .field select { width:100%; }.confirm { width:100%; margin-top:12px; }.start-race { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }.start-race h3 { width:100%; }.tyre-modal-backdrop { position:fixed; inset:0; z-index:1000; display:grid; place-items:center; padding:18px; background:#05070dcc; backdrop-filter:blur(5px); }.tyre-modal { width:min(440px,100%); display:grid; gap:14px; padding:18px; border:1px solid var(--line); border-radius:14px; background:var(--bg2); box-shadow:0 24px 70px #000b; }.tyre-modal h3 { margin:3px 0 0; }.tyre-modal-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }.tyre-modal-grid button { display:flex; justify-content:center; align-items:center; gap:8px; min-height:48px; }.tyre-modal-grid button.on { border-color:var(--team); background:color-mix(in srgb,var(--team) 18%,var(--bg)); }
@media (max-width:640px) { .live-grid,.cars-grid { grid-template-columns:1fr; }.live-grid > aside { display:contents; }.live-grid > aside .decision { order:-1; }.race-ribbon { position:sticky; top:0; z-index:5; display:grid; grid-template-columns:auto minmax(0,1fr); align-items:start; }.race-ribbon > .grow { min-width:0; }.race-actions { grid-column:1/-1; width:100%; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }.race-actions button { min-width:0; }.tactic-fields { grid-template-columns:1fr 1fr 1fr; }.telemetry { grid-template-columns:repeat(3,minmax(0,1fr)); }.decision .confirm { position:sticky; bottom:calc(var(--tabbar-h) + 8px); box-shadow:0 6px 18px #000; } }
</style>
