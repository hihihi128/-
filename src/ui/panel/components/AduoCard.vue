<script setup lang="ts">
import { computed } from 'vue';
import type { AduoView } from '../../../engine/view';

const props = defineProps<{ aduo: AduoView }>();
const nextEval = computed(() => (props.aduo.nextEvalRound ? `第 ${props.aduo.nextEvalRound} 站后` : '本赛季评估已完成'));
const maxGap = computed(() => Math.max(...(props.aduo.last?.results.map(row => row.deficitPct) ?? [props.aduo.tier2Deficit]), props.aduo.tier2Deficit));
</script>

<template>
  <section v-if="aduo.enabled" class="card aduo-card stack-s">
    <div class="spread">
      <h3>ADUO 动力单元追赶机制</h3>
      <span class="tier" :class="`t${aduo.tier}`">{{ aduo.tierName }}</span>
    </div>
    <div class="aduo-intro">
      <b>{{ aduo.engine }}</b>
      <span v-if="aduo.isCustomer" class="badge info">客户车队 · 供应商 {{ aduo.supplier }}</span>
      <span v-else class="badge team">厂商车队</span>
    </div>
    <div class="aduo-stats">
      <div><span>认证机会</span><b>{{ aduo.upgradesUsed }}/{{ aduo.upgradesTotal }}</b><small>剩余 {{ aduo.upgradesLeft }} 次 · 首次装车消耗</small></div>
      <div><span>预算帽额度</span><b>+${{ aduo.capBonus.toFixed(1) }}M</b><small>{{ aduo.isCustomer ? '供应商' : '本车队' }}本赛季追加</small></div>
      <div><span>研发周期</span><b>×{{ aduo.weeksMultiplier.toFixed(1) }}</b><small>公开档位对应倍率</small></div>
      <div><span>下次评估</span><b>{{ nextEval }}</b><small>评估站：{{ aduo.evalRounds.map(x => `R${x}`).join(' · ') }}</small></div>
    </div>
    <div v-if="aduo.last" class="manufacturer-table">
      <div class="tiny muted">最近公布评估：{{ aduo.last.round ? `第 ${aduo.last.round} 站后` : '季前基准' }}。仅显示已公布差距。</div>
      <div v-for="row in aduo.last.results" :key="row.engine" class="mfr-row" :class="{ mine: row.isPlayer }">
        <b>{{ row.engine }}</b><span>{{ row.worksTeam || '—' }}</span>
        <span class="gap"><i :style="{ width: `${Math.min(100, row.deficitPct / maxGap * 100)}%` }"></i></span>
        <span>{{ row.deficitPct.toFixed(1) }}%</span><span class="tier" :class="`t${row.tier}`">{{ row.tierName }}</span>
      </div>
    </div>
    <div v-if="aduo.isCustomer" class="notice warn tiny">客户车队不能自行研发动力单元；供应商完成 ADUO 认证后，新规格才会交付。</div>
    <div v-else class="notice tiny">动力单元可先研发和生产。一次 ADUO 机会会在首次装车时认证当前整批待认证规格。</div>
  </section>
</template>

<style scoped>
.aduo-card { overflow: hidden; }.aduo-card h3 { margin-bottom: 0; }.aduo-intro { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }.badge.info { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 45%, transparent); }.aduo-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; border: 1px solid var(--line); background: var(--line); }.aduo-stats div { display: flex; flex-direction: column; gap: 2px; padding: 8px; background: #080a0f; }.aduo-stats span, .aduo-stats small { color: var(--muted); font-size: 11px; }.aduo-stats b { font: italic 800 16px/1.15 var(--font-display); }.manufacturer-table { border-top: 1px solid var(--line); padding-top: 6px; }.mfr-row { display: grid; grid-template-columns: minmax(50px, .8fr) minmax(55px, 1fr) 70px 40px auto; align-items: center; gap: 6px; min-height: 28px; font-size: 11px; }.mfr-row.mine { padding: 0 5px; background: var(--team-soft); }.gap { height: 5px; background: #05060a; border: 1px solid var(--line); transform: skewX(var(--skew)); }.gap i { display: block; height: 100%; background: var(--orange); }.tier { display: inline-flex; align-items: center; justify-content: center; min-height: 19px; padding: 2px 5px; font: italic 800 10px/1 var(--font-display); white-space: nowrap; }.tier.t0 { background: #1b1f29; color: var(--muted); }.tier.t1 { color: var(--yellow); background: color-mix(in srgb, var(--yellow) 16%, #111); }.tier.t2 { color: #160800; background: var(--orange); } @media (max-width: 640px) { .aduo-stats { grid-template-columns: 1fr 1fr; }.mfr-row { grid-template-columns: .9fr 1fr 55px 34px auto; gap: 4px; } }
</style>
