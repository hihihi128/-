<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { act, money, peek, store } from '../bridge';
import type { ContractOfferTerms, ContractQuote, StaffRole } from '../../../engine/types';

const mode = ref<'drivers' | 'staff'>('drivers');
const selectedId = ref('');
const role = ref<'race' | 'reserve'>('race');
const slot = ref(1);
const staffRole = ref<StaffRole>('technicalDirector');
const salary = ref(0);
const years = ref(1);

const view = computed(() => store.view!);
const market = computed(() => view.value.market);
const window = computed(() => market.value.window);
const staffLabels = computed(() => view.value.labels.staff as Record<string, string>);
const drivers = computed(() => market.value.drivers.filter(d => d.id !== selectedId.value || !!d.id));
const staff = computed(() => market.value.staff);
const selected = computed(() => (mode.value === 'drivers' ? drivers.value : staff.value).find(p => p.id === selectedId.value) ?? null);
const projectedSeats = computed(() => market.value.projected?.raceSeats ?? {});
const projectedStaff = computed(() => market.value.projected?.staff ?? {});
const selectedQuote = computed<ContractQuote | null>(() => {
  if (!window.value || !selected.value) return null;
  const terms: ContractOfferTerms = {
    windowId: window.value.id,
    marketRevision: market.value.revision,
    personId: selected.value.id,
    annualSalary: Number(salary.value),
    years: Number(years.value),
    ...(mode.value === 'drivers'
      ? { role: role.value, ...(role.value === 'race' ? { slot: Number(slot.value), replacePersonId: projectedSeats.value[String(slot.value)] ?? undefined } : {}) }
      : { replacePersonId: projectedStaff.value[staffRole.value] ?? undefined }),
  };
  return peek(api => api.previewContractOffer(terms, mode.value === 'drivers' ? 'driver' : 'staff', mode.value === 'staff' ? staffRole.value : undefined));
});

watch([mode, selected], () => {
  if (!selected.value) return;
  salary.value = selected.value.preference.askingSalary;
  years.value = selected.value.preference.preferredYears;
  if (mode.value === 'staff') staffRole.value = selected.value.role as StaffRole;
}, { immediate: true });
watch(mode, () => { selectedId.value = ''; });

function select(id: string) { selectedId.value = id; }
function name(id: string | null | undefined) { return id ? view.value.drivers.find(d => d.id === id)?.name ?? id : '空缺'; }
function existingStaffName(id: string | null | undefined) {
  if (!id) return '空缺';
  return staff.value.find(s => s.id === id)?.name ?? id;
}
function ownerLabel(teamId: string | null) {
  if (!teamId) return '自由市场';
  return view.value.teams.find(t => t.id === teamId)?.name ?? '已签约';
}
function candidateDetail(person: any): string {
  const abilityLabels: Record<string, string> = { setup: '调校', communication: '沟通', reaction: '反应', strategy: '策略', weather: '天气', risk: '冒险' };
  const abilities = person.abilities ? Object.entries(person.abilities).map(([key, value]) => `${abilityLabels[key] ?? key} ${value}`).join(' · ') : '';
  return mode.value === 'drivers'
    ? `${person.overall} 总评 · ${ownerLabel(person.teamId)}`
    : `${staffLabels.value[person.role] ?? person.role} · 技能 ${person.skill}${abilities ? ` · ${abilities}` : ''}`;
}
async function submitOffer() {
  if (!window.value || !selected.value || !selectedQuote.value) return;
  if (mode.value === 'drivers') {
    await act({ type: 'OFFER_DRIVER_CONTRACT', windowId: window.value.id, marketRevision: market.value.revision, driverId: selected.value.id, annualSalary: Number(salary.value), years: Number(years.value), role: role.value, ...(role.value === 'race' ? { slot: Number(slot.value) } : {}) });
  } else {
    await act({ type: 'OFFER_STAFF_CONTRACT', windowId: window.value.id, marketRevision: market.value.revision, candidateId: selected.value.id, role: staffRole.value, annualSalary: Number(salary.value), years: Number(years.value) });
  }
}
async function release(kind: 'driver' | 'staff', id: string) {
  if (!window.value) return;
  await act({ type: 'RELEASE_PERSON', windowId: window.value.id, marketRevision: market.value.revision, personKind: kind, personId: id });
}
</script>

<template>
  <section v-if="window" class="market stack" aria-label="合同市场">
    <div class="card market-head">
      <div>
        <h3>合同市场 · {{ window.targetYear }}</h3>
        <div class="small muted">协议锁定预计阵容；当前赛季阵容不会被更改。报价由公开规则即时复核。</div>
      </div>
      <div class="row">
        <span class="badge" :class="window.aiResolved ? 'ok' : 'warn'">{{ window.aiResolved ? '其他车队已处理' : '等待 AI 车队处理' }}</span>
        <button v-if="!window.aiResolved" class="small" :disabled="store.busy" @click="act({ type: 'RESOLVE_AI_MARKET', windowId: window.id, marketRevision: market.revision })">处理其他车队</button>
        <button v-else-if="!market.closeBlockers.length && view.season.phase === 'preseason'" class="primary small" :disabled="store.busy" @click="act({ type: 'START_SEASON' })">确认阵容并关闭市场</button>
      </div>
    </div>

    <div v-if="market.closeBlockers.length" class="notice warn small">
      <b>关闭市场前仍需处理：</b> {{ market.closeBlockers.join('；') }}
    </div>

    <div class="market-tabs seg">
      <button :class="{ on: mode === 'drivers' }" @click="mode = 'drivers'">车手市场</button>
      <button :class="{ on: mode === 'staff' }" @click="mode = 'staff'">员工招聘</button>
    </div>

    <div class="market-grid">
      <div class="card candidates">
        <div class="spread"><h3>{{ mode === 'drivers' ? '候选车手' : '候选员工' }}</h3><span class="tiny muted">只显示公开合同需求</span></div>
        <div class="candidate-list">
          <button v-for="p in mode === 'drivers' ? drivers : staff" :key="p.id" class="candidate" :class="{ selected: selectedId === p.id }" @click="select(p.id)">
            <span><b>{{ p.name }}</b><small>{{ candidateDetail(p) }}</small></span>
            <span class="mono">{{ money(p.preference.askingSalary) }}/年</span>
          </button>
          <div v-if="!(mode === 'drivers' ? drivers : staff).length" class="empty">没有符合当前岗位的公开候选人。</div>
        </div>
      </div>

      <div class="card offer">
        <template v-if="selected">
          <div class="spread"><div><h3>{{ selected.name }}</h3><div class="tiny muted">要求 {{ money(selected.preference.askingSalary) }}/年 · 倾向 {{ selected.preference.preferredYears }} 年</div></div><span class="badge">公开实力目标 {{ selected.preference.desiredStrength }}</span></div>
          <div class="form-grid">
            <label class="field">年薪（M）<input v-model.number="salary" type="number" min="0" step="0.01" /></label>
            <label class="field">年限<select v-model.number="years"><option v-for="n in 4" :key="n" :value="n">{{ n }} 年</option></select></label>
            <template v-if="mode === 'drivers'">
              <label class="field">岗位<select v-model="role"><option value="race">正式车手</option><option value="reserve">替补车手</option></select></label>
              <label v-if="role === 'race'" class="field">车位<select v-model.number="slot"><option v-for="(_, key) in projectedSeats" :key="key" :value="Number(key)">{{ key }} 号车 · {{ name(projectedSeats[key]) }}</option></select></label>
            </template>
            <label v-else class="field">岗位<select v-model="staffRole"><option v-for="(_, key) in projectedStaff" :key="key" :value="key">{{ staffLabels[key] ?? key }} · {{ existingStaffName(projectedStaff[key]) }}</option></select></label>
          </div>

          <div v-if="selectedQuote" class="quote" :class="selectedQuote.candidateDecision === 'accept' && !selectedQuote.blockers.length ? 'accept' : 'reject'">
            <div class="spread"><b>当前报价：{{ selectedQuote.candidateDecision === 'accept' ? '接受' : '拒绝' }}</b><span class="mono">{{ selectedQuote.score.toFixed(1) }} / {{ selectedQuote.threshold }}</span></div>
            <div class="factor-grid"><span v-for="(factor, key) in selectedQuote.factors" :key="key">{{ key }} <b :class="factor >= 0 ? 'pos' : 'neg'">{{ factor >= 0 ? '+' : '' }}{{ factor }}</b></span></div>
            <div class="small muted">立即费用 {{ money(selectedQuote.cashDueNow) }}（买断 {{ money(selectedQuote.buyout) }} · 解约 {{ money(selectedQuote.severance) }}）· 预计年工资 {{ money(selectedQuote.annualPayrollAfter) }}</div>
            <div v-if="selectedQuote.blockers.length" class="tiny neg">{{ selectedQuote.blockers.join('；') }}</div>
          </div>
          <button class="primary offer-button" :disabled="store.busy || !selectedQuote || selectedQuote.candidateDecision !== 'accept' || !!selectedQuote.blockers.length" @click="submitOffer">确认有约束力的报价</button>
        </template>
        <div v-else class="empty">选择候选人以配置报价。确认前不会改变存档。</div>
      </div>
    </div>

    <div class="card roster">
      <h3>本队预计阵容</h3>
      <div class="roster-grid">
        <div><b>正式车位</b><div v-for="(id, key) in projectedSeats" :key="key" class="roster-row">{{ key }} 号车 · {{ name(id) }}<button v-if="id" class="danger small" :disabled="store.busy" @click="release('driver', id)">解约</button></div></div>
        <div><b>员工岗位</b><div v-for="(id, key) in projectedStaff" :key="key" class="roster-row">{{ staffLabels[key] ?? key }} · {{ existingStaffName(id) }}<button v-if="id" class="danger small" :disabled="store.busy" @click="release('staff', id)">解约</button></div></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.market-head,.market-grid,.roster-grid,.form-grid,.factor-grid { display:grid; gap:12px; }.market-head { grid-template-columns:minmax(0,1fr) auto; align-items:center; }.market-grid { grid-template-columns:minmax(0,1fr) minmax(330px,.9fr); }.candidate-list { max-height:390px; overflow:auto; margin-top:8px; }.candidate { width:100%; display:flex; justify-content:space-between; align-items:center; gap:10px; text-align:left; border-radius:0; border-width:0 0 1px; padding:10px 6px; }.candidate.selected { background:var(--team-soft); border-left:3px solid var(--team); }.candidate small,.candidate b { display:block; }.candidate small { color:var(--muted); font-size:11px; margin-top:2px; }.form-grid { grid-template-columns:repeat(2,minmax(0,1fr)); margin:14px 0; }.quote { border:1px solid var(--line); border-left:3px solid var(--yellow); padding:10px; background:var(--bg); }.quote.accept { border-left-color:var(--green); }.quote.reject { border-left-color:var(--neg); }.factor-grid { grid-template-columns:repeat(3,minmax(0,1fr)); margin:8px 0; font-size:11px; color:var(--muted); }.factor-grid b { display:block; }.offer-button { margin-top:12px; width:100%; }.roster-grid { grid-template-columns:1fr 1fr; }.roster-row { min-height:30px; display:flex; align-items:center; justify-content:space-between; gap:8px; border-bottom:1px solid var(--line); font-size:12px; }.market-tabs { width:max-content; }.market-tabs button { min-width:105px; }
@media (max-width:640px) { .market-head,.market-grid,.roster-grid { grid-template-columns:1fr; }.market-head .row { justify-content:space-between; }.candidate-list { max-height:235px; }.form-grid { gap:8px; }.factor-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }.offer { position:relative; }.offer-button { position:sticky; bottom:calc(var(--tabbar-h) + 10px); z-index:2; box-shadow:0 6px 16px #000; }.market-tabs { width:100%; }.market-tabs button { flex:1; } }
</style>
