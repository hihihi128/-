<script setup lang="ts">
import { computed } from 'vue';
import Bar from '../components/Bar.vue';
import Kpi from '../components/Kpi.vue';
import { act, call, money, pct, store } from '../bridge';

const v = computed(() => store.view!);
const p = computed(() => v.value.player);
const team = computed(() => p.value.team);
const track = computed(() => v.value.round?.track ?? null);
const myDrivers = computed(() => v.value.drivers.filter(d => d.isPlayerTeam && d.slot !== null).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0)));
const ranking = computed(() => [...v.value.teams].filter(t => t.trackScore !== null).sort((a, b) => (b.trackScore ?? 0) - (a.trackScore ?? 0)));
const capPct = computed(() => 1 - p.value.capRemaining / p.value.costCap);
const fr = computed(() => v.value.ferrari);
const mc = computed(() => v.value.mclaren);
const mb = computed(() => v.value.mercedes);
const rb = computed(() => v.value.redBull);
const demandLabels: Record<string, string> = { downforce: '下压力', efficiency: '气动效率', power: '动力', mechanical: '机械抓地' };

function tone(v: number, good = 60, bad = 35): 'ok' | 'warn' | 'bad' {
  return v >= good ? 'ok' : v >= bad ? 'warn' : 'bad';
}
</script>

<template>
  <div class="stack">
    <div class="grid g4">
      <Kpi label="车队积分榜" :value="`P${p.rank}`" :sub="`${p.points} 分 · 榜首 ${p.leaderPoints} 分`" />
      <Kpi label="资金" :value="money(team.funds)" :sub="`年薪支出 ${money(p.annualSalaries)}`" :tone="team.funds < 5 ? 'bad' : ''" />
      <Kpi label="预算帽剩余" :value="money(p.capRemaining)" :sub="`已用 ${pct(capPct)} / ${money(p.costCap)}`" :tone="p.capRemaining < 10 ? 'warn' : ''" />
      <Kpi label="董事会信心" :value="Math.round(team.boardConfidence)" :sub="`目标：车队第 ${team.targetPosition}`" :tone="tone(team.boardConfidence)" />
      <Kpi
        :label="fr ? '媒体支持率' : '媒体声誉'"
        :value="Math.round(team.mediaReputation)"
        :sub="fr ? `低于 ${fr.minMedia} 撤职` : undefined"
        :tone="fr ? (fr.media < fr.minMedia ? 'bad' : fr.media < fr.warnMedia ? 'warn' : 'ok') : ''"
      />
      <Kpi label="员工士气" :value="Math.round(team.staffMorale)" :tone="tone(team.staffMorale)" />
      <Kpi label="风洞/CFD 时长" :value="`${team.aeroHours}h`" sub="每站按排名刷新" />
      <Kpi label="研发槽位" :value="`${p.projects.filter(x => x.kind === 'design').length}/${p.rndSlots}`" sub="进行中的设计项目" />
      <Kpi label="合同市场" :value="v.market.status === 'closed' ? '已关闭' : v.market.status === 'none' ? '未开放' : '开放中'" :sub="v.market.window ? `${v.market.window.targetYear} 阵容规划` : '当前无需操作'" :tone="v.market.status === 'open' ? 'warn' : ''" />
    </div>

    <div v-if="fr" class="card stack-s ferrari">
      <div class="spread">
        <h3>过渡领队考核 · 埃尔坎的两条底线</h3>
        <span v-if="fr.dismissed" class="badge bad">已撤职</span>
        <span v-else-if="fr.graceLeft > 0" class="badge">适应期：还剩 {{ fr.graceLeft }} 站</span>
        <span v-else class="badge warn">考核中</span>
      </div>
      <div v-if="fr.dismissed" class="notice bad small">你已被解除过渡领队职务：{{ fr.dismissed }}。</div>
      <Bar label="媒体支持率" :value="fr.media" :mark="fr.minMedia" :digits="0" color="#dc0000" :hint="`低于 ${fr.minMedia} 撤职，低于 ${fr.warnMedia} 告急`" />
      <Bar v-for="f in fr.fans" :key="f.driverId" :label="`${f.name}粉丝`" :value="f.value" :digits="0" color="#f5c518" />
      <Bar label="粉丝意见差距" :value="fr.gap" :mark="fr.maxFanGap" :digits="0" :color="fr.gap > fr.warnFanGap ? '#ff5a5a' : '#2fbf71'" :hint="`超过 ${fr.maxFanGap} 撤职`" />
      <div class="tiny muted">升级件分配不均、指定优先车手、要求让车、成绩和退赛都会改变两边粉丝的意见。意大利媒体每站都会消耗一点耐心。</div>
      <details v-if="fr.log.length" class="small">
        <summary class="muted">最近变化</summary>
        <div v-for="(l, i) in fr.log" :key="i" class="tiny">{{ l.at }} · {{ l.text }}</div>
      </details>
    </div>

    <div v-if="mc" class="card stack-s special-card">
      <div class="spread"><h3>迈凯伦 · 动力单元软件适配</h3><span class="badge" :class="mc.softwareResolved ? 'ok' : 'warn'">{{ mc.softwareResolved ? '已解决' : `故障风险 ${Math.round(v.specialRules.mclaren.failureChance * 100)}%` }}</span></div>
      <div v-if="mc.softwareResolved" class="notice ok small">适配完成。动力单元异常放电风险已经消失。</div>
      <template v-else-if="mc.route"><Bar label="专项项目进度" :value="100 - mc.weeksLeft / Math.max(1, mc.weeksTotal) * 100" color="#ff8700" :hint="`剩余 ${mc.weeksLeft} 周 · ${mc.route === 'independent' ? '自主适配' : '与梅赛德斯合作'}`" /></template>
      <div v-else class="row"><button class="primary" :disabled="store.busy" @click="act({ type: 'START_MCLAREN_FIX', route: 'independent' })">自主适配（{{ v.specialRules.mclaren.independentWeeks }}周）</button><button :disabled="store.busy" @click="act({ type: 'START_MCLAREN_FIX', route: 'mercedes' })">与梅奔合作（{{ v.specialRules.mclaren.cooperationWeeks }}周）</button></div>
      <div class="tiny muted">合作路线会把车体资料交给梅赛德斯，并提高其技术研发能力。诺里斯与皮亚斯特里缠斗时存在额外碰撞风险。</div>
    </div>

    <div v-if="mb" class="card stack-s special-card">
      <div class="spread"><h3>梅赛德斯 · 接班人考核与政治斗争</h3><span v-if="mb.dismissed" class="badge bad">已撤职</span><span v-else class="badge">压缩比 {{ mb.compressionRatio }}</span></div>
      <Bar label="Toto 满意度" :value="mb.totoSatisfaction" :mark="v.specialRules.mercedes.dismissTotoSatisfaction" :color="mb.totoSatisfaction < 30 ? '#ff5a5a' : '#00a19c'" :hint="`低于 ${v.specialRules.mercedes.dismissTotoSatisfaction} 会被撤职`" />
      <Bar label="政治压力" :value="mb.politicalPressure" :max="120" :mark="v.specialRules.mercedes.banPoliticalPressure" :color="mb.politicalPressure >= 80 ? '#ff5a5a' : '#ffb347'" :hint="`达到 ${v.specialRules.mercedes.banPoliticalPressure} 会失去 1:18 压缩比`" />
      <Bar label="ADUO 审批" :value="mb.aduoProgress" color="#6aa6ff" :hint="mb.aduoApproved ? '已获批准，动力单元故障风险消失' : `批准前每场正赛有 ${Math.round(v.specialRules.mercedes.failureChance * 100)}% 故障风险`" />
      <div class="row"><button :disabled="store.busy || !!mb.dismissed" @click="act({ type: 'MERCEDES_POLITICS', strategy: 'lobby_aduo' })">游说 ADUO</button><button :disabled="store.busy || !!mb.dismissed" @click="act({ type: 'MERCEDES_POLITICS', strategy: 'defend' })">技术辩护</button><button :disabled="store.busy || !!mb.dismissed" @click="act({ type: 'MERCEDES_POLITICS', strategy: 'compromise' })">政治妥协</button></div>
      <div class="tiny muted">每站只能执行一次政治行动。每场正赛后，其他车队都会继续施压。</div>
    </div>

    <div v-if="rb" class="card stack-s special-card">
      <div class="spread"><h3>红牛 · 人才与维斯塔潘危机</h3><span class="badge" :class="(rb.verstappenPosition ?? 99) <= 3 ? 'ok' : 'bad'">维斯塔潘 P{{ rb.verstappenPosition || '-' }}</span></div>
      <Bar label="GP 留任意愿" :value="rb.gpRetention" :color="rb.gpRetention < 25 ? '#ff5a5a' : '#3671c6'" :hint="rb.gpTransferred ? 'GP 已决定转投迈凯伦' : '每场正赛后都会下降'" />
      <button :disabled="store.busy || rb.gpTransferred" @click="act({ type: 'RED_BULL_RETAIN_GP' })">提交 GP 留任方案（{{ v.specialRules.redBull.gpNegotiationCost }}M$）</button>
      <div class="small" :class="rb.verstappenExit ? 'notice bad' : 'notice warn'">{{ rb.verstappenExit ? '维斯塔潘的解约条款已经触发，他已转投梅赛德斯。' : rb.summerChecked ? '夏休检查已通过。' : '夏休时维斯塔潘必须位列车手榜前三。' }}</div>
      <div class="tiny muted">RB23 准备不足会使红牛车手的单车失误概率提高 {{ Math.round((v.specialRules.redBull.mistakeMultiplier - 1) * 100) }}%。</div>
    </div>

    <div class="grid g2">
      <div v-if="track" class="card stack-s">
        <h3>{{ v.round?.name }}</h3>
        <div class="small muted">
          {{ track.name }} · {{ track.type }} · {{ track.laps }} 圈 · 进站损失 {{ track.pitLoss }}s
          <template v-if="v.round?.dateLabel"> · {{ v.round.dateLabel }}</template>
        </div>
        <div v-if="track.description" class="small">{{ track.description }}</div>
        <Bar v-for="(w, k) in track.weights" :key="k" :label="demandLabels[k]" :value="w * 100" :digits="0" color="#6aa6ff" hint="赛道对该属性的需求权重(%)" />
        <Bar label="超车容易度" :value="track.overtaking" :digits="0" color="#9b7bff" />
        <Bar label="轮胎负荷" :value="track.tyreStress" :digits="0" color="#ffb347" />
        <div class="row small">
          <span class="badge">降雨概率 {{ pct(v.weekend?.isCurrent ? v.weekend.forecast.race : track.rainChance) }}</span>
          <span class="badge">安全车倾向 {{ pct(track.scChance) }}</span>
        </div>
      </div>

      <div class="card stack-s">
        <h3>本站赛车性能排名</h3>
        <div v-if="!ranking.length" class="empty">赛季已结束</div>
        <div v-for="(t, i) in ranking" :key="t.id" class="rank-row" :class="{ me: t.isPlayer }">
          <span class="mono muted">{{ i + 1 }}</span>
          <span class="swatch" :style="{ background: t.color }"></span>
          <span class="grow">{{ t.name }}</span>
          <Bar :value="t.trackScore ?? 0" :min="60" :max="100" :color="t.color" style="width: 55%" />
        </div>
        <div class="tiny muted">按赛道需求加权的赛车性能（取车队较快的那台车）。</div>
      </div>
    </div>

    <div class="grid g2">
      <div class="card stack-s">
        <h3>车手</h3>
        <div v-for="d in myDrivers" :key="d.id" class="driver-row">
          <div class="spread">
            <b>#{{ d.number }} {{ d.name }} <span v-if="d.isPriority" class="badge team">优先</span></b>
            <span class="small muted">车手榜 P{{ d.position ?? '-' }} · {{ d.points }} 分</span>
          </div>
          <div class="grid g3 tiny">
            <Bar label="综合" :value="d.overall" :mark="d.potential" hint="白线 = 潜力上限" />
            <Bar label="心态" :value="d.morale" :color="d.morale >= 60 ? 'var(--green)' : d.morale >= 35 ? 'var(--yellow)' : 'var(--red)'" />
            <Bar label="信任" :value="d.trust" color="#6aa6ff" />
          </div>
        </div>
      </div>

      <div class="card stack-s">
        <div class="spread">
          <h3>待 AI 叙述</h3>
          <button v-if="v.narration.length" class="small primary" :disabled="store.busy || !!store.status?.generating" @click="call(a => a.requestNarration())">让 AI 叙述</button>
        </div>
        <div v-if="!v.narration.length" class="tiny muted">暂无。模拟练习赛/排位/正赛、零件交付等事件会进入这里，下一条 AI 回复会把它们写进剧情。</div>
        <div v-for="e in v.narration" :key="e.id" class="small">
          <b>{{ e.title }}</b>
          <div class="muted tiny">{{ e.detail }}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>新闻</h3>
      <div class="news scroll">
        <div v-for="n in v.news" :key="n.id" class="small news-item">
          <span class="badge">{{ n.tag }}</span>
          <span class="tiny muted mono">{{ n.at }}</span>
          {{ n.text }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ferrari {
  border-left: 4px solid #dc0000;
}
.special-card {
  border-left: 4px solid var(--team);
}
.rank-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px;
  border-radius: 6px;
}
.rank-row.me {
  background: color-mix(in srgb, var(--team) 16%, transparent);
}
.driver-row {
  padding: 8px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--line);
}
.news {
  max-height: 220px;
}
.news-item {
  padding: 4px 0;
  border-bottom: 1px dashed var(--line);
}
</style>
