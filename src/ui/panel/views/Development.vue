<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { act, money, peek, store } from '../bridge';
import CarTopdown from '../components/CarTopdown.vue';
import type { Ambition, FacilityType, PitCrewFocus } from '../../../engine/types';
import type { ProjectPreview } from '../../../engine/development';

const v = computed(() => store.view!);
const p = computed(() => v.value.player);
const team = computed(() => p.value.team);
const developable = computed(() => {
  const seen = new Set<string>();
  return p.value.rndOptions.filter(o => !seen.has(o.partType) && seen.add(o.partType));
});
const partType = ref('');
const ambition = ref<Ambition>('standard');
const rush = ref(false);
const focus = ref(0);
const selectedCar = computed(() => p.value.cars[0]);
const lockedParts = computed(() => (v.value.aduo.isCustomer ? v.value.aduo.developmentParts : []));
const abilityLabels: Record<string, string> = { setup: '调校', communication: '沟通', reaction: '反应', strategy: '策略', weather: '天气', risk: '冒险' };
const pitFocuses: Array<[PitCrewFocus, string]> = [['speed', '速度：降低预计静止时间'], ['consistency', '稳定性：缩小时间波动'], ['error_control', '失误控制：降低慢停概率']];
function staffAbilities(abilities: Record<string, number> | undefined): string {
  return abilities ? Object.entries(abilities).map(([key, value]) => `${abilityLabels[key] ?? key} ${value}`).join(' · ') : '综合能力';
}

watch(
  developable,
  list => {
    if (!partType.value && list.length) partType.value = list[0].partType;
  },
  { immediate: true },
);
watch(
  () => team.value.nextSeasonFocus,
  f => (focus.value = f),
  { immediate: true },
);

const preview = computed<ProjectPreview | null>(() => {
  void store.view; // 依赖刷新
  if (!partType.value) return null;
  return peek(a => a.previewProject(partType.value, ambition.value, rush.value));
});

const kindLabel: Record<string, string> = {
  design: '设计',
  manufacture: '生产',
  facility: '设施',
  pit_training: '训练',
  driver_training: '车手训练',
};

/** 每个零件 × 方案的快速对比表 */
const matrix = computed(() => {
  const rows: Record<string, Record<string, ProjectPreview>> = {};
  for (const o of p.value.rndOptions) (rows[o.partType] ??= {})[o.ambition] = o;
  return rows;
});
</script>

<template>
  <div class="stack">
    <div class="grid g4">
      <div class="card small">研发槽位<br /><b class="mono big">{{ p.projects.filter(x => x.kind === 'design').length }}/{{ p.rndSlots }}</b></div>
      <div class="card small">风洞/CFD 时长<br /><b class="mono big">{{ team.aeroHours }}h</b></div>
      <div class="card small">预算帽剩余<br /><b class="mono big">{{ money(p.capRemaining) }}</b></div>
      <div class="card small">资金<br /><b class="mono big">{{ money(team.funds) }}</b></div>
    </div>

    <div class="card stack-s">
      <h3>进行中的项目</h3>
      <div v-if="!p.projects.length" class="tiny muted">没有进行中的项目。</div>
      <div v-for="pr in p.projects" :key="pr.id" class="project">
        <div class="spread">
          <div>
            <span class="badge">{{ kindLabel[pr.kind] }}</span>
            <b>{{ pr.label }}</b>
            <span v-if="pr.expected" class="tiny muted">预期 +{{ pr.expected[0] }}~+{{ pr.expected[1] }}</span>
          </div>
          <div class="row">
            <span class="tiny muted">剩余 {{ pr.weeksLeft }}/{{ pr.weeksTotal }} 周 · ${{ pr.cost }}M</span>
            <button v-if="pr.kind === 'design'" class="small danger" :disabled="store.busy" title="只回收 30% 现金，预算帽额度不退" @click="act({ type: 'CANCEL_PROJECT', projectId: pr.id })">取消</button>
          </div>
        </div>
        <div class="progress"><div :style="{ width: pr.progress + '%' }"></div></div>
      </div>
    </div>

    <div class="card stack-s">
      <h3>启动新的零件研发</h3>
      <div class="rnd-layout">
        <div class="blueprint-wrap">
          <div class="blueprint-label">{{ team.short }} · 1 号车俯视图</div>
          <CarTopdown
            v-if="selectedCar"
            :parts="selectedCar.parts"
            :projects="p.projects"
            :selected="partType"
            :locked-parts="lockedParts"
            @select="partType = $event"
          />
          <div class="tiny muted">颜色表示相对本车可研发部件的公开性能；待验证部件只使用预估值。虚线表示研发中。</div>
        </div>
        <div class="rnd-controls">
      <div class="row">
        <label class="field">零件
          <select v-model="partType">
            <option v-for="o in developable" :key="o.partType" :value="o.partType">{{ o.partName }}（当前最佳 {{ o.currentBest.toFixed(1) }}）</option>
          </select>
        </label>
        <label class="field">研发方案
          <div class="seg">
            <button v-for="(name, k) in v.labels.ambition" :key="k" :class="{ on: ambition === k }" @click="ambition = k as Ambition">{{ name }}</button>
          </div>
        </label>
        <label class="field">加急
          <div class="seg">
            <button :class="{ on: !rush }" @click="rush = false">正常</button>
            <button :class="{ on: rush }" title="花费 ×1.5，周期 ×0.65，只交付 1 件" @click="rush = true">加急</button>
          </div>
        </label>
      </div>
      <div v-if="preview" class="preview">
        <div class="grid g4 small">
          <div>花费<br /><b class="mono">${{ preview.cost }}M</b></div>
          <div>周期<br /><b class="mono">{{ preview.weeks }} 周</b></div>
          <div>风洞时长<br /><b class="mono">{{ preview.aeroHours }}h</b></div>
          <div>预期提升<br /><b class="mono">+{{ preview.gain[0] }} ~ +{{ preview.gain[1] }}</b></div>
          <div>新件可靠性<br /><b class="mono" :class="preview.relDelta >= 0 ? 'pos' : 'neg'">{{ preview.relDelta >= 0 ? '+' : '' }}{{ preview.relDelta }}</b></div>
          <div>首批交付<br /><b class="mono">{{ preview.units }} 件</b></div>
        </div>
        <div v-for="b in preview.blockers" :key="b" class="notice bad tiny">✗ {{ b }}</div>
        <div class="row" style="justify-content: flex-end">
          <span class="tiny muted">真实收益在开工时就已确定，但要等新件上赛道验证后才会揭晓。激进方案可能出现负收益（关联性问题）。</span>
          <button class="primary" :disabled="!preview.ok || store.busy" @click="act({ type: 'START_PROJECT', partType, ambition, rush })">启动研发</button>
        </div>
      </div>
      <details class="small">
        <summary class="muted">方案对比表</summary>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>零件</th><th v-for="(name, k) in v.labels.ambition" :key="k">{{ name }}（花费/周期/收益）</th></tr>
            </thead>
            <tbody>
              <tr v-for="(row, pt) in matrix" :key="pt">
                <td>{{ v.labels.parts[pt] }}</td>
                <td v-for="(_, k) in v.labels.ambition" :key="k" class="mono tiny" :class="{ muted: !row[k]?.ok }">
                  <template v-if="row[k]">${{ row[k].cost }}M / {{ row[k].weeks }}周 / +{{ row[k].gain[0] }}~{{ row[k].gain[1] }}</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
        </div>
      </div>
    </div>

    <div class="grid g2">
      <div class="card stack-s">
        <h3>设施</h3>
        <div v-for="f in p.facilities" :key="f.id" class="spread fac">
          <div>
            <b>{{ f.name }}</b>
            <div class="pips"><span v-for="n in f.max" :key="n" :class="{ on: n <= f.level }"></span></div>
          </div>
          <div class="row">
            <span v-if="f.level < f.max" class="tiny muted">→ {{ f.preview.nextLevel }} 级：${{ f.preview.cost }}M · {{ f.preview.weeks }} 周</span>
            <button class="small" :disabled="!f.preview.ok || store.busy" :title="f.preview.blockers.join('；')" @click="act({ type: 'UPGRADE_FACILITY', facility: f.id as FacilityType })">升级</button>
          </div>
        </div>
        <div class="tiny muted">风洞 + CFD：空动部件收益更高、波动更小；工厂：研发与生产更快、增加槽位；模拟器：练习赛调校效率、车手训练效果。</div>
      </div>

      <div class="card stack-s">
        <h3>关键员工</h3>
        <table>
          <tbody>
            <tr v-for="s in p.staff" :key="s.role">
              <td>{{ s.label }}</td>
              <td><span class="muted">{{ s.name || '—' }}</span><div class="tiny muted">{{ staffAbilities(s.abilities) }}</div></td>
              <td class="mono">{{ s.skill.toFixed(0) }}</td>
              <td class="mono tiny muted">${{ s.salary }}M/年</td>
            </tr>
          </tbody>
        </table>
        <div class="stack-s">
          <div class="small muted">维修组专项训练（${{ p.pitTraining.speed.cost }}M · {{ p.pitTraining.speed.weeks }} 周）</div>
          <div class="tiny muted">当前：速度 {{ p.team.pitCrewTraining?.speed ?? p.staff.find(s => s.role === 'pitCrew')?.skill }} · 稳定性 {{ p.team.pitCrewTraining?.consistency ?? p.staff.find(s => s.role === 'pitCrew')?.skill }} · 失误控制 {{ p.team.pitCrewTraining?.error_control ?? p.staff.find(s => s.role === 'pitCrew')?.skill }}</div>
          <div class="row wrap">
            <button v-for="focus in pitFocuses" :key="focus[0]" class="small" :disabled="!p.pitTraining[focus[0]].ok || store.busy" :title="p.pitTraining[focus[0]].blockers.join('；') || focus[1]" @click="act({ type: 'TRAIN_PIT_CREW', focus: focus[0] })">
              {{ focus[1] }}
            </button>
          </div>
        </div>
        <div class="stack-s">
          <div class="small">下赛季研发投入：<b class="mono">{{ focus }}%</b> <span class="tiny muted">（新赛季新车额外获得最多 +4 性能）</span></div>
          <input v-model.number="focus" type="range" min="0" max="100" step="5" @change="act({ type: 'SET_NEXT_SEASON_FOCUS', value: focus }, { silent: true })" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.big {
  font-size: 18px;
}
.project {
  padding: 6px 0;
  border-bottom: 1px dashed var(--line);
}
.progress {
  height: 6px;
  border-radius: 3px;
  background: var(--bg);
  margin-top: 4px;
  overflow: hidden;
}
.progress div {
  height: 100%;
  background: var(--team);
}
.preview {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
}
.rnd-layout {
  display: grid;
  grid-template-columns: minmax(260px, 38%) minmax(0, 1fr);
  gap: 14px;
}
.blueprint-wrap {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.blueprint-label {
  color: var(--cyan);
  font: italic 800 12px var(--font-display);
  letter-spacing: .08em;
}
.rnd-controls { min-width: 0; }
.fac {
  padding: 4px 0;
}
.pips {
  display: flex;
  gap: 3px;
  margin-top: 3px;
}
.pips span {
  width: 18px;
  height: 6px;
  border-radius: 2px;
  background: var(--bg3);
}
.pips span.on {
  background: var(--team);
}
input[type='range'] {
  width: 100%;
  accent-color: var(--team);
}
@media (max-width: 640px) {
  .rnd-layout { grid-template-columns: 1fr; }
}
</style>
