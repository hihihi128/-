<script setup lang="ts">
import { computed, ref } from 'vue';
import Bar from '../components/Bar.vue';
import AduoCard from '../components/AduoCard.vue';
import { act, peek, store } from '../bridge';
import type { CarView, PartView, StockView } from '../../../engine/view';

const v = computed(() => store.view!);
const p = computed(() => v.value.player);
const locked = computed(() => {
  const ph = v.value.season.phase;
  if (ph === 'season_end') return '赛季已结束';
  if (v.value.weekend?.isCurrent && v.value.weekend.parcFerme) return '封闭车辆规则生效中：排位赛后至正赛结束前不能换件';
  if (ph === 'race' || ph === 'sprint') return '封闭车辆规则生效中';
  return '';
});
const attrKeys = ['downforce', 'efficiency', 'power', 'mechanical', 'tyre', 'reliability'] as const;
const partTypes = computed(() => Object.keys(v.value.labels.parts));
const orderQty = ref<Record<string, number>>({});

function partLabel(pt: PartView): string {
  if (pt.verified) return `v${pt.version} · ${pt.perf.toFixed(1)}`;
  return pt.expected ? `v${pt.version} · 预估 ${pt.expected[0]}~${pt.expected[1]}` : `v${pt.version}`;
}

/** 某零件类型可选的规格：已装在这台车上的 + 有库存的 */
function options(car: CarView, type: string): StockView[] {
  return p.value.stock.filter(s => s.partType === type && (s.count > 0 || s.fittedOn.includes(car.slot)));
}

/** 动力单元配额（按车手计） */
function puOf(car: CarView) {
  return v.value.drivers.find(d => d.id === car.driverId)?.pu ?? [];
}
function puCell(car: CarView, type: string) {
  return puOf(car).find(x => x.type === type) ?? null;
}

function other(car: CarView): CarView | undefined {
  return p.value.cars.find(c => c.slot !== car.slot);
}

function better(car: CarView, pt: PartView): number {
  const o = other(car)?.parts.find(x => x.type === pt.type);
  return o ? pt.perf - o.perf : 0;
}

async function fit(car: CarView, type: string, specId: string) {
  await act({ type: 'FIT_PART', slot: car.slot, partType: type, specId });
}

function orderPreview(s: StockView) {
  return peek(a => a.previewManufacture(s.partType, s.specId, orderQty.value[s.specId] ?? 1));
}
</script>

<template>
  <div class="stack">
    <div v-if="locked" class="notice warn small">🔒 {{ locked }}</div>
    <div class="notice small">
      每台车独立装件。新研发的零件只有 1~2 件时，由你决定先给哪位车手——两台车差距达到 0.4 分以上时，吃亏的车手会在正赛前表达不满（自尊心越强越明显，若你已指定优先车手则影响减轻）。
      动力单元分成 ICE、涡轮、MGU-K、电池、控制电子和排气六类部件。每类部件都有独立性能、可靠性、磨损、库存、研发和配额；具体配额显示在部件旁，换回用过的旧件不会重复计数。
      动力单元可以先研发和生产。未认证规格不能装车；获得 ADUO 机会后，首次装车会用 1 次机会认证当前整批待认证规格。
      <span v-if="p.allocationGap >= 0.4" class="badge warn">当前两车差距 {{ p.allocationGap }} 分</span>
    </div>

    <AduoCard :aduo="v.aduo" />

    <div class="grid g2">
      <div v-for="car in p.cars" :key="car.slot" class="card stack-s">
        <div class="spread">
          <h3 style="margin: 0">{{ car.slot }} 号车 · {{ car.driverName }}</h3>
          <span class="badge">综合 {{ car.ratings.overall }}</span>
        </div>
        <div v-if="car.trackScore !== null" class="small muted">本站适配：<b class="mono">{{ car.trackScore }}</b></div>
        <Bar v-for="k in attrKeys" :key="k" :label="v.labels.carAttr[k]" :value="car.ratings[k]" :mark="other(car)?.ratings[k] ?? null" hint="白线 = 另一台车" />
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>零件</th><th>当前规格</th><th>可靠性</th><th>更换</th></tr>
            </thead>
            <tbody>
              <tr v-for="pt in car.parts" :key="pt.type">
                <td>
                  {{ pt.name }}
                  <span
                    v-if="puCell(car, pt.type)"
                    class="badge"
                    :class="{ bad: puCell(car, pt.type)!.used > puCell(car, pt.type)!.limit, warn: puCell(car, pt.type)!.used === puCell(car, pt.type)!.limit }"
                    title="本赛季该车手已启用的件数 / 配额。换上没用过的规格或事故后换新件都会计数，超出配额要罚退"
                    >{{ puCell(car, pt.type)!.used }}/{{ puCell(car, pt.type)!.limit }} · 健康 {{ Math.round(puCell(car, pt.type)!.health) }}%</span
                  >
                </td>
                <td>
                  <span class="mono">{{ partLabel(pt) }}</span>
                  <span v-if="!pt.verified" class="badge warn" title="需要练习赛「新件测试」或一场正赛来验证真实性能">待验证</span>
                  <span v-if="better(car, pt) > 0.05" class="badge ok" title="比另一台车的同类零件更好">领先</span>
                </td>
                <td class="mono">{{ pt.rel.toFixed(0) }}</td>
                <td>
                  <select :value="pt.specId" :disabled="!!locked || store.busy || options(car, pt.type).length < 2" @change="fit(car, pt.type, ($event.target as HTMLSelectElement).value)">
                    <option v-for="o in options(car, pt.type)" :key="o.specId" :value="o.specId">
                      v{{ o.version }} {{ o.verified ? o.perf.toFixed(1) : '预估' + (o.expected ? o.expected.join('~') : '') }}{{ o.homologated ? '' : '（待 ADUO 认证）' }}{{ o.count ? `（库存 ${o.count}）` : '' }}
                    </option>
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>零件库存与生产</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>零件</th><th>规格</th><th>性能</th><th>可靠性</th><th>库存</th><th>装车</th><th>追加生产</th></tr>
          </thead>
          <tbody>
            <template v-for="type in partTypes" :key="type">
              <tr v-for="s in p.stock.filter(x => x.partType === type)" :key="s.specId">
                <td>{{ s.partName }}</td>
                <td class="mono">v{{ s.version }}</td>
                <td class="mono">{{ s.verified ? s.perf.toFixed(1) : `预估 ${s.expected?.join('~') ?? '?'}` }}</td>
                <td class="mono">{{ s.rel.toFixed(0) }}</td>
                <td class="mono">{{ s.count }} <span v-if="!s.homologated" class="badge warn">待认证</span></td>
                <td>{{ s.fittedOn.length ? s.fittedOn.map(n => n + '号').join(' ') : '—' }}</td>
                <td>
                  <div class="row">
                    <select :value="orderQty[s.specId] ?? 1" style="width: 60px" @change="orderQty[s.specId] = Number(($event.target as HTMLSelectElement).value)">
                      <option v-for="n in [1, 2, 3]" :key="n" :value="n">×{{ n }}</option>
                    </select>
                    <template v-for="pv in [orderPreview(s)]" :key="'o' + s.specId">
                      <button class="small" :disabled="!pv?.ok || store.busy" :title="pv?.blockers.join('；') || `${pv?.weeks} 周 · $${pv?.cost}M`" @click="act({ type: 'ORDER_UNITS', partType: s.partType, specId: s.specId, qty: orderQty[s.specId] ?? 1 })">
                        下单{{ pv ? ` $${pv.cost}M/${pv.weeks}周` : '' }}
                      </button>
                    </template>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div class="tiny muted">撞车会损毁零件（前翼最常见），没有备件时会被迫换上旧规格，甚至需要紧急赶制。</div>
    </div>
  </div>
</template>
