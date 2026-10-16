<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue';
import { act, call, store } from '../bridge';
import Tyre from './Tyre.vue';
import RaceWeatherForecast from './RaceWeatherForecast.vue';
import type { EnergyMode, PaceMode, PitTiming, TeamOrders } from '../../../engine/types';

const v = computed(() => store.view!);
const live = computed(() => v.value.weekend?.liveRace ?? null);
const carById = computed(() => new Map(live.value?.playerCars.map(car => [car.driverId, car]) ?? []));
const drivers = computed(() => v.value.drivers.filter(d => carById.value.has(d.id)));
const names = computed(() => new Map(v.value.drivers.map(d => [d.id, d.name])));
const shortNames = computed(() => new Map(v.value.drivers.map(d => [d.id, d.short])));
const selections = reactive<Record<string, { pit: 'auto' | 'stay_out' | 'box'; compound: string; startCompound?: string; repairWing: boolean; paceMode: PaceMode; energyMode: EnergyMode; pitTiming: PitTiming }>>({});
const orders = reactive<TeamOrders>({ mode: 'free', favorDriverId: null });
const activeWindowId = computed(() => live.value?.pendingDecision?.id ?? '');
const importantPause = computed(() => !!live.value?.pendingDecision);
const gridTyreOptions = computed(() => live.value?.pendingDecision?.startTyreOptions ?? null);
const gridTyreChoice = computed(() => !!gridTyreOptions.value);
const wetGrid = computed(() => !!gridTyreOptions.value?.length && gridTyreOptions.value.every(compound => v.value.labels.tyres[compound]?.wet));
const gridEligible = computed(() => new Set(live.value?.pendingDecision?.eligibleDriverIds ?? []));
const missingGridChoices = computed(() => drivers.value.filter(d => gridEligible.value.has(d.id) && !selections[d.id]?.startCompound).map(d => driverShort(d.id)));
const canConfirmGrid = computed(() => gridTyreChoice.value && !missingGridChoices.value.length && !store.busy);
const autoRunning = ref(true);
const pauseRequested = ref(false);
const lapDelay = ref(1000);
let lapTimer: ReturnType<typeof setTimeout> | undefined;
const tyrePickerDriverId = ref('');
const tyrePickerDialog = ref<HTMLElement | null>(null);
let tyrePickerTrigger: HTMLElement | null = null;
function resetDrafts() {
  tyrePickerDriverId.value = '';
  for (const id of Object.keys(selections)) delete selections[id];
  Object.assign(orders, live.value?.teamOrders ?? { mode: 'free', favorDriverId: null });
}
watch(activeWindowId, resetDrafts, { immediate: true });

function choice(id: string) {
  const current = carById.value.get(id);
  const currentStartCompound = current?.tyre && gridTyreOptions.value?.includes(current.tyre) ? current.tyre : undefined;
  if (!selections[id]) selections[id] = { pit: 'auto', compound: current?.tyre ?? v.value.rules.dryCompounds[0] ?? v.value.rules.wetCompound, startCompound: gridTyreChoice.value ? currentStartCompound : undefined, repairWing: false, paceMode: (current?.paceMode ?? 'balanced') as PaceMode, energyMode: (current?.energyMode ?? 'balanced') as EnergyMode, pitTiming: (current?.pitTiming ?? 'standard') as PitTiming };
  return selections[id];
}
function weatherLabel() {
  if (!live.value) return '';
  const rain = Math.round(live.value.weather.rain * 100);
  return `${rain ? `降雨强度 ${rain}%` : '无降雨'} · ${live.value.weather.surface === 'dry' ? '干地' : live.value.weather.surface === 'damp' ? '潮湿' : '湿地'}`;
}
function reasonLabel(reason: string) { return ({ grid: '发车', manual_pause: '领队暂停', pit_opportunity: '进站机会', weather_change: '天气变化', sc: '安全车', vsc: '虚拟安全车', red_flag: '红旗暂停', incident: '事故与损伤' } as Record<string, string>)[reason] ?? reason; }
function driverName(id: string) { return names.value.get(id) ?? id; }
function driverShort(id: string) { return shortNames.value.get(id) ?? driverName(id); }
function isEligible(id: string) { return !!live.value?.pendingDecision?.eligibleDriverIds.includes(id); }
function tyreOptions() { return Object.keys(v.value.labels.tyres); }
function openTyrePicker(driverId: string, event: MouseEvent) {
  tyrePickerTrigger = event.currentTarget as HTMLElement;
  tyrePickerDriverId.value = driverId;
  void nextTick(() => tyrePickerDialog.value?.focus());
}
function closeTyrePicker() {
  tyrePickerDriverId.value = '';
  void nextTick(() => tyrePickerTrigger?.focus());
}
function selectRedFlagTyre(compound: string) {
  const driverId = tyrePickerDriverId.value;
  if (!driverId || !isEligible(driverId) || !live.value?.pendingDecision?.reasons.includes('red_flag')) { closeTyrePicker(); return; }
  const draft = choice(driverId);
  draft.pit = 'box';
  draft.compound = compound;
  closeTyrePicker();
}
async function start() { await act({ type: 'START_RACE', kind: v.value.season.phase === 'sprint' ? 'sprint' : 'race' }); }
async function advance(until: 'next_lap' | 'next_decision') {
  if (!live.value) return;
  const advanced = await act({ type: 'ADVANCE_RACE', sessionId: live.value.id, expectedRevision: live.value.revision, until }, { silent: true });
  if (!advanced) autoRunning.value = false;
}
function clearLapTimer() {
  if (lapTimer !== undefined) clearTimeout(lapTimer);
  lapTimer = undefined;
}
function scheduleNextLap() {
  clearLapTimer();
  if (!autoRunning.value || store.busy || !live.value || live.value.pendingDecision) return;
  lapTimer = setTimeout(() => { void advance('next_lap'); }, lapDelay.value);
}
async function commitPause() {
  pauseRequested.value = false;
  if (!live.value || live.value.pendingDecision) return;
  const paused = await act({ type: 'PAUSE_RACE', sessionId: live.value.id, expectedRevision: live.value.revision });
  if (!paused) autoRunning.value = true;
}
function pause() {
  autoRunning.value = false;
  clearLapTimer();
  if (store.busy) pauseRequested.value = true;
  else void commitPause();
}
function resume() { pauseRequested.value = false; autoRunning.value = true; }
watch(() => store.busy, busy => { if (!busy && pauseRequested.value) void commitPause(); });
watch(() => [live.value?.id, live.value?.revision, live.value?.pendingDecision?.id, store.busy, autoRunning.value, lapDelay.value], scheduleNextLap, { immediate: true });
onUnmounted(clearLapTimer);
async function tactics() {
  if (!live.value) return;
  await act({ type: 'SET_RACE_TACTICS', sessionId: live.value.id, expectedRevision: live.value.revision, drivers: drivers.value.filter(d => live.value?.timing.find(t => t.driverId === d.id)?.status === 'running').map(d => ({ driverId: d.id, paceMode: choice(d.id).paceMode, energyMode: choice(d.id).energyMode, pitTiming: choice(d.id).pitTiming })), orders: { ...orders } });
}
async function resolve() {
  if (!live.value?.pendingDecision) return;
  // Retired cars remain in timing, but are never submitted to a decision window.
  const eligible = new Set(live.value.pendingDecision.eligibleDriverIds);
  const driversPayload = drivers.value.filter(d => eligible.has(d.id)).map(d => {
    const draft = choice(d.id);
    return gridTyreChoice.value
      ? { driverId: d.id, pit: 'auto' as const, startCompound: draft.startCompound!, paceMode: draft.paceMode, energyMode: draft.energyMode, pitTiming: draft.pitTiming }
      : { driverId: d.id, pit: draft.pit, ...(draft.pit === 'box' ? { compound: draft.compound } : {}), repairWing: draft.repairWing, paceMode: draft.paceMode, energyMode: draft.energyMode, pitTiming: draft.pitTiming };
  });
  autoRunning.value = true;
  await act({ type: 'RESOLVE_RACE_DECISION', sessionId: live.value.id, expectedRevision: live.value.revision, windowId: live.value.pendingDecision.id, drivers: driversPayload, orders: wetGrid.value ? undefined : { ...orders } });
}
async function narratePause() {
  if (!live.value || !importantPause.value) return;
  const focus = `当前重要暂停点（${live.value.pendingDecision?.reasons.map(reasonLabel).join('、') ?? '比赛事件'}）`;
  await call(api => api.requestNarration(`（请根据【实时比赛】数据自然叙述${focus}。只写已经发生的事和当前可见信息，不要替领队作出任何策略选择。本次不要输出 <F1M_UPDATE> 指令。）`));
}
</script>

<template>
  <section v-if="live" class="live stack" aria-label="实时比赛指挥">
    <div class="race-ribbon" :class="{ pause: !!live.pendingDecision, control: !!live.raceControl }">
      <div><div class="tiny muted">当前圈 / {{ live.totalLaps }}</div><b class="lap mono">{{ live.completedLaps }}</b></div>
      <div class="grow"><b>{{ live.pendingDecision ? '比赛已暂停，等待你的指令' : live.raceControl === 'red_flag' ? '红旗暂停' : live.restart ? `${live.restart === 'standing' ? '静态' : '滚动'}重启准备中` : live.raceControl === 'sc' ? '安全车部署中' : live.raceControl === 'vsc' ? '虚拟安全车部署中' : '比赛进行中' }}</b><div class="small muted">{{ weatherLabel() }}<span v-if="live.raceControl"> · {{ live.raceControl === 'red_flag' ? 'RED FLAG' : live.raceControl.toUpperCase() }}</span></div></div>
      <span v-if="live.pendingDecision" class="badge warn">{{ live.pendingDecision.reasons.map(reasonLabel).join(' · ') }}</span>
      <button v-if="importantPause" class="narrate-pause" :disabled="store.busy || !!store.status?.generating" @click="narratePause">让 AI 叙述当前暂停</button>
      <div v-if="!importantPause" class="race-actions"><label class="speed tiny">时间轴速度<select v-model.number="lapDelay" :disabled="store.busy"><option :value="1800">慢速</option><option :value="1000">标准</option><option :value="450">快速</option></select></label><button v-if="pauseRequested" class="primary" disabled>正在暂停…</button><button v-else-if="autoRunning" class="primary" @click="pause">暂停比赛</button><button v-else class="primary" :disabled="store.busy" @click="resume">继续比赛</button></div>
    </div>
    <div class="lap-timeline" aria-label="正赛时间轴"><i :style="{ width: `${live.completedLaps / live.totalLaps * 100}%` }"></i><span>L1</span><b>第 {{ live.completedLaps }} 圈</b><span>L{{ live.totalLaps }}</span></div>

    <div class="live-grid">
      <div class="stack">
        <div class="cars-grid">
          <article v-for="d in drivers" :key="d.id" class="card driver-card">
            <div class="spread"><div><h3>{{ driverShort(d.id) }} <span class="small muted">{{ d.name }}</span></h3><div class="tiny muted">{{ live.timing.find(t => t.driverId === d.id)?.gap ?? '—' }}</div></div><b class="position">P{{ live.timing.find(t => t.driverId === d.id)?.pos ?? 'DNF' }}</b></div>
            <div v-for="car in [carById.get(d.id)!]" :key="d.id" class="telemetry">
              <div><span class="tiny muted">轮胎</span><b><Tyre :c="choice(d.id).startCompound ?? car.tyre" /> {{ car.tyreAge }} 圈 · {{ car.tyreState === 'new' ? '新胎' : '已用' }}</b></div>
              <div><span class="tiny muted">能量</span><b class="mono">{{ Math.round(car.energy) }}%</b><i class="energy"><i :style="{ width: `${car.energy}%` }"></i></i></div>
              <div><span class="tiny muted">动力单元</span><b :class="car.puStatus === 'protect' || car.puStatus === 'critical' ? 'neg' : car.puStatus === 'hot' ? 'warn' : 'pos'">{{ car.puStatus === 'critical' ? '临界降额' : car.puStatus === 'protect' ? '保护模式' : car.puStatus === 'hot' ? '温度偏高' : '正常' }} · {{ Math.round(car.puTemperature) }}°C</b><span class="tiny muted">最弱：{{ car.weakestPuName }} {{ Math.round(car.weakestPuHealth) }}% · ICE 平均 {{ Math.round(car.iceHealth) }}% · 电气平均 {{ Math.round(car.electricalHealth) }}%</span></div>
              <div><span class="tiny muted">进站静止</span><b class="mono">预计 {{ car.predictedStationary.toFixed(1) }}s<span v-if="car.lastPit"> · 实际 {{ car.lastPit.actualStationary.toFixed(1) }}s</span></b></div>
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
        <section class="card weather"><RaceWeatherForecast :rain="live.weather.rain" :surface="live.weather.surface" :forecast="live.weather.forecast" :completed-laps="live.completedLaps" :total-laps="live.totalLaps" /></section>
        <section v-if="live.pendingDecision" class="card decision"><h3>{{ live.pendingDecision.reasons.map(reasonLabel).join(' / ') }}决策</h3><p class="small muted">{{ gridTyreChoice ? wetGrid ? '湿地发车由你选择两车的半雨胎或全雨胎。' : '选择两车起步胎；保持当前配方不会改变原定进站策略。' : live.pendingDecision.reasons.includes('red_flag') ? '红旗暂停期间换胎不计进站时间或进站次数；两车一起确认。' : `预计进站损失约 ${live.pendingDecision.expectedPitLoss.toFixed(1)} 秒；两车一起确认。` }}</p>
          <template v-if="gridTyreChoice">
            <p class="grid-intro">{{ wetGrid ? '湿地发车只能选择半雨胎或全雨胎。' : '干地发车也可以主动选择半雨胎或全雨胎。' }}此为初始装备，不会产生进站时间或进站次数；其他车队由 AI 自动决定。</p>
            <fieldset v-for="d in drivers.filter(driver => gridEligible.has(driver.id))" :key="d.id" class="grid-tyre-choice" :disabled="store.busy">
              <legend>{{ driverShort(d.id) }} <span class="muted">{{ d.name }}</span> · 起步轮胎</legend>
              <label v-for="compound in gridTyreOptions" :key="compound" class="tyre-radio" :class="{ selected: choice(d.id).startCompound === compound }">
                <input v-model="choice(d.id).startCompound" type="radio" :name="`grid-tyre-${d.id}`" :value="compound" />
                <Tyre :c="compound" /><span>{{ v.labels.tyres[compound]?.name ?? compound }}</span><b>{{ choice(d.id).startCompound === compound ? '已选择' : '选择' }}</b>
              </label>
            </fieldset>
            <p v-if="missingGridChoices.length" class="missing-choice">仍需选择：{{ missingGridChoices.join('、') }} 的起步轮胎。</p>
            <template v-if="!wetGrid">
              <label class="field">车队指令<select v-model="orders.mode"><option value="free">自由比赛</option><option value="hold">保持位置</option><option value="favor">偏向车手</option></select></label>
              <label v-if="orders.mode === 'favor'" class="field">优先车手<select v-model="orders.favorDriverId"><option v-for="d in drivers" :key="d.id" :value="d.id">{{ d.name }}</option></select></label>
            </template>
            <button class="primary confirm" :disabled="!canConfirmGrid" @click="resolve">确认两车起步轮胎并准备发车</button>
          </template>
          <template v-else>
          <div v-for="d in drivers" :key="d.id" class="decision-driver" :class="{ muted: !isEligible(d.id) }">
            <b>{{ driverShort(d.id) }}</b>
            <template v-if="isEligible(d.id)">
              <div v-if="live.pendingDecision.reasons.includes('red_flag')" class="red-flag-options">
                <div class="seg">
                  <button :class="{ on: choice(d.id).pit === 'auto' }" @click="choice(d.id).pit = 'auto'">保留{{ v.labels.tyres[carById.get(d.id)?.tyre ?? '']?.name ?? carById.get(d.id)?.tyre }}</button>
                  <button :class="{ on: choice(d.id).pit === 'box' }" @click="openTyrePicker(d.id, $event)">{{ choice(d.id).pit === 'box' ? `更换为${v.labels.tyres[choice(d.id).compound]?.name ?? choice(d.id).compound}` : '免费换胎…' }}</button>
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
          <label class="field">车队指令<select v-model="orders.mode"><option value="free">自由比赛</option><option value="hold">保持位置</option><option value="favor">偏向车手</option></select></label><label v-if="orders.mode === 'favor'" class="field">优先车手<select v-model="orders.favorDriverId"><option v-for="d in drivers" :key="d.id" :value="d.id">{{ d.name }}</option></select></label><button class="primary confirm sticky-ready" :disabled="store.busy" @click="resolve">确认指令并继续比赛</button>
          </template>
        </section>
        <section v-else class="card"><h3>实时策略</h3><p class="small muted">正赛沿时间轴逐圈运行。节奏、能量与进站时机会在下一圈生效。</p><button :disabled="store.busy" @click="tactics">应用两车策略</button></section>
      </aside>
    </div>
    <Teleport to="body">
      <div v-if="tyrePickerDriverId" class="tyre-modal-backdrop" role="presentation" @click.self="closeTyrePicker">
        <section ref="tyrePickerDialog" class="tyre-modal" role="dialog" aria-modal="true" aria-label="选择红旗重启轮胎" tabindex="-1" @keydown.esc.stop.prevent="closeTyrePicker">
          <div class="spread"><div><div class="tiny muted">红旗免费换胎</div><h3>选择 {{ driverShort(tyrePickerDriverId) }} 的重启轮胎</h3><div class="tiny muted">当前 {{ v.labels.tyres[carById.get(tyrePickerDriverId)?.tyre ?? '']?.name ?? carById.get(tyrePickerDriverId)?.tyre }} · 已使用 {{ carById.get(tyrePickerDriverId)?.tyreAge ?? 0 }} 圈</div></div><button aria-label="关闭" @click="closeTyrePicker">×</button></div>
          <div class="tyre-modal-grid">
            <button v-for="compound in tyreOptions()" :key="compound" :class="{ on: choice(tyrePickerDriverId).pit === 'box' && choice(tyrePickerDriverId).compound === compound }" @click="selectRedFlagTyre(compound)"><Tyre :c="compound" /> <b>{{ v.labels.tyres[compound]?.name ?? compound }}</b><span v-if="compound === carById.get(tyrePickerDriverId)?.tyre" class="tiny">新胎</span></button>
          </div>
          <button class="ghost" @click="closeTyrePicker">取消</button>
        </section>
      </div>
    </Teleport>
  </section>
  <section v-else class="card start-race"><h3>实时正赛</h3><p class="small muted">互动比赛允许你在发车前选择两车起步胎；湿地发车仅可选择雨胎。发车后引擎会在关键事件暂停。</p><button class="primary" :disabled="store.busy" @click="start">开始实时{{ v.season.phase === 'sprint' ? '冲刺赛' : '正赛' }}</button></section>
</template>

<style scoped>
.race-ribbon { display:flex; align-items:center; gap:12px; padding:11px 14px; border:1px solid var(--line); border-left:4px solid var(--green); background:var(--bg2); }.race-ribbon.pause { border-left-color:var(--yellow); }.race-ribbon.control { border-left-color:var(--orange); }.narrate-pause { margin-left:auto; white-space:nowrap; }.lap { display:block; font-size:28px; line-height:1; }.speed { display:flex; align-items:center; gap:6px; }.speed select { min-width:72px; }.lap-timeline { position:relative; display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:10px; min-height:30px; padding:0 8px; overflow:hidden; border:1px solid var(--line); background:var(--bg); }.lap-timeline::before,.lap-timeline i { position:absolute; left:0; top:0; bottom:0; content:""; }.lap-timeline::before { right:0; background:linear-gradient(90deg,transparent 49%,var(--line) 50%,transparent 51%); background-size:4% 100%; opacity:.28; }.lap-timeline i { max-width:100%; background:color-mix(in srgb,var(--green) 24%,transparent); transition:width .3s ease; }.lap-timeline span,.lap-timeline b { position:relative; z-index:1; }.lap-timeline b { text-align:center; }.live-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(290px,.52fr); gap:12px; }.cars-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }.position { font-size:23px; font-style:italic; }.telemetry { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:10px 0; }.telemetry span,.telemetry b { display:block; }.energy { display:block; height:4px; background:var(--bg4); margin-top:4px; }.energy i { display:block; height:100%; background:var(--cyan); }.tactic-fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; }.tactic-fields select { width:100%; }.events { max-height:170px; overflow:auto; margin-top:8px; }.events div { padding:4px 0; border-bottom:1px solid var(--line); font-size:12px; }.decision-driver { display:grid; gap:7px; padding:10px 0; border-bottom:1px solid var(--line); }.decision-driver .seg { width:max-content; }.red-flag-options { display:grid; gap:5px; }.repair-choice { display:flex; align-items:center; gap:7px; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--bg); font-size:12px; }.decision .field { margin-top:10px; }.decision .field select { width:100%; }.grid-intro { margin:8px 0; padding:8px; border-left:3px solid var(--cyan); background:var(--bg); font-size:12px; }.grid-tyre-choice { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin:10px 0; padding:9px; border:1px solid var(--line2); }.grid-tyre-choice legend { padding:0 4px; font-weight:700; }.tyre-radio { display:flex; align-items:center; gap:7px; min-height:44px; padding:7px; border:1px solid var(--line); background:var(--bg); cursor:pointer; }.tyre-radio:focus-within { outline:2px solid var(--cyan); outline-offset:2px; }.tyre-radio.selected { border-color:var(--cyan); background:color-mix(in srgb,var(--cyan) 12%,var(--bg)); }.tyre-radio input { accent-color:var(--cyan); }.tyre-radio b { margin-left:auto; font-size:10px; color:var(--cyan); }.missing-choice { margin:8px 0 0; color:var(--yellow); font-size:12px; }.confirm { width:100%; margin-top:12px; min-height:44px; }.start-race { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }.start-race h3 { width:100%; }.tyre-modal-backdrop { position:fixed; inset:0; z-index:1000; display:grid; place-items:center; padding:18px; background:#05070dcc; backdrop-filter:blur(5px); }.tyre-modal { width:min(440px,100%); display:grid; gap:14px; padding:18px; border:1px solid var(--line); border-radius:14px; background:var(--bg2); box-shadow:0 24px 70px #000b; }.tyre-modal h3 { margin:3px 0 0; }.tyre-modal-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }.tyre-modal-grid button { display:flex; justify-content:center; align-items:center; gap:8px; min-height:48px; }.tyre-modal-grid button.on { border-color:var(--team); background:color-mix(in srgb,var(--team) 18%,var(--bg)); }
@media (max-width:640px) { .live,.live-grid,.live-grid > *,.cars-grid,.driver-card,.weather,.decision { min-width:0; }.live { overflow-x:clip; }.live-grid,.cars-grid,.grid-tyre-choice { grid-template-columns:1fr; }.live-grid > aside { display:contents; }.live-grid > aside .weather { order:-2; }.live-grid > aside .decision { order:-1; padding-bottom:calc(var(--tabbar-h) + 96px); }.race-ribbon { position:sticky; top:0; z-index:5; display:grid; grid-template-columns:auto minmax(0,1fr); align-items:start; }.race-ribbon > .grow { min-width:0; }.narrate-pause { grid-column:1/-1; width:100%; margin-left:0; }.race-actions { grid-column:1/-1; width:100%; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }.race-actions button,.tyre-radio span { min-width:0; }.tyre-radio span { overflow-wrap:anywhere; }.tactic-fields { grid-template-columns:1fr 1fr 1fr; }.telemetry { grid-template-columns:repeat(3,minmax(0,1fr)); }.telemetry > div { min-width:0; overflow-wrap:anywhere; }.decision .confirm.sticky-ready { position:sticky; bottom:calc(var(--tabbar-h) + 8px); box-shadow:0 6px 18px #000; }.start-race { padding-bottom:calc(var(--tabbar-h) + 12px); }.start-race .primary { position:relative; z-index:2; } }
</style>
