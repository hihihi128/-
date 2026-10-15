<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { act, lapTime, store } from '../bridge';
import Tyre from './Tyre.vue';
import type { LiveQualifyingView } from '../../../engine/view';

const v = computed(() => store.view!);
const weekend = computed(() => v.value.weekend);
const phase = computed(() => v.value.season.phase as 'qualifying' | 'sprint_qualifying');
const live = computed<LiveQualifyingView | null>(() => weekend.value?.liveQualifying ?? null);
const playerDrivers = computed(() => weekend.value?.drivers ?? []);
const playerDriverById = computed(() => new Map(playerDrivers.value.map(driver => [driver.driverId, driver])));
const playerCars = computed(() => live.value?.cars.filter(car => car.player && live.value!.alive.includes(car.driverId)) ?? []);
const onTrackCars = computed(() => live.value?.cars.filter(car => ['out_lap', 'flying_lap', 'in_lap'].includes(car.phase)) ?? []);
const garageCars = computed(() => live.value?.cars.filter(car => car.phase === 'garage') ?? []);
const selectedDriverId = ref('');
const expandedTrackDrivers = ref<string[]>([]);
const selections = ref<Record<string, string>>({});
const mounted = ref(false);
const playbackArmed = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<boolean> | null = null;
let lastFrameAt = 0;

const segmentLabel = computed(() => {
  const session = live.value;
  const prefix = phase.value === 'sprint_qualifying' ? 'SQ' : 'Q';
  return !session || session.segmentCount === 1 ? prefix : `${prefix}${session.segmentIndex + 1}`;
});
const title = computed(() => phase.value === 'sprint_qualifying' ? '实时冲刺排位' : '实时排位指挥');
const remaining = computed(() => {
  const ticks = live.value?.remainingTicks ?? 0;
  const seconds = Math.floor(ticks / 10);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
});
const statusText = computed(() => {
  const session = live.value;
  if (!session) return '等待开始';
  if (!playerCars.value.length) return '本队车手已全部淘汰';
  if (session.paused) return session.stage === 'ready' ? '准备放车' : '已暂停';
  if (!playbackArmed.value) return '已中断，点击继续';
  if (session.stage === 'finishing') return '计时结束，完成当前圈';
  return '计时进行中';
});
const selectedCar = computed(() => live.value?.cars.find(car => car.driverId === selectedDriverId.value) ?? playerCars.value[0] ?? onTrackCars.value[0] ?? null);
const mobileTrackGroups = computed(() => {
  const groups: Array<{ key: string; progress: number; cars: LiveQualifyingView['cars'] }> = [];
  for (const car of [...onTrackCars.value].sort((a, b) => a.progress - b.progress)) {
    const current = groups.at(-1);
    if (!current || car.progress - current.cars[0].progress >= .18) groups.push({ key: car.driverId, progress: car.progress, cars: [car] });
    else {
      current.cars.push(car);
      current.key = current.cars.map(item => item.driverId).join(':');
      current.progress = current.cars.reduce((sum, item) => sum + item.progress, 0) / current.cars.length;
    }
  }
  return groups;
});
const openMobileTrackCars = computed(() => expandedTrackDrivers.value.map(driverId => onTrackCars.value.find(car => car.driverId === driverId)).filter((car): car is LiveQualifyingView['cars'][number] => !!car));

function tyreOptions(car: LiveQualifyingView['cars'][number]) {
  const driver = playerDriverById.value.get(car.driverId);
  return (driver?.tyreSets ?? []).filter(set => car.legalTyreSetIds.includes(set.id));
}
function selectionFor(car: LiveQualifyingView['cars'][number]) {
  const options = tyreOptions(car);
  const selected = selections.value[car.driverId];
  if (selected && options.some(option => option.id === selected)) return selected;
  return options[0]?.id ?? '';
}
function syncSelections() {
  const next: Record<string, string> = {};
  for (const car of playerCars.value) {
    const options = tyreOptions(car);
    const selected = selections.value[car.driverId];
    next[car.driverId] = selected && options.some(option => option.id === selected) ? selected : options[0]?.id ?? '';
  }
  selections.value = next;
  if (!selectedDriverId.value || ![...playerCars.value, ...onTrackCars.value].some(car => car.driverId === selectedDriverId.value)) {
    selectedDriverId.value = playerCars.value[0]?.driverId ?? onTrackCars.value[0]?.driverId ?? '';
  }
}
watch(() => `${live.value?.id ?? ''}:${live.value?.segmentIndex ?? -1}`, () => { syncSelections(); expandedTrackDrivers.value = []; }, { immediate: true });
watch(() => playerCars.value.map(car => `${car.driverId}:${car.legalTyreSetIds.join(',')}`).join('|'), syncSelections);

async function start() {
  await act({ type: 'START_QUALIFYING', kind: phase.value });
}
async function simulate() {
  await act({ type: 'SIMULATE_QUALIFYING', kind: phase.value });
}
async function setClock(paused: boolean, speed = live.value?.speed ?? 1) {
  const session = live.value;
  if (!session || store.busy) return false;
  playbackArmed.value = !paused;
  const accepted = await act({ type: 'SET_QUALIFYING_CLOCK', sessionId: session.id, expectedRevision: session.revision, paused, speed }, { silent: true });
  if (!accepted) playbackArmed.value = false;
  return accepted;
}
async function release(car: LiveQualifyingView['cars'][number]) {
  const tyreSetId = selectionFor(car);
  const session = live.value;
  if (!session || !tyreSetId || store.busy) return;
  selectedDriverId.value = car.driverId;
  await act({ type: 'RELEASE_QUALIFYING_CAR', sessionId: session.id, expectedRevision: session.revision, driverId: car.driverId, tyreSetId });
}

function clearPlayback() {
  if (timer) clearTimeout(timer);
  timer = null;
  lastFrameAt = 0;
}
function canPlay() {
  const session = live.value;
  return !!mounted.value && playbackArmed.value && !!session && !session.paused && !document.hidden && store.panelVisible && store.tab === 'weekend';
}
function schedulePlayback() {
  clearPlayback();
  if (!canPlay() || inFlight) return;
  lastFrameAt = performance.now();
  timer = setTimeout(playbackStep, 1000);
}
async function playbackStep() {
  timer = null;
  const session = live.value;
  if (!session || !canPlay() || inFlight) return;
  const now = performance.now();
  const elapsed = now - lastFrameAt;
  lastFrameAt = now;
  // A hidden or suspended panel must not fast-forward an unattended session.
  if (elapsed > 1500) {
    playbackArmed.value = false;
    await pauseAfterFlight();
    return;
  }
  const ticks = Math.min(80, Math.max(1, Math.floor((elapsed / 100) * session.speed)));
  const id = session.id;
  inFlight = act({ type: 'ADVANCE_QUALIFYING', sessionId: id, expectedRevision: session.revision, ticks }, { silent: true });
  const accepted = await inFlight;
  inFlight = null;
  if (!accepted || live.value?.id !== id || !canPlay()) {
    playbackArmed.value = false;
    await pauseAfterFlight();
    return;
  }
  schedulePlayback();
}
async function pauseAfterFlight(allowUnmounted = false) {
  clearPlayback();
  playbackArmed.value = false;
  const pending = inFlight;
  if (pending) await pending;
  if ((mounted.value || allowUnmounted) && live.value && !live.value.paused) await setClock(true);
}
function onVisibilityChange() {
  if (document.hidden) void pauseAfterFlight();
  else clearPlayback();
}

watch(
  () => `${live.value?.id ?? ''}:${live.value?.revision ?? -1}:${live.value?.paused ?? true}:${live.value?.stage ?? ''}:${store.tab}:${store.panelVisible}`,
  () => {
    if (!mounted.value) return;
    if (canPlay() && !timer && !inFlight) schedulePlayback();
    else if (!canPlay()) clearPlayback();
  },
);
onMounted(() => {
  mounted.value = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  // A restored running session never starts a browser timer by itself.
  if (live.value && !live.value.paused) void pauseAfterFlight();
});
watch(() => v.value.gameId, () => {
  playbackArmed.value = false;
  if (live.value && !live.value.paused) void pauseAfterFlight();
});
watch(() => [store.tab, store.panelVisible] as const, ([tab, visible]) => {
  if ((tab !== 'weekend' || !visible) && live.value && !live.value.paused) void pauseAfterFlight();
});
watch(() => ({ id: live.value?.id ?? '', revision: live.value?.revision ?? -1 }), (next, previous) => {
  if (next.id && next.id === previous.id && next.revision < previous.revision) {
    playbackArmed.value = false;
    if (live.value && !live.value.paused) void pauseAfterFlight();
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  void pauseAfterFlight(true);
  mounted.value = false;
  clearPlayback();
});

function phaseLabel(car: LiveQualifyingView['cars'][number]) {
  return ({ garage: '车库', pit_out: '驶出维修区', out_lap: '出场圈', flying_lap: '飞行圈', in_lap: '回场圈', pit_in: '驶入维修区', done: '本节完成' } as Record<string, string>)[car.phase] ?? car.phase;
}
function trafficLabel(car: LiveQualifyingView['cars'][number]) {
  if (car.trafficStatus === 'slower_ahead') return `慢车 ${car.trafficDriverShort ?? '前方赛车'} · S${car.sector}`;
  if (car.trafficStatus === 'yielding') return `让车中 · S${car.sector}`;
  return car.phase === 'flying_lap' ? `赛道畅通 · S${car.sector}` : phaseLabel(car);
}
function markerLane(driverId: string) {
  const lane = [...driverId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 3;
  return `lane-${lane}`;
}
function selectMarker(id: string) { selectedDriverId.value = id; }
function carStyle(car: LiveQualifyingView['cars'][number]) { return { left: `${Math.max(0, Math.min(100, car.progress * 100))}%`, '--team-color': car.teamColor }; }
function groupStyle(group: typeof mobileTrackGroups.value[number]) {
  const representative = group.cars.find(car => car.player) ?? group.cars[0];
  return { left: `${Math.max(0, Math.min(100, group.progress * 100))}%`, '--team-color': representative.teamColor };
}
function toggleTrackGroup(group: typeof mobileTrackGroups.value[number]) {
  if (group.cars.length === 1) {
    expandedTrackDrivers.value = [];
    selectMarker(group.cars[0].driverId);
  } else {
    const ids = group.cars.map(car => car.driverId);
    expandedTrackDrivers.value = expandedTrackDrivers.value.length === ids.length && ids.every(id => expandedTrackDrivers.value.includes(id)) ? [] : ids;
  }
}
function formatGap(progress: number) { return `${(Math.max(0, progress) * 100).toFixed(1)}% 圈`; }
</script>

<template>
  <section class="live-qualifying stack" aria-label="实时排位指挥">
    <section v-if="!live" class="card start-qualifying">
      <div>
        <div class="tiny muted">{{ phase === 'sprint_qualifying' ? '冲刺排位' : '排位赛' }}</div>
        <h3>{{ title }}</h3>
        <p class="small muted">选择实体轮胎后，分别放行两辆赛车。计时默认暂停，只有你恢复时钟后才会开始。</p>
      </div>
      <div class="row">
        <button :disabled="store.busy" @click="start">进入实时{{ phase === 'sprint_qualifying' ? '冲刺排位' : '排位' }}台</button>
        <button class="primary" :disabled="store.busy" @click="simulate">模拟{{ phase === 'sprint_qualifying' ? '冲刺排位赛' : '排位赛' }}</button>
      </div>
    </section>

    <template v-else>
      <section class="qualifying-ribbon" :class="{ paused: live.paused, finishing: live.stage === 'finishing' }">
        <div class="session-name"><span class="tiny muted">当前分段</span><b>{{ segmentLabel }}</b></div>
        <div class="clock mono" aria-label="剩余时间">{{ remaining }}</div>
        <div class="clock-copy"><b>{{ statusText }}</b><span class="tiny muted">{{ live.wet ? '雨地' : '干地' }} · {{ live.runAllowance }} 次出场上限</span></div>
        <div v-if="playerCars.length" class="clock-actions">
          <button class="pause" :disabled="store.busy" @click="setClock(!live.paused)">{{ live.paused || !playbackArmed ? (live.stage === 'finishing' ? '继续完成当前圈' : '开始 / 继续') : '暂停' }}</button>
          <div class="speed" aria-label="播放速度">
            <button v-for="speed in [1, 2, 4, 8]" :key="speed" :class="{ on: live.speed === speed }" :aria-pressed="live.speed === speed" :disabled="store.busy" @click="setClock(live.paused, speed as 1 | 2 | 4 | 8)">{{ speed }}×</button>
          </div>
        </div>
        <div v-else class="tiny muted">请使用顶部“结束排位赛”完成剩余分段</div>
      </section>

      <section class="card track-card">
        <div class="spread track-title"><div><h3>赛道位置</h3><span class="tiny muted">归一化圈距 · 仅赛道上的赛车显示在轴线上</span></div><span class="tiny muted">START → FINISH</span></div>
        <div class="progress-axis" aria-label="赛车赛道位置">
          <i class="axis-line"></i>
          <i v-for="(sector, index) in live.sectors.slice(0, -1)" :key="sector.endProgress" class="sector-boundary" :style="{ left: `${sector.endProgress * 100}%`}"><span>S{{ index + 1 }}/{{ index + 2 }}</span></i>
          <span class="endpoint start">起点</span><span class="endpoint finish">终点</span>
          <button
            v-for="car in onTrackCars"
            :key="car.driverId"
            class="track-marker desktop-marker"
            :class="[markerLane(car.driverId), { selected: selectedDriverId === car.driverId, mine: car.player, traffic: car.trafficStatus !== 'clear', resetting: car.progress < .05 && car.phase !== 'out_lap' }]"
            :style="carStyle(car)"
            :aria-label="`${car.driverShort}，${phaseLabel(car)}，${trafficLabel(car)}`"
            :aria-pressed="selectedDriverId === car.driverId"
            @click="selectMarker(car.driverId)"
            @focus="selectMarker(car.driverId)"
          ><span>{{ car.driverShort }}</span><em>{{ car.driverShort }}</em></button>
          <button
            v-for="group in mobileTrackGroups"
            :key="group.key"
            class="track-marker mobile-marker"
            :class="{ selected: group.cars.some(car => car.driverId === selectedDriverId), mine: group.cars.some(car => car.player), traffic: group.cars.some(car => car.trafficStatus !== 'clear'), cluster: group.cars.length > 1 }"
            :style="groupStyle(group)"
            :aria-label="group.cars.length === 1 ? `${group.cars[0].driverShort}，${phaseLabel(group.cars[0])}，${trafficLabel(group.cars[0])}` : `${group.cars.length} 辆赛车：${group.cars.map(car => car.driverShort).join('、')}，展开选择`"
            :aria-pressed="group.cars.length === 1 ? selectedDriverId === group.cars[0].driverId : undefined"
            :aria-expanded="group.cars.length > 1 ? group.cars.some(car => expandedTrackDrivers.includes(car.driverId)) : undefined"
            @click="toggleTrackGroup(group)"
            @focus="group.cars.length === 1 && selectMarker(group.cars[0].driverId)"
          >{{ group.cars.length === 1 ? group.cars[0].driverShort : `+${group.cars.length}` }}</button>
        </div>
        <div v-if="openMobileTrackCars.length" class="mobile-cluster-picker" role="group" aria-label="同位置赛车"><button v-for="car in openMobileTrackCars" :key="car.driverId" :class="{ selected: selectedDriverId === car.driverId, mine: car.player }" :style="{ '--team-color': car.teamColor }" :aria-pressed="selectedDriverId === car.driverId" @click="selectMarker(car.driverId)">{{ car.driverShort }}</button></div>
        <div v-if="selectedCar" class="selected-traffic" aria-live="polite">
          <b :style="{ color: selectedCar.teamColor }">{{ selectedCar.driverShort }}</b>
          <span>{{ trafficLabel(selectedCar) }}</span>
          <span v-if="selectedCar.trafficDriverShort">· 前方 {{ selectedCar.trafficDriverShort }}</span>
          <span v-if="selectedCar.trafficLoss">· 已损失 {{ selectedCar.trafficLoss.toFixed(1) }}s</span>
          <span v-if="['out_lap', 'flying_lap', 'in_lap'].includes(selectedCar.phase)">· 位置 {{ formatGap(selectedCar.progress) }}</span>
        </div>
        <div v-if="!onTrackCars.length" class="tiny muted empty-track">赛道暂时没有赛车；先选择实体轮胎并手动放车。</div>
      </section>

      <section class="player-cards">
        <article v-for="car in playerCars" :key="car.driverId" class="card driver-card" :class="{ selected: selectedDriverId === car.driverId, ontrack: car.phase !== 'garage' && car.phase !== 'done' }" @click="selectMarker(car.driverId)">
          <div class="driver-head"><div><span class="driver-dot" :style="{ background: car.teamColor }"></span><b>{{ car.driverShort }}</b> <span class="small muted">{{ car.driverName }}</span></div><span class="badge">{{ phaseLabel(car) }}</span></div>
          <div class="car-status"><span>{{ car.bestTime ? `最佳 ${lapTime(car.bestTime)}` : '尚无有效圈速' }}</span><span>第 {{ car.runCount + (car.activeSetId ? 1 : 0) }}/{{ car.runAllowance }} 次出场</span></div>
          <div v-if="car.phase === 'garage' && !car.releaseReason" class="release-fields">
            <label class="field">本次实体轮胎
              <select :value="selectionFor(car)" :disabled="store.busy || !car.canRelease" @change="selections[car.driverId] = ($event.target as HTMLSelectElement).value">
                <option v-for="set in tyreOptions(car)" :key="set.id" :value="set.id">{{ v.labels.tyres[set.compound]?.name ?? set.compound }} · {{ set.id }} · {{ set.state === 'new' ? '新胎' : `已用 ${set.laps} 圈` }}</option>
              </select>
            </label>
            <button class="primary release" :disabled="store.busy || !car.canRelease || !selectionFor(car)" @click.stop="release(car)">放车</button>
          </div>
          <div v-else class="run-status">
            <span v-if="car.activeCompound" class="row"><Tyre :c="car.activeCompound" /> {{ car.activeStartedNew ? '新胎' : '旧胎' }} · {{ phaseLabel(car) }}</span>
            <span>{{ trafficLabel(car) }}</span>
          </div>
          <div v-if="car.releaseReason" class="tiny release-reason">{{ car.releaseReason }}</div>
          <div v-if="car.completedRuns.length" class="completed-runs tiny muted">已完成：<span v-for="(run, index) in car.completedRuns" :key="`${run.setId}-${index}`"><Tyre :c="run.compound" /> {{ run.time ? lapTime(run.time) : run.note ?? '无有效圈' }}<template v-if="run.trafficLoss"> · 交通 +{{ run.trafficLoss.toFixed(1) }}s</template><template v-if="index < car.completedRuns.length - 1">　</template></span></div>
        </article>
      </section>

      <section v-if="garageCars.length" class="card garage-list">
        <div class="spread"><h3>车库</h3><span class="tiny muted">未出场赛车不会显示在起点位置</span></div>
        <div class="garage-items"><span v-for="car in garageCars" :key="car.driverId" :class="{ mine: car.player }"><i :style="{ background: car.teamColor }"></i>{{ car.driverShort }} <small>{{ car.player ? '等待你的放车' : '等待车队指令' }}</small></span></div>
      </section>

      <section class="card timing-card">
        <div class="spread"><h3>{{ segmentLabel }} 实时计时</h3><span class="tiny muted">已完成圈速与当前状态</span></div>
        <div class="timing-list">
          <div v-for="(car, index) in [...live.cars].sort((a, b) => (a.bestTime ?? 99999) - (b.bestTime ?? 99999) || a.driverShort.localeCompare(b.driverShort))" :key="car.driverId" :class="{ mine: car.player }"><span class="mono">{{ String(index + 1).padStart(2, '0') }}</span><i :style="{ background: car.teamColor }"></i><b>{{ car.driverShort }}</b><span class="mono">{{ car.bestTime ? lapTime(car.bestTime) : '—' }}</span><span class="tiny muted">{{ trafficLabel(car) }}</span></div>
        </div>
        <div v-for="event in [...live.events].reverse()" :key="`${event.text}-${event.drivers.join('-')}`" class="elimination tiny">{{ event.text }}</div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.live-qualifying { min-width: 0; }
.start-qualifying { display:flex; align-items:center; justify-content:space-between; gap:16px; }.start-qualifying p { margin:4px 0 0; max-width:700px; }
.qualifying-ribbon { display:grid; grid-template-columns:auto auto minmax(0,1fr) auto; align-items:center; gap:12px; padding:11px 14px; border:1px solid var(--line); border-left:4px solid var(--green); background:var(--bg2); }.qualifying-ribbon.paused { border-left-color:var(--yellow); }.qualifying-ribbon.finishing { border-left-color:var(--orange); }.session-name { display:grid; gap:1px; }.session-name b { font-size:23px; font-style:italic; }.clock { font-size:30px; font-weight:800; letter-spacing:.04em; }.clock-copy { display:grid; gap:2px; }.clock-actions,.speed { display:flex; align-items:center; gap:4px; }.pause { min-height:38px; }.speed button { min-width:38px; padding-inline:8px; }.speed button.on { color:var(--text); border-color:var(--team); background:color-mix(in srgb,var(--team) 17%,var(--bg3)); }
.track-card { overflow:hidden; }.track-title { gap:10px; }.progress-axis { position:relative; height:132px; margin:6px 30px 0; }.axis-line { position:absolute; top:63px; left:0; right:0; height:4px; border-radius:3px; background:linear-gradient(90deg,var(--team),var(--cyan)); }.sector-boundary { position:absolute; top:48px; bottom:30px; border-left:1px dashed var(--muted); }.sector-boundary span { position:absolute; top:72px; transform:translateX(-50%); color:var(--muted); font-size:10px; white-space:nowrap; }.endpoint { position:absolute; top:82px; font-size:11px; color:var(--muted); }.endpoint.start { left:0; }.endpoint.finish { right:0; }.track-marker { position:absolute; z-index:1; width:32px; height:32px; transform:translateX(-50%); padding:0; border-radius:50%; border:2px solid var(--team-color); background:var(--bg); color:var(--text); font-size:9px; font-weight:800; line-height:1; transition:left .18s linear; }.mobile-marker { display:none; }.track-marker.lane-0 { top:8px; }.track-marker.lane-1 { top:50px; }.track-marker.lane-2 { top:92px; }.track-marker.resetting { transition:none; }.track-marker.mine { box-shadow:0 0 0 2px #fff; }.track-marker.selected { outline:2px solid var(--cyan); outline-offset:3px; }.track-marker.traffic { border-style:dashed; }.track-marker em { position:absolute; top:33px; left:50%; transform:translateX(-50%); font-style:normal; font-size:10px; color:var(--text); white-space:nowrap; }.track-marker.lane-2 em { top:-17px; }.mobile-cluster-picker { display:none; }.selected-traffic { display:flex; flex-wrap:wrap; gap:4px; padding:7px 9px; border-left:3px solid var(--cyan); background:var(--bg); font-size:12px; }.empty-track { padding:8px 0 0; }
.player-cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }.driver-card { border-color:var(--line); cursor:pointer; }.driver-card.selected { border-color:var(--team); }.driver-head,.car-status,.release-fields,.run-status { display:flex; align-items:center; gap:8px; }.driver-head { justify-content:space-between; }.driver-dot { display:inline-block; width:8px; height:20px; margin-right:6px; vertical-align:middle; }.car-status { justify-content:space-between; margin:9px 0; font-size:12px; color:var(--muted); }.release-fields { align-items:end; }.field { display:grid; flex:1; gap:3px; font-size:12px; color:var(--muted); }.field select { width:100%; }.release { min-height:38px; white-space:nowrap; }.run-status { justify-content:space-between; padding:9px; border:1px solid var(--line); background:var(--bg); font-size:12px; }.release-reason { margin-top:7px; color:var(--yellow); }.completed-runs { margin-top:8px; line-height:1.8; }.completed-runs :deep(.tyre) { vertical-align:middle; }
.garage-list { display:grid; gap:8px; }.garage-items { display:flex; flex-wrap:wrap; gap:5px 12px; }.garage-items span { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--muted); }.garage-items span.mine { color:var(--text); }.garage-items i,.timing-list i { display:inline-block; width:3px; height:16px; }.garage-items small { color:var(--muted); }
.timing-card { display:grid; gap:8px; }.timing-list { display:grid; }.timing-list > div { display:grid; grid-template-columns:28px 4px 48px 90px minmax(0,1fr); align-items:center; gap:7px; min-height:30px; border-bottom:1px solid var(--line); font-size:12px; }.timing-list > div.mine { background:color-mix(in srgb,var(--team) 9%,transparent); }.timing-list .mono { font-variant-numeric:tabular-nums; }.elimination { padding:5px 8px; border-left:3px solid var(--yellow); background:var(--bg); }
@media (prefers-reduced-motion: reduce) { .track-marker { transition:none; } }
@media (max-width:767px) { .live-qualifying,.player-cards,.driver-card { min-width:0; }.qualifying-ribbon { grid-template-columns:82px minmax(0,1fr); gap:7px; padding:9px 10px; }.clock { font-size:28px; }.clock-copy { align-self:center; }.clock-actions { grid-column:1/-1; display:grid; grid-template-columns:minmax(0,1fr) auto; }.clock-actions > .pause { min-height:44px; }.speed button { min-width:42px; min-height:44px; }.track-card { padding:10px; }.track-title > .tiny { display:none; }.progress-axis { height:92px; margin-inline:24px; }.axis-line { top:27px; }.sector-boundary { top:14px; bottom:29px; }.sector-boundary span { top:52px; }.endpoint { top:58px; }.desktop-marker { display:none; }.mobile-marker { display:block; top:6px; width:44px; height:44px; font-size:10px; }.mobile-marker.cluster { background:var(--bg3); }.mobile-cluster-picker { display:flex; flex-wrap:wrap; gap:6px; padding:7px; margin:0 0 6px; border:1px solid var(--line); background:var(--bg); }.mobile-cluster-picker button { min-width:44px; min-height:36px; border:2px solid var(--team-color); }.mobile-cluster-picker button.selected { outline:2px solid var(--cyan); }.mobile-cluster-picker button.mine { box-shadow:0 0 0 2px #fff inset; }.selected-traffic { margin-top:2px; }.player-cards { grid-template-columns:1fr; gap:8px; }.driver-card { padding:10px; }.release-fields { display:grid; grid-template-columns:minmax(0,1fr) 102px; }.release { min-height:44px; }.run-status { align-items:start; flex-direction:column; }.timing-list > div { grid-template-columns:23px 3px 36px 79px minmax(0,1fr); gap:5px; }.timing-list > div > :last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.garage-items { gap:5px 8px; }.start-qualifying { align-items:start; flex-direction:column; }.start-qualifying .row { width:100%; display:grid; grid-template-columns:1fr; }.start-qualifying button { min-height:44px; } }
</style>
