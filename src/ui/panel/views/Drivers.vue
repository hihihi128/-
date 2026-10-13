<script setup lang="ts">
import { computed, ref } from 'vue';
import Bar from '../components/Bar.vue';
import MarketDesk from '../components/MarketDesk.vue';
import { act, peek, signed, store } from '../bridge';
import type { DriverAttr } from '../../../engine/types';

const v = computed(() => store.view!);
const team = computed(() => v.value.player.team);
const mine = computed(() =>
  v.value.drivers.filter(d => d.teamId === team.value.id).sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99) || a.number - b.number),
);
const racing = computed(() => mine.value.filter(d => d.slot !== null));
const reserves = computed(() => mine.value.filter(d => d.slot === null));
const attrs = computed(() => Object.entries(v.value.labels.driverAttr) as Array<[DriverAttr, string]>);
const trainAttr = ref<Record<string, DriverAttr>>({});
const swapTarget = ref<Record<string, number>>({});
const canSwap = computed(() => ['preseason', 'pre_race', 'post_race'].includes(v.value.season.phase));
const driverPage = ref<'team' | 'market'>('team');

function trainPreview(id: string) {
  const attr = trainAttr.value[id] ?? 'pace';
  return peek(a => a.previewDriverTraining(id, attr));
}

function projectOf(id: string) {
  return v.value.player.projects.find(p => p.kind === 'driver_training' && p.driverId === id);
}

async function setPriority(id: string | null) {
  await act({ type: 'SET_PRIORITY', driverId: id });
}
</script>

<template>
  <div class="stack">
    <div v-if="v.market.window" class="seg roster-tabs">
      <button :class="{ on: driverPage === 'team' }" @click="driverPage = 'team'">本队阵容</button>
      <button :class="{ on: driverPage === 'market' }" @click="driverPage = 'market'">车手市场 / 员工招聘</button>
    </div>
    <MarketDesk v-if="driverPage === 'market' && v.market.window" />
    <template v-else>
    <div class="card stack-s">
      <h3>车队优先级</h3>
      <div class="small muted">
        指定优先车手后：升级件默认先给他、车队指令更容易偏向他；他的心态与信任上升，队友（尤其自尊心强的）会不满。每周只能调整一次。
      </div>
      <div class="row">
        <div class="seg">
          <button :class="{ on: !team.driverPriority }" :disabled="store.busy" @click="setPriority(null)">平等对待</button>
          <button v-for="d in racing" :key="d.id" :class="{ on: team.driverPriority === d.id }" :disabled="store.busy" @click="setPriority(d.id)">
            {{ d.name }}
          </button>
        </div>
        <span v-if="v.player.allocationGap >= 0.4" class="badge warn">两台车性能差 {{ v.player.allocationGap }} 分</span>
      </div>
    </div>

    <div class="grid g2">
      <div v-for="d in [...racing, ...reserves]" :key="d.id" class="card stack-s">
        <div class="spread">
          <div>
            <h3 style="margin: 0">#{{ d.number }} {{ d.name }}</h3>
            <div class="tiny muted">
              {{ d.nationality }} · {{ d.age }} 岁 · {{ d.slot ? `${d.slot} 号车` : '替补' }} · 年薪 ${{ d.salary }}M · 合同至 {{ d.contractEnd || '—' }}
            </div>
          </div>
          <div class="row">
            <span v-if="d.isPriority" class="badge team">优先车手</span>
            <span class="badge">车手榜 P{{ d.position ?? '-' }} · {{ d.points }} 分</span>
          </div>
        </div>
        <div v-if="d.traits.length" class="row">
          <span v-for="t in d.traits" :key="t" class="badge">{{ t }}</span>
        </div>
        <div v-if="d.description" class="tiny muted">{{ d.description }}</div>
        <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 6px 14px">
          <Bar v-for="[k, label] in attrs" :key="k" :label="label" :value="d.attrs[k]" />
        </div>
        <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 6px 14px">
          <Bar label="综合" :value="d.overall" :mark="d.potential" hint="白线 = 潜力上限" color="#c8ccd6" />
          <Bar label="心态" :value="d.morale" :color="d.morale >= 60 ? 'var(--green)' : d.morale >= 35 ? 'var(--yellow)' : 'var(--red)'" />
          <Bar label="信任" :value="d.trust" color="#6aa6ff" hint="对你（领队）的信任，影响是否服从车队指令" />
          <Bar label="体能" :value="d.fitness" color="#4fd1c5" />
          <Bar label="自尊心" :value="d.ego" color="#b58cff" hint="越高越在意升级件分配与车队指令" />
          <div class="small">状态 <b :class="d.form >= 0 ? 'pos' : 'neg'">{{ signed(d.form) }}</b> · {{ d.moraleLabel }}</div>
        </div>

        <div class="sub stack-s">
          <div class="small"><b>模拟器训练</b> <span class="muted tiny">（把资源投给谁，车手心里有数：被训练者心态 +2）</span></div>
          <div v-if="projectOf(d.id)" class="small">训练中：{{ projectOf(d.id)!.label }}（剩余 {{ projectOf(d.id)!.weeksLeft }} 周）</div>
          <div v-else class="row">
            <select :value="trainAttr[d.id] ?? 'pace'" @change="trainAttr[d.id] = ($event.target as HTMLSelectElement).value as DriverAttr">
              <option v-for="[k, label] in attrs" :key="k" :value="k">{{ label }}</option>
            </select>
            <template v-for="pv in [trainPreview(d.id)]" :key="'pv' + d.id">
              <span v-if="pv" class="tiny muted">{{ pv.weeks }} 周 · ${{ pv.cost }}M · 预计 +{{ pv.gain }}</span>
              <button class="small" :disabled="!pv?.ok || store.busy" :title="pv?.blockers.join('；')" @click="act({ type: 'TRAIN_DRIVER', driverId: d.id, attr: trainAttr[d.id] ?? 'pace' })">开始训练</button>
            </template>
          </div>
        </div>

        <div v-if="!d.slot && racing.length" class="sub row">
          <span class="small">换上赛车：</span>
          <select v-model="swapTarget[d.id]">
            <option v-for="r in racing" :key="r.id" :value="r.slot">{{ r.slot }} 号车（替换 {{ r.name }}）</option>
          </select>
          <button class="small" :disabled="!canSwap || !swapTarget[d.id] || store.busy" :title="canSwap ? '' : '只能在比赛周末之外更换车手'" @click="act({ type: 'SWAP_DRIVER', slot: swapTarget[d.id], driverId: d.id })">
            确认换人
          </button>
        </div>
      </div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.sub {
  border-top: 1px dashed var(--line);
  padding-top: 8px;
}
</style>
