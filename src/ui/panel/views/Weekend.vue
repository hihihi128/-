<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Bar from '../components/Bar.vue';
import LapChart from '../components/LapChart.vue';
import RainHistoryChart from '../components/RainHistoryChart.vue';
import Tyre from '../components/Tyre.vue';
import LiveRaceDesk from '../components/LiveRaceDesk.vue';
import WeekendWeatherForecast from '../components/WeekendWeatherForecast.vue';
import StrategyReviewDialog from '../components/StrategyReviewDialog.vue';
import { act, call, lapTime, store } from '../bridge';
import type { DriverPlan, PaceMode, PitTiming, PracticeProgram, PracticeSetupFocus, QualiApproach, RaceResult, QualiResult } from '../../../engine/types';
import type { WeekendDriverView } from '../../../engine/view';
import type { EngineerStrategyResult } from '../../../tavern/controller';

const v = computed(() => store.view!);
const w = computed(() => v.value.weekend);
const phase = computed(() => v.value.season.phase);
const isSprint = computed(() => w.value ? w.value.practiceSessionTotal === 1 : !!v.value.round?.sprint);
const current = computed(() => !!w.value?.isCurrent);
const generating = computed(() => !!store.status?.generating);
const raceResultNarration = computed(() => v.value.narration.some(item => /(?:正赛|冲刺赛)结果$/.test(item.title)));
const practiceSessions = computed(() => {
  const ww = w.value;
  return ww?.practiceSessions?.length ? ww.practiceSessions : ww?.practice ? [ww.practice] : [];
});
const practiceSessionTotal = computed(() => w.value?.practiceSessionTotal ?? 0);
const returnSelections = ref<Record<string, string[]>>({});
const qualifyingTyreSelections = ref<Record<string, string[]>>({});
function toggleReturnSet(driverId: string, setId: string) {
  const selected = returnSelections.value[driverId] ?? [];
  const required = w.value?.practiceReturn?.required ?? 0;
  returnSelections.value[driverId] = selected.includes(setId) ? selected.filter(id => id !== setId) : selected.length < required ? [...selected, setId] : selected;
}
function returnTyres(driverId: string) {
  void act({ type: 'RETURN_PRACTICE_TYRES', driverId, setIds: returnSelections.value[driverId] ?? [] });
}

const steps = computed(() => {
  const s: Array<{ id: string; label: string }> = [{ id: 'practice', label: `练习赛 ${practiceSessions.value.length}/${practiceSessionTotal.value}` }];
  if (isSprint.value) s.push({ id: 'sprint_qualifying', label: '冲刺排位' }, { id: 'sprint', label: '冲刺赛' });
  s.push({ id: 'qualifying', label: '排位赛' }, { id: 'race', label: '正赛' }, { id: 'post_race', label: '赛后' });
  return s;
});
const stepIndex = computed(() => (current.value ? steps.value.findIndex(s => s.id === phase.value) : -1));

const done = computed(() => ({
  practice: phase.value !== 'practice' || practiceSessions.value.length >= practiceSessionTotal.value,
  sprintQualifying: !!w.value?.sprintQualifying,
  sprint: !!w.value?.sprint,
  qualifying: !!w.value?.qualifying,
  race: !!w.value?.race,
}));

const resultTab = ref<'race' | 'qualifying' | 'sprint' | 'sprintQualifying' | 'practice'>('race');
const practiceResultIndex = ref(-1);
const shownResult = computed(() => {
  const ww = w.value;
  if (!ww) return null;
  const order: Array<typeof resultTab.value> = [resultTab.value, 'race', 'qualifying', 'sprint', 'sprintQualifying', 'practice'];
  for (const k of order) {
    if (k === 'practice' ? practiceSessions.value.length : ww[k]) return k;
  }
  return null;
});
const shownPractice = computed(() => {
  const latest = practiceSessions.value.length - 1;
  const index = practiceResultIndex.value < 0 ? latest : Math.min(practiceResultIndex.value, latest);
  return practiceSessions.value[index] ?? null;
});
const shownPracticeIndex = computed(() => practiceResultIndex.value < 0 ? practiceSessions.value.length - 1 : practiceResultIndex.value);

function showPracticeResult(index: number) {
  practiceResultIndex.value = index;
  resultTab.value = 'practice';
}

function setPlan(d: WeekendDriverView, patch: Partial<DriverPlan>) {
  return act({ type: 'SET_PLAN', driverId: d.driverId, plan: patch }, { silent: true });
}

function practiceTyreOptions(d: WeekendDriverView) {
  return Object.keys(v.value.labels.tyres).map(compound => {
    const available = d.tyreSets.filter(set => set.compound === compound && !set.returned);
    return { compound, available: available.length, newSets: available.filter(set => set.state === 'new').length, leastLaps: Math.min(...available.map(set => set.laps)) };
  }).filter(option => option.available > 0);
}

const customPlans = ref<Record<string, string[]>>({});
const customSetPlans = ref<Record<string, string[]>>({});
const engineerApi = ref<Record<string, 'main' | 'secondary'>>({});
const engineerSuggestions = ref<Record<string, EngineerStrategyResult>>({});
const perfectSuggestions = ref<Record<string, EngineerStrategyResult>>({});
const perfectOpen = ref(false);
const perfectFab = ref<HTMLButtonElement | null>(null);
const perfectDialog = ref<HTMLElement | null>(null);
const reviewDriver = ref<WeekendDriverView | null>(null);
const reviewTrigger = ref<HTMLButtonElement | null>(null);
watch(perfectOpen, async open => {
  await nextTick();
  if (open) perfectDialog.value?.querySelector<HTMLButtonElement>('button')?.focus();
  else perfectFab.value?.focus();
});
function closePerfect() { perfectOpen.value = false; }
function openStrategyReview(d: WeekendDriverView, event: MouseEvent) {
  reviewTrigger.value = event.currentTarget as HTMLButtonElement;
  reviewDriver.value = d;
}
function closeStrategyReview() {
  reviewDriver.value = null;
  void nextTick(() => reviewTrigger.value?.focus());
}
function canReviewStrategy(d: WeekendDriverView): boolean {
  return d.plan.strategySource === 'engineer';
}
function reviewUnavailableReason(d: WeekendDriverView): string {
  return d.plan.strategySource === 'perfect'
    ? '完美策略不属于工程师方案，不能作为策略点评对象。'
    : '请先选择“听工程师”生成当前工程师策略，再请求点评。';
}
function currentStrategyReview(d: WeekendDriverView): DriverPlan['strategyReview'] | null {
  const review = d.plan.strategyReview;
  const roundKey = `${v.value.season.year}:r${(w.value?.roundIndex ?? -1) + 1}`;
  return review?.source === 'secondary' && review.roundKey === roundKey ? review : null;
}
type DriverPerformanceSummary = {
  qualiGain?: number;
  raceGain?: number;
  wearDelta?: number;
  trackFit?: number;
  trackKnowledge?: number;
  tyres?: Record<string, { temperature?: number; temperatureWindow?: [number, number]; status?: string; wearMultiplier?: number; life?: number }>;
};
function performanceSummary(d: WeekendDriverView): DriverPerformanceSummary | null {
  if (!d.performanceSummary) return null;
  return {
    qualiGain: d.performanceSummary.qualiGain,
    raceGain: d.performanceSummary.raceGain,
    wearDelta: d.performanceSummary.wearDelta / 100,
    trackFit: d.performanceSummary.trackFit,
    trackKnowledge: d.performanceSummary.trackKnowledge,
    tyres: d.performanceSummary.tyres,
  };
}
function primaryTyreSummary(d: WeekendDriverView): NonNullable<DriverPerformanceSummary['tyres']>[string] | null {
  const compound = d.plan.tyrePlan?.[0];
  const tyre = compound ? performanceSummary(d)?.tyres?.[compound] : null;
  if (!compound || !tyre) return null;
  return { ...tyre, life: d.tyreLife[compound] };
}
function gainSeconds(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `快 ${value.toFixed(2)}s/圈` : '数据待生成';
}
function percentChange(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${Math.round(value * 100)}%` : '数据待生成';
}
watch(() => w.value?.roundIndex, () => {
  customPlans.value = {};
  customSetPlans.value = {};
  qualifyingTyreSelections.value = {};
  engineerSuggestions.value = {};
  perfectSuggestions.value = {};
  perfectOpen.value = false;
  reviewDriver.value = null;
  practiceResultIndex.value = Math.max(0, practiceSessions.value.length - 1);
});
watch(() => practiceSessions.value.length, length => {
  if (length > 0) practiceResultIndex.value = length - 1;
});
watch(() => practiceSessions.value.length, () => { returnSelections.value = {}; });
watch(
  () => (w.value?.drivers ?? []).map(d => `${d.driverId}:${d.plan.strategySource}:${Array.isArray(d.plan.tyrePlan) ? d.plan.tyrePlan.join(',') : 'auto'}`).join('|'),
  () => {
    for (const d of w.value?.drivers ?? []) if (d.plan.strategySource !== 'player') delete customSetPlans.value[d.driverId];
  },
);

const qualifyingPhase = computed(() => phase.value === 'qualifying' || phase.value === 'sprint_qualifying');
const qualifyingSegmentIndex = computed(() => w.value?.liveQualifying?.segmentIndex ?? 0);
const qualifyingSegmentCount = computed(() => w.value?.liveQualifying?.segmentCount ?? 3);
const qualifyingRuns = computed(() => phase.value === 'sprint_qualifying' ? 1 : qualifyingSegmentCount.value === 1 ? 3 : 2);
const qualifyingSegmentLabel = computed(() => `${phase.value === 'sprint_qualifying' ? 'SQ' : 'Q'}${qualifyingSegmentCount.value === 1 ? '' : qualifyingSegmentIndex.value + 1}`);

function qualifyingSetOptions(d: WeekendDriverView) {
  const legal = new Set(d.qualifyingTyreSetIds);
  return d.tyreSets.filter(set => legal.has(set.id));
}

function qualifyingSelection(d: WeekendDriverView): string[] {
  return qualifyingTyreSelections.value[d.driverId] ?? [];
}

function qualifyingDriverActive(d: WeekendDriverView): boolean {
  return !w.value?.liveQualifying || w.value.liveQualifying.alive.includes(d.driverId);
}

function syncQualifyingSelections() {
  const next: Record<string, string[]> = {};
  for (const d of w.value?.drivers ?? []) {
    const options = qualifyingSetOptions(d);
    const existing = qualifyingTyreSelections.value[d.driverId] ?? [];
    next[d.driverId] = Array.from({ length: qualifyingRuns.value }, (_, index) => {
      const selected = existing[index];
      return options.some(option => option.id === selected) ? selected : options[index % Math.max(1, options.length)]?.id ?? '';
    });
  }
  qualifyingTyreSelections.value = next;
}

watch(
  () => [phase.value, qualifyingSegmentIndex.value, qualifyingRuns.value, ...(w.value?.drivers ?? []).flatMap(d => d.qualifyingTyreSetIds)],
  syncQualifyingSelections,
  { immediate: true },
);

function runQualifyingSegment() {
  const tyreSetIds = Object.fromEntries((w.value?.drivers ?? []).map(d => [d.driverId, qualifyingSelection(d).filter(Boolean)]));
  return act({ type: phase.value === 'sprint_qualifying' ? 'RUN_SPRINT_QUALIFYING' : 'RUN_QUALIFYING', tyreSetIds });
}

function customFor(d: WeekendDriverView): string[] {
  if (!customPlans.value[d.driverId]) {
    const dry = v.value.rules.dryCompounds;
    customPlans.value[d.driverId] = Array.isArray(d.plan.tyrePlan) ? [...d.plan.tyrePlan] : [dry[0], dry[1] ?? dry[0]];
  }
  return customPlans.value[d.driverId];
}

function customSetsFor(d: WeekendDriverView): string[] {
  if (!customSetPlans.value[d.driverId]) customSetPlans.value[d.driverId] = [...(d.plan.raceTyreSetPlan ?? [])];
  const sets = customSetPlans.value[d.driverId];
  while (sets.length < customFor(d).length) sets.push('');
  return sets;
}

function setCustomCompound(d: WeekendDriverView, index: number, compound: string) {
  customFor(d)[index] = compound;
  customSetsFor(d)[index] = '';
}

function addCustomCompound(d: WeekendDriverView) {
  const plan = customFor(d);
  const sets = customSetsFor(d);
  if (plan.length < 4) { plan.push(v.value.rules.dryCompounds[0]); sets.push(''); }
}

function removeCustomCompound(d: WeekendDriverView) {
  const plan = customFor(d);
  if (plan.length > 2) { plan.pop(); customSetsFor(d).pop(); }
}

function raceSetOptions(d: WeekendDriverView, compound: string) {
  return d.tyreSets.filter(set => !set.returned && set.compound === compound);
}

function applyCustomPlan(d: WeekendDriverView) {
  const sets = customSetsFor(d);
  const filled = sets.filter(Boolean).length;
  if (filled > 0 && filled !== sets.length) return;
  return setPlan(d, { strategySource: 'player', tyrePlan: [...customFor(d)], raceTyreSetPlan: filled ? [...sets] : [] });
}

function partialRaceSetSelection(d: WeekendDriverView): boolean {
  const sets = customSetsFor(d);
  const filled = sets.filter(Boolean).length;
  return filled > 0 && filled !== sets.length;
}

async function askEngineer(d: WeekendDriverView) {
  const result = await call(a => a.requestEngineerStrategy(d.driverId, engineerApi.value[d.driverId]));
  if (result?.ok) {
    engineerSuggestions.value[d.driverId] = result;
    delete perfectSuggestions.value[d.driverId];
  }
}

async function askPerfect(d: WeekendDriverView) {
  const result = await call(a => a.requestPerfectStrategy(d.driverId, engineerApi.value[d.driverId]));
  if (result?.ok) {
    perfectSuggestions.value[d.driverId] = result;
    engineerSuggestions.value[d.driverId] = result;
  }
}

function engineerApiFor(driverId: string): 'main' | 'secondary' {
  return engineerApi.value[driverId] ?? store.status?.settings.engineerApi ?? 'main';
}

function usePlayerStrategy(d: WeekendDriverView) {
  void setPlan(d, { strategySource: 'player', tyrePlan: [...customFor(d)], paceMode: 'balanced', pitTiming: 'standard', scReaction: true });
}

const strategyRiskTeam = computed(() => {
  const staff = v.value.player.staff;
  const strategist = staff.find(member => member.role === 'strategist');
  const engineers = staff.filter(member => member.role === 'raceEngineer' || member.role === 'raceEngineer2');
  return (strategist?.abilities?.strategy ?? strategist?.skill ?? 100) < 72
    || (strategist?.abilities?.weather ?? strategist?.skill ?? 100) < 72
    || (strategist?.abilities?.risk ?? 70) >= 82
    || engineers.some(engineer => (engineer.abilities?.reaction ?? engineer.skill) < 74 || (engineer.abilities?.weather ?? engineer.skill) < 74);
});

function name(id: string): string {
  return v.value.drivers.find(d => d.id === id)?.name ?? id;
}
function teamOf(id: string) {
  const d = v.value.drivers.find(x => x.id === id);
  return { color: d?.teamColor ?? '#666', mine: !!d?.isPlayerTeam };
}

const programs: Array<[PracticeProgram, string, string]> = [
  ['setup', '调校', '提升调校信心（排位与正赛都更快）'],
  ['longrun', '长距离', '积累轮胎数据（降低衰减、策略更准）'],
  ['quali_sim', '排位模拟', '直接提升排位单圈'],
  ['parts', '新件测试', '验证新零件的真实性能，发现问题可在排位前换回旧件'],
];
const setupFocuses: Array<[PracticeSetupFocus, string, string]> = [
  ['balanced', '综合基准', '平均积累各项调校数据'],
  ['aero_balance', '空气动力平衡', '重点调整前后翼平衡，偏向排位表现'],
  ['mechanical', '机械抓地', '重点调整悬挂和差速器，改善慢弯与轮胎使用'],
  ['ride_height', '车高与底板', '重点寻找车高窗口和赛道适配'],
  ['tyre_prep', '胎压与热身', '重点积累胎温、胎压和长距离数据'],
];
const approaches: Array<[QualiApproach, string, string]> = [
  ['safe', '稳妥', '失误少，略慢'],
  ['standard', '标准', ''],
  ['aggressive', '激进', '更快，但失误率接近翻倍'],
];
const paceModes: Array<[PaceMode, string, string]> = [
  ['conserve', '保守', '慢约 0.3s/圈，多回收电能，轮胎与机械更耐用'],
  ['balanced', '均衡', ''],
  ['push', '进攻', '快约 0.2s/圈，并用 Boost 按钮主动释放电能（超车、防守更强），衰减与故障/失误风险上升'],
];
const timings: Array<[PitTiming, string, string]> = [
  ['early', '提前', '每段提前 2 圈进站（Undercut）'],
  ['standard', '按计划', ''],
  ['late', '推迟', '每段推迟 2 圈进站（Overcut）'],
];

const raceLike = computed<RaceResult | null>(() => {
  const k = shownResult.value;
  if (k === 'race') return w.value!.race;
  if (k === 'sprint') return w.value!.sprint;
  return null;
});
const qualiLike = computed<QualiResult | null>(() => {
  const k = shownResult.value;
  if (k === 'qualifying') return w.value!.qualifying;
  if (k === 'sprintQualifying') return w.value!.sprintQualifying;
  return null;
});
const chartSeries = computed(() => {
  const r = raceLike.value;
  if (!r) return [];
  const palette = ['var(--team)', '#ffffff', '#ffd400'];
  return Object.entries(r.lapChart).map(([id, data], i) => ({ name: name(id), color: palette[i % palette.length], data }));
});
</script>

<template>
  <div class="stack">
    <StrategyReviewDialog
      v-if="reviewDriver"
      :driver-id="reviewDriver.driverId"
      :driver-name="reviewDriver.driverName"
      :plan="reviewDriver.plan"
      :expected-revision-id="store.status?.revisionId"
      :race-laps="v.round?.track.laps"
      :can-review="canReviewStrategy(reviewDriver)"
      :unavailable-reason="reviewUnavailableReason(reviewDriver)"
      @close="closeStrategyReview"
    />
    <button v-if="current && w && !w.liveRace" ref="perfectFab" class="codex-fab" title="打开完美策略 AI" aria-label="打开完美策略 AI" @click="perfectOpen = true">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 15 7l5.2.7-3.3 4.1.8 5.2-4.8-2.2L8.1 17l.8-5.2-3.3-4.1L10.8 7 12 2.5Zm0 5.1-1.2 3.1-3.3.2 2.5 2.2-.8 3.2 2.8-1.7 2.8 1.7-.8-3.2 2.5-2.2-3.3-.2L12 7.6Z" /></svg>
    </button>
    <div v-if="perfectOpen" class="perfect-backdrop" @click.self="closePerfect" @keydown.esc="closePerfect">
      <section ref="perfectDialog" class="perfect-window card stack-s" role="dialog" aria-modal="true" aria-label="完美策略 AI" tabindex="-1">
        <div class="spread">
          <div class="row"><span class="codex-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 15 7l5.2.7-3.3 4.1.8 5.2-4.8-2.2L8.1 17l.8-5.2-3.3-4.1L10.8 7 12 2.5Zm0 5.1-1.2 3.1-3.3.2 2.5 2.2-.8 3.2 2.8-1.7 2.8 1.7-.8-3.2 2.5-2.2-3.3-.2L12 7.6Z" /></svg></span><div><h3>完美策略 AI</h3><div class="tiny muted">使用与车队工程师相同的 API，但忽略策略人员水平，自动应用最快合法方案。</div></div></div>
          <button class="small" aria-label="关闭" @click="closePerfect">✕</button>
        </div>
        <div v-for="d in (w?.drivers ?? [])" :key="d.driverId" class="perfect-driver stack-s">
          <div class="spread"><b>{{ d.driverName }}</b><select :value="engineerApiFor(d.driverId)" class="small" :disabled="store.busy" @change="engineerApi[d.driverId] = ($event.target as HTMLSelectElement).value as 'main' | 'secondary'"><option value="main">主 API</option><option value="secondary">副 API</option></select></div>
          <div v-if="perfectSuggestions[d.driverId]?.explanation" class="small">{{ perfectSuggestions[d.driverId].explanation }}</div>
          <div v-else class="tiny muted">后端会结合发车位、天气窗口、合法轮胎组合和预计总用时选择方案。</div>
          <button class="primary" :disabled="done.race || store.busy || !!w?.liveRace" @click="askPerfect(d)">{{ perfectSuggestions[d.driverId] ? '重新计算并应用' : '生成并应用完美策略' }}</button>
        </div>
      </section>
    </div>
    <LiveRaceDesk v-if="current && w && ['race', 'sprint'].includes(phase)" />
    <div class="card">
      <div class="stepper">
        <div v-for="(s, i) in steps" :key="s.id" class="step" :class="{ done: stepIndex > i || (!current && !!w), on: stepIndex === i }">
          <span class="dot">{{ i + 1 }}</span>{{ s.label }}
        </div>
      </div>
      <div class="spread" style="margin-top: 10px">
        <div class="small muted">
          <template v-if="current && w">练习进度 {{ practiceSessions.length }}/{{ practiceSessionTotal }}</template>
          <template v-else-if="phase === 'pre_race' || phase === 'preseason'">还没进入本站比赛周末。工厂周可以先安排研发、装件和训练。</template>
          <template v-else-if="phase === 'season_end'">赛季已结束。</template>
        </div>
        <div class="row">
          <button v-if="v.narration.length" class="small" :disabled="generating" @click="call(a => a.requestNarration())">{{ raceResultNarration ? '让 AI 叙述比赛结果' : `让 AI 叙述（${v.narration.length}）` }}</button>
          <button v-if="v.next && !qualifyingPhase" class="primary" :disabled="store.busy || generating" @click="act({ type: 'ADVANCE' })">▶ {{ v.next.label }}</button>
          <button v-else-if="v.next && qualifyingPhase" class="primary" :disabled="store.busy || generating" @click="runQualifyingSegment">▶ 运行 {{ qualifyingSegmentLabel }}</button>
        </div>
      </div>
    </div>

    <template v-if="current && w">
      <WeekendWeatherForecast :weekend="w" :sprint="isSprint" :race-laps="v.round?.track.laps ?? 1" />
      <div class="card stack-s">
        <h3>车队指令</h3>
        <div class="small" :class="w.teammateRelationship < 50 ? 'neg' : 'muted'">队友关系 {{ w.teammateRelationship.toFixed(0) }}/100<span v-if="w.teammateRelationship < 50"> · 已进入抗命风险区</span></div>
        <div class="row">
          <div class="seg">
            <button :class="{ on: w.teamOrders.mode === 'free' }" :disabled="done.race" @click="act({ type: 'SET_TEAM_ORDERS', orders: { mode: 'free', favorDriverId: null } })">自由比赛</button>
            <button :class="{ on: w.teamOrders.mode === 'hold' }" :disabled="done.race" @click="act({ type: 'SET_TEAM_ORDERS', orders: { mode: 'hold', favorDriverId: null } })">保持位置</button>
            <button v-for="d in w.drivers" :key="d.driverId" :class="{ on: w.teamOrders.mode === 'favor' && w.teamOrders.favorDriverId === d.driverId }" :disabled="done.race" @click="act({ type: 'SET_TEAM_ORDERS', orders: { mode: 'favor', favorDriverId: d.driverId } })">
              偏向 {{ d.driverName }}
            </button>
          </div>
        </div>
        <div class="tiny muted">车手信任低于 40，或队友关系低于 50 时，车手可能拒绝赛前策略、临场策略或让车指令。数值越低，抗命概率越高。</div>
      </div>

      <div class="grid g2">
        <div v-for="d in w.drivers" :key="d.driverId" class="card stack-s">
          <h3>{{ d.driverName }}</h3>
          <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 4px 12px">
            <Bar label="调校信心" :value="d.setup.confidence" color="#6aa6ff" />
            <Bar label="轮胎数据" :value="d.setup.tyreKnowledge" color="#ffb347" />
          </div>
          <div class="performance-summary">
            <div class="spread"><b class="small">练习、适配与轮胎预测</b><span class="tiny muted">相对本站练习基线</span></div>
            <div class="performance-row">
              <span class="muted">练习调校</span>
              <span><b class="pos">排位 {{ gainSeconds(performanceSummary(d)?.qualiGain) }}</b> · 正赛 {{ gainSeconds(performanceSummary(d)?.raceGain) }}</span>
              <span class="tiny muted">胎耗 {{ percentChange(performanceSummary(d)?.wearDelta) }}</span>
            </div>
            <div class="performance-row">
              <span class="muted">赛道适配</span>
              <span v-if="performanceSummary(d)"><b>{{ Math.round(performanceSummary(d)?.trackFit ?? 0) }}/100</b> · 练习掌握 {{ Math.round(performanceSummary(d)?.trackKnowledge ?? 0) }}/100</span>
              <span v-else class="tiny muted">历史练习收益不可追溯</span>
            </div>
            <div class="performance-row" v-if="primaryTyreSummary(d)">
              <span class="muted">首段胎温</span>
              <span><b>{{ primaryTyreSummary(d)?.temperature?.toFixed(0) ?? '—' }}°C · {{ primaryTyreSummary(d)?.status ?? '预测中' }}</b></span>
              <span class="tiny muted">窗口 {{ primaryTyreSummary(d)?.temperatureWindow?.[0] ?? '—' }}–{{ primaryTyreSummary(d)?.temperatureWindow?.[1] ?? '—' }}°C · 预计寿命 {{ primaryTyreSummary(d)?.life ?? '—' }} 圈</span>
            </div>
            <div v-else class="performance-row"><span class="muted">胎温与胎耗</span><span class="tiny muted">模型数据待生成；轮胎寿命请见下方预测。</span></div>
          </div>
          <div v-if="w.penalties[d.driverId]" class="notice warn tiny">本站罚退 {{ w.penalties[d.driverId] }} 格</div>
          <div class="block stack-s">
            <div class="label">实体轮胎库存 <span class="tiny muted">新胎 / 已使用 · 圈数</span></div>
            <div class="row wrap tyre-inventory">
              <label v-for="set in d.tyreSets" :key="set.id" class="tyre-set tiny" :class="{ returned: set.returned, selected: (returnSelections[d.driverId] ?? []).includes(set.id) }">
                <input v-if="w.practiceReturn?.driverIds.includes(d.driverId) && set.returnEligible" type="checkbox" :checked="(returnSelections[d.driverId] ?? []).includes(set.id)" @change="toggleReturnSet(d.driverId, set.id)" />
                <Tyre :c="set.compound" /> {{ set.state === 'new' ? '新' : '已用' }} {{ set.laps }}L<span v-if="set.returned"> · 已交回</span><span v-else-if="w.practiceReturn?.driverIds.includes(d.driverId) && !set.returnEligible"> · 不可交回</span>
              </label>
            </div>
            <div v-if="w.practiceReturn?.driverIds.includes(d.driverId)" class="row">
              <span class="tiny warn">本节必须交回 {{ w.practiceReturn.required }} 组（已选 {{ (returnSelections[d.driverId] ?? []).length }}）</span>
              <button class="small primary" :disabled="store.busy || (returnSelections[d.driverId] ?? []).length !== w.practiceReturn.required" @click="returnTyres(d.driverId)">确认交回</button>
            </div>
          </div>

          <div class="block">
            <div class="label">练习赛项目</div>
            <div class="seg wrap">
              <button v-for="[k, label, tip] in programs" :key="k" :title="tip" :class="{ on: d.plan.practiceProgram === k }" :disabled="done.practice || store.busy" @click="setPlan(d, { practiceProgram: k })">{{ label }}</button>
            </div>
          </div>
          <div class="block">
            <div class="label">练习赛轮胎</div>
            <div class="seg wrap">
              <button :class="{ on: (d.plan.practiceTyre ?? 'auto') === 'auto' }" :disabled="done.practice || store.busy" @click="setPlan(d, { practiceTyre: 'auto' })">自动</button>
              <button v-for="option in practiceTyreOptions(d)" :key="option.compound" :class="{ on: d.plan.practiceTyre === option.compound }" :disabled="done.practice || store.busy || (v.labels.tyres[option.compound]?.wet && w.weather.practice !== 'wet')" @click="setPlan(d, { practiceTyre: option.compound })">
                <Tyre :c="option.compound" /> {{ option.newSets ? `${option.newSets} 组新胎` : `旧胎，最少 ${option.leastLaps}L` }}
              </button>
            </div>
            <div class="tiny muted">选择配方后，引擎优先使用该配方的新胎，再使用圈数最少的旧胎。干地练习不能使用半雨胎或全雨胎。</div>
          </div>
          <div class="block">
            <div class="label">调校方向</div>
            <div class="seg wrap">
              <button v-for="[k, label, tip] in setupFocuses" :key="k" :title="tip" :class="{ on: (d.plan.practiceSetupFocus ?? 'balanced') === k }" :disabled="done.practice || store.busy" @click="setPlan(d, { practiceSetupFocus: k })">{{ label }}</button>
            </div>
          </div>
          <div class="block">
            <div class="label">排位方案</div>
            <div class="seg">
              <button v-for="[k, label, tip] in approaches" :key="k" :title="tip" :class="{ on: d.plan.qualiApproach === k }" :disabled="done.qualifying || store.busy" @click="setPlan(d, { qualiApproach: k })">{{ label }}</button>
            </div>
          </div>
          <div v-if="qualifyingPhase" class="block stack-s">
            <div class="label">{{ qualifyingSegmentLabel }} 实体轮胎组</div>
            <div v-if="!qualifyingDriverActive(d)" class="notice tiny">该车手已在上一分段被淘汰，无需为 {{ qualifyingSegmentLabel }} 选择轮胎组。</div>
            <div v-else-if="qualifyingSetOptions(d).length" class="row wrap">
              <label v-for="run in qualifyingRuns" :key="run" class="small row">
                第 {{ run }} 次出场
                <select v-model="qualifyingSelection(d)[run - 1]" :disabled="store.busy">
                  <option v-for="set in qualifyingSetOptions(d)" :key="set.id" :value="set.id">
                    {{ v.labels.tyres[set.compound]?.name ?? set.compound }} · {{ set.id }} · {{ set.state === 'new' ? '新胎' : `${set.laps}L` }}
                  </option>
                </select>
              </label>
            </div>
            <div v-else class="notice warn tiny">没有符合本分段规则的轮胎组。车手仍可参加，但本分段不会取得成绩。</div>
          </div>
          <div v-if="isSprint && d.sprintOptions.length" class="block">
            <div class="label">冲刺赛轮胎</div>
            <div class="seg">
              <button :class="{ on: d.plan.sprintTyre === 'auto' }" :disabled="done.sprint || store.busy" @click="setPlan(d, { sprintTyre: 'auto' })">自动</button>
              <button v-for="o in d.sprintOptions" :key="o.id" :class="{ on: d.plan.sprintTyre === o.compounds[0] }" :disabled="done.sprint || store.busy" @click="setPlan(d, { sprintTyre: o.compounds[0] })">
                <Tyre :c="o.compounds[0]" /> {{ o.delta > 0 ? `+${o.delta}s` : '最快' }}
              </button>
            </div>
          </div>
          <div class="block stack-s">
            <div class="label">正赛策略</div>
            <div class="notice bad small"><b>注意：工程师给的策略不一定靠谱。</b> 选择“听工程师”后，方案会自动应用并在比赛中执行。</div>
            <div v-if="strategyRiskTeam" class="notice warn tiny"><b>高风险提示：</b>当前策略人员的判断或风险偏好不稳定，雨战决策尤其需要谨慎。</div>
            <div class="row wrap">
              <div class="seg">
                <button :class="{ on: (d.plan.strategySource ?? 'player') === 'player' }" :disabled="done.race || store.busy" @click="usePlayerStrategy(d)">玩家自己做策略</button>
                <button :class="{ on: d.plan.strategySource === 'engineer' }" :disabled="done.race || store.busy" @click="askEngineer(d)">听工程师</button>
              </div>
              <select :value="engineerApiFor(d.driverId)" class="small" :disabled="store.busy" @change="engineerApi[d.driverId] = ($event.target as HTMLSelectElement).value as 'main' | 'secondary'">
                <option value="main">主 API</option><option value="secondary">副 API</option>
              </select>
            </div>
            <div class="plans">
              <div v-if="(d.plan.strategySource ?? 'player') === 'player'" class="plan on">
                <span class="badge">玩家</span>
                <span class="small">自定轮胎方案</span>
                <span class="grow stack-s">
                  <span v-for="(compound, index) in customFor(d)" :key="index" class="row wrap" style="gap: 4px">
                    <span class="tiny muted">赛段 {{ index + 1 }}</span>
                    <select :value="compound" :disabled="done.race || store.busy" @change="setCustomCompound(d, index, ($event.target as HTMLSelectElement).value)">
                      <option v-for="c in v.rules.dryCompounds" :key="c" :value="c">{{ v.labels.tyres[c]?.name ?? c }}</option>
                    </select>
                    <select v-model="customSetsFor(d)[index]" :disabled="done.race || store.busy">
                      <option value="">自动选择实体组</option>
                      <option v-for="set in raceSetOptions(d, compound)" :key="set.id" :value="set.id" :disabled="customSetsFor(d).some((id, i) => i !== index && id === set.id)">{{ set.id }} · {{ set.state === 'new' ? '新胎' : `${set.laps}L` }}</option>
                    </select>
                  </span>
                  <span class="row" style="gap: 4px">
                  <button class="small" :disabled="done.race || store.busy || customFor(d).length >= 4" @click="addCustomCompound(d)">＋</button>
                  <button class="small" :disabled="done.race || store.busy || customFor(d).length <= 2" @click="removeCustomCompound(d)">－</button>
                  </span>
                </span>
                <button class="small" :disabled="done.race || store.busy || partialRaceSetSelection(d)" :title="partialRaceSetSelection(d) ? '请为所有赛段选择实体轮胎组，或全部使用自动选择' : ''" @click="applyCustomPlan(d)">采用</button>
              </div>
              <div v-else class="plan engineer-plan on">
                <span v-if="currentStrategyReview(d)" class="badge warn">副 API 点评更正</span>
                <span v-else class="badge">工程师</span>
                <span class="grow stack-s">
                  <b class="small">{{ currentStrategyReview(d) ? '副 API 点评更正的工程师策略已执行' : d.plan.strategySource === 'perfect' ? '完美 AI 策略已自动执行' : '工程师策略已自动执行' }}</b>
                  <span v-if="currentStrategyReview(d)" class="tiny">{{ currentStrategyReview(d)?.summary }}</span>
                  <span v-if="engineerSuggestions[d.driverId]?.explanation" class="tiny">{{ engineerSuggestions[d.driverId].explanation }}</span>
                  <span v-if="engineerSuggestions[d.driverId]?.weatherResponse && !engineerSuggestions[d.driverId]?.explanation?.includes(engineerSuggestions[d.driverId].weatherResponse!)" class="tiny muted">{{ engineerSuggestions[d.driverId].weatherResponse }}</span>
                  <span v-if="!engineerSuggestions[d.driverId]?.explanation && !engineerSuggestions[d.driverId]?.weatherResponse" class="tiny muted">{{ d.plan.strategySource === 'perfect' ? '当前使用已保存的完美策略，不受车队策略人员水平影响。' : '当前使用已保存的工程师方案。建议质量取决于车队策略部门水平。' }}</span>
                </span>
                <span class="engineer-actions">
                  <button v-if="d.plan.strategySource === 'engineer'" class="small review-entry" :disabled="done.race || store.busy" @click="openStrategyReview(d, $event)">策略点评</button>
                  <button class="small" :disabled="done.race || store.busy" @click="askEngineer(d)">重新询问并应用</button>
                </span>
              </div>
            </div>
            <div v-if="d.plan.strategySource !== 'engineer' && d.plan.strategySource !== 'perfect'" class="engineer-actions">
              <button class="small review-entry" :disabled="done.race || store.busy" @click="openStrategyReview(d, $event)">策略点评</button>
              <span class="tiny muted">仅点评当前工程师策略；不会自动修改方案。</span>
            </div>
            <div v-if="d.plan.strategySource === 'perfect'" class="engineer-actions">
              <button class="small review-entry" :disabled="done.race || store.busy" @click="openStrategyReview(d, $event)">策略点评</button>
              <span class="tiny muted">点评只适用于工程师策略，完美策略不会被改写。</span>
            </div>
            <div class="tiny muted row">
              轮胎寿命（悬崖圈数）：
              <span v-for="(life, c) in d.tyreLife" :key="c" class="row" style="gap: 3px"><Tyre :c="String(c)" />{{ life }}</span>
            </div>
          </div>
          <div v-if="(d.plan.strategySource ?? 'player') === 'player'" class="block row">
            <div>
              <div class="label">驾驶模式</div>
              <div class="seg">
                <button v-for="[k, label, tip] in paceModes" :key="k" :title="tip" :class="{ on: d.plan.paceMode === k }" :disabled="done.race || store.busy" @click="setPlan(d, { paceMode: k })">{{ label }}</button>
              </div>
            </div>
            <div>
              <div class="label">进站时机</div>
              <div class="seg">
                <button v-for="[k, label, tip] in timings" :key="k" :title="tip" :class="{ on: d.plan.pitTiming === k }" :disabled="done.race || store.busy" @click="setPlan(d, { pitTiming: k })">{{ label }}</button>
              </div>
            </div>
            <label class="row small" title="出现安全车/VSC 时，若轮胎已用过半则趁机进站">
              <input type="checkbox" :checked="d.plan.scReaction" :disabled="done.race || store.busy" @change="setPlan(d, { scReaction: ($event.target as HTMLInputElement).checked })" />
              安全车时机会进站
            </label>
          </div>
        </div>
      </div>
    </template>

    <div v-if="w && shownResult" class="card stack-s">
      <div class="spread">
        <h3>{{ current ? '本站' : '上一站' }}成绩</h3>
        <div class="seg">
          <button v-for="(_, i) in practiceSessions" :key="`practice-${i}`" :class="{ on: shownResult === 'practice' && shownPracticeIndex === i }" @click="showPracticeResult(i)">练习 {{ i + 1 }}</button>
          <button v-if="w.sprintQualifying" :class="{ on: shownResult === 'sprintQualifying' }" @click="resultTab = 'sprintQualifying'">冲刺排位</button>
          <button v-if="w.sprint" :class="{ on: shownResult === 'sprint' }" @click="resultTab = 'sprint'">冲刺赛</button>
          <button v-if="w.qualifying" :class="{ on: shownResult === 'qualifying' }" @click="resultTab = 'qualifying'">排位</button>
          <button v-if="w.race" :class="{ on: shownResult === 'race' }" @click="resultTab = 'race'">正赛</button>
        </div>
      </div>

      <div v-if="shownResult === 'practice' && shownPractice" class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>车手</th><th>圈速</th><th>轮胎</th><th>圈数</th><th>项目收益</th></tr></thead>
          <tbody>
            <tr v-for="(e, i) in shownPractice.timesheet" :key="e.driverId" :class="{ me: teamOf(e.driverId).mine }">
              <td class="mono">{{ i + 1 }}</td>
              <td><span class="swatch" :style="{ background: teamOf(e.driverId).color }"></span>{{ name(e.driverId) }}</td>
              <td class="mono">{{ lapTime(e.time) }}</td>
              <td><span v-if="e.compound" class="row" style="gap:4px"><Tyre :c="e.compound" />{{ e.tyreStartedNew ? '新胎' : '旧胎' }}</span></td>
              <td class="mono">{{ e.laps }}</td>
              <td class="tiny">
                <template v-if="teamOf(e.driverId).mine && shownPractice.gains[e.driverId]">
                  调校 +{{ shownPractice.gains[e.driverId].setup }} · 轮胎 +{{ shownPractice.gains[e.driverId].tyre }}
                  <template v-if="shownPractice.gains[e.driverId].verified.length"> · 验证 {{ shownPractice.gains[e.driverId].verified.join('、') }}</template>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <template v-if="qualiLike">
        <div class="small muted">{{ qualiLike.weather === 'wet' ? '雨地' : '干地' }} · 杆位 {{ qualiLike.pole ? `${name(qualiLike.pole.driverId)} ${lapTime(qualiLike.pole.time)}` : '—' }}</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>发车</th><th>车手</th><th v-for="s in qualiLike.sessions" :key="s.name">{{ s.name }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(id, i) in qualiLike.grid" :key="id" :class="{ me: teamOf(id).mine }">
                <td class="mono">{{ i + 1 }}<span v-if="qualiLike.order.indexOf(id) !== i" class="tiny muted">（排位 {{ qualiLike.order.indexOf(id) + 1 }}）</span></td>
                <td><span class="swatch" :style="{ background: teamOf(id).color }"></span>{{ name(id) }}</td>
                <td v-for="s in qualiLike.sessions" :key="s.name" class="mono">
                  <template v-for="e in s.entries.filter(x => x.driverId === id)" :key="e.driverId">
                    {{ e.time ? lapTime(e.time) : e.note ?? '无成绩' }}<span v-if="e.eliminated" class="neg tiny"> ✗</span>
                    <span v-if="e.tyreRuns?.length" class="tiny muted"><br /><span v-for="(run, runIndex) in e.tyreRuns" :key="`${runIndex}-${run.setId}`"><Tyre :c="run.compound" />{{ run.startedNew ? '新' : `旧${run.lapsBefore}L` }}<template v-if="runIndex < e.tyreRuns.length - 1"> · </template></span></span>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-for="(e, i) in qualiLike.events" :key="i" class="tiny">· {{ e.text }}</div>
      </template>

      <template v-if="raceLike">
        <div class="small muted">
          {{ raceLike.weather === 'wet' ? '雨战' : '干地' }} · {{ raceLike.laps }} 圈 · 安全车 {{ raceLike.safetyCars }} 次 · 红旗 {{ raceLike.redFlags ?? 0 }} 次
          <template v-if="raceLike.fastestLap"> · 最快圈 {{ name(raceLike.fastestLap.driverId) }} {{ lapTime(raceLike.fastestLap.time) }}</template>
        </div>
        <RainHistoryChart v-if="raceLike.rainHistory?.length" :history="raceLike.rainHistory" />
        <div class="table-wrap">
          <table>
            <thead><tr><th>名次</th><th>车手</th><th>发车</th><th>差距</th><th>进站</th><th>静止时间（预估/实际）</th><th>轮胎</th><th>最快圈</th><th>积分</th></tr></thead>
            <tbody>
              <tr v-for="c in raceLike.classification" :key="c.driverId" :class="{ me: teamOf(c.driverId).mine }">
                <td class="mono">{{ c.pos ?? 'DNF' }}</td>
                <td><span class="swatch" :style="{ background: teamOf(c.driverId).color }"></span>{{ name(c.driverId) }}</td>
                <td class="mono">{{ c.grid }}<span v-if="c.pos" class="tiny" :class="c.grid - c.pos > 0 ? 'pos' : c.grid - c.pos < 0 ? 'neg' : 'muted'">（{{ c.grid - c.pos > 0 ? '+' : '' }}{{ c.grid - c.pos }}）</span></td>
                <td class="mono">{{ c.status === 'dnf' ? c.reason : c.gap }}</td>
                <td class="mono">{{ c.pits }}</td>
                <td class="tiny mono"><span v-for="(stop, i) in c.pitStops" :key="i">{{ stop.predictedStationary.toFixed(1) }}/{{ stop.actualStationary.toFixed(1) }}s{{ stop.slow ? ' !' : '' }}<br /></span><span v-if="!c.pitStops?.length">—</span></td>
                <td><span class="row" style="gap: 2px"><Tyre v-for="(t, i) in c.tyres" :key="i" :c="t" /></span></td>
                <td class="mono">{{ lapTime(c.bestLap) }}</td>
                <td class="mono">{{ c.points || '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <LapChart v-if="chartSeries.length" :series="chartSeries" :max-pos="raceLike.classification.length" />
        <details open>
          <summary class="small muted">比赛事件（{{ raceLike.events.length }}）</summary>
          <div class="events scroll">
            <div v-for="(e, i) in raceLike.events" :key="i" class="tiny" :class="{ key: e.key }">
              <span class="mono muted">L{{ e.lap }}</span> {{ e.text }}
            </div>
          </div>
        </details>
      </template>
    </div>
  </div>
</template>

<style scoped>
.stepper {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.step {
  flex: 1;
  min-width: 80px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}
.tyre-inventory { gap: 4px; }
.tyre-set { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px; border: 1px solid var(--line); border-radius: 4px; cursor: pointer; }
.tyre-set.returned { opacity: .45; text-decoration: line-through; }
.tyre-set.selected { border-color: var(--team); background: color-mix(in srgb, var(--team) 15%, transparent); }
.step .dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg3);
  font-size: 11px;
}
.step.done {
  color: var(--text);
}
.step.done .dot {
  background: var(--green);
  color: #000;
}
.step.on {
  border-color: var(--team);
  color: var(--text);
  font-weight: 600;
}
.step.on .dot {
  background: var(--team);
  color: #fff;
}
.block {
  border-top: 1px dashed var(--line);
  padding-top: 8px;
}
.label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}
.seg.wrap {
  flex-wrap: wrap;
}
.plans {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 4px;
}
.plan {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg);
  cursor: pointer;
}
.plan.on {
  border-color: var(--team);
}
.plan input {
  accent-color: var(--team);
}
.engineer-plan {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
}
.engineer-actions {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.review-entry {
  border-color: color-mix(in srgb, var(--team) 55%, var(--line));
  background: color-mix(in srgb, var(--team) 12%, var(--bg3));
}
.performance-summary {
  padding: 9px 10px;
  border: 1px solid var(--line);
  background: var(--bg);
}
.performance-summary > * + * { border-top: 1px solid var(--line); }
.performance-row {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 3px 8px;
  padding: 6px 0;
  font-size: 12px;
}
.performance-row > :last-child { grid-column: 2; }
.events {
  max-height: 260px;
  margin-top: 6px;
}
.events .key {
  color: var(--text);
}
.events div {
  color: var(--muted);
  padding: 1px 0;
}
.codex-fab {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 35;
  width: 48px;
  height: 48px;
  padding: 10px;
  border-radius: 50%;
  color: #05070b;
  background: #fff;
  border-color: #fff;
  box-shadow: 0 8px 28px #000b;
}
.codex-fab svg, .codex-mark svg { width: 100%; height: 100%; fill: currentColor; }
.perfect-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 18px;
  background: #000b;
  backdrop-filter: blur(4px);
}
.perfect-window {
  width: min(520px, 100%);
  max-height: min(680px, calc(100vh - 36px));
  overflow: auto;
  border-color: #fff6;
  box-shadow: 0 18px 60px #000;
}
.codex-mark {
  display: inline-flex;
  width: 34px;
  height: 34px;
  padding: 7px;
  flex: 0 0 auto;
  color: #05070b;
  background: #fff;
  border-radius: 10px;
}
.perfect-driver { padding: 10px; border: 1px solid var(--line); background: var(--bg); }
@media (max-width: 767px) {
  .codex-fab { right: 12px; bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 12px); }
  .perfect-backdrop { padding: 8px; }
  .perfect-window { max-height: calc(100vh - 16px); }
  .performance-row { grid-template-columns: 68px minmax(0, 1fr); }
  .engineer-actions { grid-column: 1 / -1; }
}
</style>
