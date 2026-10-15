<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { GameView } from '../../../engine/view';

const props = defineProps<{ view: GameView }>();
const mode = ref<'drivers' | 'teams'>('drivers');
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const narrow = ref(false);
let sizeObserver: ResizeObserver | null = null;

function setNarrow(shell: HTMLElement, value: boolean) {
  narrow.value = value;
  shell.classList.toggle('tower-narrow', value);
}

onMounted(() => {
  const shell = root.value?.parentElement;
  if (!shell) return;
  if (typeof ResizeObserver === 'undefined') { setNarrow(shell, shell.clientWidth <= 960); return; }
  sizeObserver = new ResizeObserver(entries => setNarrow(shell, (entries[0]?.contentRect.width ?? shell.clientWidth) <= 960));
  sizeObserver.observe(shell);
});
onBeforeUnmount(() => {
  sizeObserver?.disconnect();
  root.value?.parentElement?.classList.remove('tower-narrow');
});

const live = computed(() => props.view.weekend?.liveRace ?? null);
const race = computed(() => props.view.weekend?.race ?? props.view.weekend?.sprint ?? null);
const isRace = computed(() => (!!live.value || !!race.value) && !!props.view.weekend?.isCurrent);
const playerDriverIds = computed(() => new Set(props.view.drivers.filter(d => d.isPlayerTeam).map(d => d.id)));
const driverById = computed(() => new Map(props.view.drivers.map(d => [d.id, d])));
const teamById = computed(() => new Map(props.view.teams.map(t => [t.id, t])));

const rows = computed(() => {
  if (live.value) {
    return live.value.timing.map(entry => {
      const driver = driverById.value.get(entry.driverId);
      return {
        key: entry.driverId,
        pos: entry.pos ?? 'DNF',
        code: driver?.short ?? driver?.name ?? entry.driverId,
        color: driver?.teamColor ?? '#666',
        me: playerDriverIds.value.has(entry.driverId),
        value: entry.status === 'dnf' ? 'DNF' : entry.gap,
        flag: entry.pits ? `PIT ${entry.pits}` : '',
        tyre: props.view.labels.tyres[entry.tyre]?.short ?? entry.tyre,
        dnf: entry.status === 'dnf',
      };
    });
  }
  if (isRace.value && race.value) {
    return race.value.classification.map((entry, index) => {
      const driver = driverById.value.get(entry.driverId);
      return {
        key: entry.driverId,
        pos: entry.pos ?? index + 1,
        code: driver?.short ?? driver?.name ?? entry.driverId,
        color: driver?.teamColor ?? '#666',
        me: playerDriverIds.value.has(entry.driverId),
        value: entry.status === 'dnf' ? 'DNF' : entry.pos === 1 ? 'LEADER' : entry.gap || '—',
        flag: entry.status === 'dnf' ? 'DNF' : entry.driverId === race.value?.fastestLap?.driverId ? 'FL' : entry.pits ? `PIT ${entry.pits}` : '',
        tyre: entry.tyres.length ? props.view.labels.tyres[entry.tyres[entry.tyres.length - 1]]?.short ?? '' : '',
        dnf: entry.status === 'dnf',
      };
    });
  }
  if (mode.value === 'teams') {
    return props.view.standings.teams.map(row => ({
      key: row.teamId,
      pos: row.pos,
      code: teamById.value.get(row.teamId)?.short ?? row.name,
      color: row.color,
      me: row.teamId === props.view.player.team.id,
      value: `${row.points}`,
      flag: '',
      tyre: '',
      dnf: false,
    }));
  }
  return props.view.standings.drivers.map(row => ({
    key: row.driverId,
    pos: row.pos,
    code: driverById.value.get(row.driverId)?.short ?? row.name,
    color: row.color,
    me: playerDriverIds.value.has(row.driverId),
    value: `${row.points}`,
    flag: '',
    tyre: '',
    dnf: false,
  }));
});

const title = computed(() => (isRace.value ? ((live.value?.kind ?? race.value?.kind) === 'sprint' ? '冲刺赛' : '正赛') : '积分榜'));
const detail = computed(() => {
  if (live.value) return `LIVE · L${live.value.completedLaps}/${live.value.totalLaps}`;
  if (isRace.value && race.value) return `${race.value.laps} 圈`;
  return props.view.season.roundIndex ? `第 ${props.view.season.roundIndex} 站后` : '赛季开始';
});
const stripRows = computed(() => {
  const mine = rows.value.filter(row => row.me);
  return mine.length ? mine : rows.value.slice(0, 3);
});
</script>

<template>
  <section ref="root" class="timing" :class="{ open, narrow }" aria-label="计时塔">
    <button class="tower-strip" type="button" :aria-expanded="open" @click="open = !open">
      <span class="strip-title">{{ title }}</span>
      <span v-for="row in stripRows" :key="row.key" class="strip-row" :style="{ '--c': row.color }">
        <b>{{ row.pos }}</b><i></i><strong>{{ row.code }}</strong><span>{{ row.value }}</span>
      </span>
      <span class="strip-toggle">{{ open ? '⌃' : '⌄' }}</span>
    </button>

    <aside class="tower" :class="{ 'tower-open': open }">
      <header class="tower-head">
        <div class="tower-title">
          <span>{{ title }}</span>
          <span v-if="live" class="result-badge live-badge">LIVE · L{{ live.completedLaps }}/{{ live.totalLaps }}</span>
          <span v-else-if="isRace" class="result-badge">完赛</span>
          <span v-else class="tiny muted">{{ detail }}</span>
        </div>
        <div v-if="!isRace" class="seg" role="tablist" aria-label="积分榜类型">
          <button type="button" :class="{ on: mode === 'drivers' }" @click="mode = 'drivers'">车手</button>
          <button type="button" :class="{ on: mode === 'teams' }" @click="mode = 'teams'">车队</button>
        </div>
      </header>
      <div class="tower-rows" role="table">
        <div v-for="(row, i) in rows" :key="row.key" class="trow" :class="{ me: row.me, dnf: row.dnf }" :style="{ '--c': row.color, '--i': i }" role="row">
          <span class="t-pos">{{ row.dnf ? 'DNF' : row.pos }}</span>
          <span class="t-bar"></span>
          <span class="t-code">{{ row.code }}</span>
          <span class="t-gap">{{ row.value }}</span>
          <span v-if="row.tyre" class="t-tyre">{{ row.tyre }}</span>
          <span v-if="row.flag" class="t-flag" :class="{ dnf: row.dnf, fl: row.flag === 'FL', pit: row.flag.startsWith('PIT') }">{{ row.flag }}</span>
        </div>
      </div>
      <footer class="tower-foot">{{ live ? '实时顺序为当前圈末快照' : isRace ? '完赛顺序来自已完成的比赛模拟' : '比赛周末将显示本站分类' }}</footer>
    </aside>
    <button v-if="open" class="tower-backdrop" type="button" aria-label="关闭排名塔" @click="open = false"></button>
  </section>
</template>

<style scoped>
.timing { width: var(--tower-w); flex: 0 0 var(--tower-w); }
.tower { height: 100%; min-height: 0; display: flex; flex-direction: column; background: linear-gradient(180deg, rgba(5,6,9,.96), rgba(8,9,13,.96)); border-right: 1px solid var(--line); }
.tower-strip { display: none; }
.tower-backdrop { display: none; }
.tower-head { position: relative; padding: 9px 8px 7px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, #14171f, #0b0d12); }
.tower-head::before { content: ''; position: absolute; inset: 0 0 auto; height: 3px; background: var(--red); }
.tower-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; font: italic 800 14px/1.1 var(--font-display); letter-spacing: .04em; }
.result-badge { display: inline-flex; align-items: center; padding: 3px 6px; background: var(--red); color: #fff; font-size: 11px; }
.live i, .live-dot { width: 6px; height: 6px; border-radius: 50%; background: #fff; animation: blink 1.4s ease-in-out infinite; }
.tower .seg { width: 100%; margin-top: 7px; }.tower .seg button { flex: 1; padding: 3px 0; font-size: 12px; }
.tower-rows { flex: 1; overflow: auto; padding: 3px 0; }
.trow { --c: #666; position: relative; display: grid; grid-template-columns: 24px 3px minmax(0,1fr) auto auto auto; align-items: center; column-gap: 5px; min-height: 25px; padding-right: 7px; font-size: 12px; animation: rowin .5s var(--ease) both; animation-delay: calc(var(--i) * 28ms); }
.trow + .trow { border-top: 1px solid rgba(255,255,255,.04); }.t-pos { height: 100%; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.06); font: italic 800 13px/1 var(--font-display); }.trow:nth-child(-n+3) .t-pos { background: #f3f4f7; color: #08090c; }.t-bar { width: 3px; height: 15px; background: var(--c); }.t-code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: italic 800 13px/1 var(--font-display); letter-spacing: .04em; }.t-gap { min-width: 38px; text-align: right; font: 600 11px/1 var(--font-num); color: #d9dce4; }.t-tyre { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line2); border-radius: 50%; font: 800 9px/1 var(--font-num); }.t-flag { margin-left: 2px; padding: 2px 3px; font: italic 800 9px/1 var(--font-display); background: var(--blue); color: #fff; }.t-flag.fl { background: var(--purple); }.t-flag.dnf { background: #3a3f4c; }.trow.me { background: linear-gradient(90deg, color-mix(in srgb, var(--c) 34%, transparent), transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 50%, transparent); }.trow.me::after { content: ''; position: absolute; right: 0; top: 4px; bottom: 4px; width: 2px; background: var(--c); }.trow.dnf { opacity: .5; }.trow.dnf .t-pos { background: transparent; color: var(--muted); font-size: 10px; }.tower-foot { padding: 7px 8px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
@keyframes rowin { from { opacity: 0; transform: translateX(-10px); } } @keyframes blink { 50% { opacity: .2; } }
@media (max-width: 767px) { .timing { width: 100%; flex: none; position: relative; z-index: 30; }.tower-strip { width: 100%; height: 40px; padding: 0; display: flex; align-items: center; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: #06070a; overflow: hidden; }.strip-title { display: flex; align-items: center; gap: 5px; height: 100%; padding: 0 9px; background: #11141b; color: var(--text); font: italic 800 12px/1 var(--font-display); white-space: nowrap; }.strip-title .live-dot { background: var(--red); }.strip-row { --c: #666; display: flex; align-items: center; gap: 4px; min-width: 0; height: 27px; padding: 0 6px; border-right: 1px solid rgba(255,255,255,.06); white-space: nowrap; }.strip-row i { width: 3px; height: 14px; background: var(--c); }.strip-row strong { overflow: hidden; text-overflow: ellipsis; font: italic 800 12px/1 var(--font-display); }.strip-row span { color: var(--muted); font: 600 11px/1 var(--font-num); }.strip-toggle { margin-left: auto; width: 42px; font-size: 18px; }.tower { position: fixed; top: 0; bottom: 0; left: 0; z-index: 41; width: min(320px, 88vw); min-height: 0; transform: translateX(-105%); transition: transform var(--t-med) var(--ease); box-shadow: 12px 0 32px rgba(0,0,0,.65); }.tower-open { transform: translateX(0); }.tower-backdrop { display: block; position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; background: rgba(0,0,0,.42); }.tower-rows { overflow-y: auto; }.trow { min-height: 30px; font-size: 13px; } }
.timing.narrow { width: 100%; flex: none; position: relative; z-index: 30; }.timing.narrow .tower-strip { width: 100%; height: 40px; padding: 0; display: flex; align-items: center; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: #06070a; overflow: hidden; }.timing.narrow .strip-title { display: flex; align-items: center; gap: 5px; height: 100%; padding: 0 9px; background: #11141b; color: var(--text); font: italic 800 12px/1 var(--font-display); white-space: nowrap; }.timing.narrow .strip-title .live-dot { background: var(--red); }.timing.narrow .strip-row { --c: #666; display: flex; align-items: center; gap: 4px; min-width: 0; height: 27px; padding: 0 6px; border-right: 1px solid rgba(255,255,255,.06); white-space: nowrap; }.timing.narrow .strip-row i { width: 3px; height: 14px; background: var(--c); }.timing.narrow .strip-row strong { overflow: hidden; text-overflow: ellipsis; font: italic 800 12px/1 var(--font-display); }.timing.narrow .strip-row span { color: var(--muted); font: 600 11px/1 var(--font-num); }.timing.narrow .strip-toggle { margin-left: auto; width: 42px; font-size: 18px; }.timing.narrow .tower { position: fixed; top: 0; bottom: 0; left: 0; z-index: 41; width: min(320px, 88vw); min-height: 0; transform: translateX(-105%); transition: transform var(--t-med) var(--ease); box-shadow: 12px 0 32px rgba(0,0,0,.65); }.timing.narrow .tower-open { transform: translateX(0); }.timing.narrow .tower-backdrop { display: block; position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; background: rgba(0,0,0,.42); }.timing.narrow .tower-rows { overflow-y: auto; }.timing.narrow .trow { min-height: 30px; font-size: 13px; }
</style>
