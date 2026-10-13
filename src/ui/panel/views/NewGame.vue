<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DataReport } from '../../../tavern/controller';
import { call, store, toast } from '../bridge';

const report = ref<DataReport | null>(null);
const loading = ref(false);
const teamId = ref('');
const principal = ref('');
const difficulty = ref<'easy' | 'normal' | 'hard'>('normal');
const randomness = ref<'deterministic' | 'fresh'>('deterministic');
const selectionReason = ref('');
const REASON_MAX = 300;

const selectedTeam = computed(() => report.value?.teams.find(t => t.id === teamId.value) ?? null);
const isFerrari = computed(() => selectedTeam.value?.special === 'ferrari');
const special = computed(() => selectedTeam.value?.special ?? '');
const specialLabels: Record<string, string> = {
  ferrari: '过渡领队',
  mclaren: '临时领队',
  mercedes: '接班人计划',
  red_bull: '人手危机',
};

const errors = computed(() => report.value?.issues.filter(i => i.level === 'error') ?? []);
const warnings = computed(() => report.value?.issues.filter(i => i.level === 'warning') ?? []);

async function load() {
  loading.value = true;
  report.value = await call(a => a.loadData(), false);
  loading.value = false;
  if (report.value?.teams.length && !teamId.value) teamId.value = report.value.teams[report.value.teams.length - 1].id;
  if (!principal.value) principal.value = store.status?.userName ?? '';
}

async function start() {
  if (!teamId.value) return toast('err', '请先选择车队');
  if (store.view && !confirm('重新开局会清空本聊天的存档历史（聊天消息不会删除），确定吗？')) return;
  const r = await call(a =>
    a.newGame({
      playerTeamId: teamId.value,
      principalName: principal.value,
      difficulty: difficulty.value,
      randomness: randomness.value,
      selectionReason: selectionReason.value,
    }),
  );
  if (r?.ok) {
    store.forceNewGame = false;
    store.tab = 'overview';
  }
}

onMounted(load);
</script>

<template>
  <div class="newgame scroll">
    <div class="hero">
      <div class="stripe"></div>
      <div class="spread">
        <h2>F1 领队模拟器 · 新赛季</h2>
        <button v-if="store.view" class="small" @click="store.forceNewGame = false">返回当前存档</button>
      </div>
      <p class="muted small">选择你要执掌的车队。数据来自角色卡世界书中名字以「[F1M数据]」开头的条目，可随时修改后点击「重新读取」。</p>
    </div>

    <div class="card notice bad strategy-warning">
      <b>重要提醒：工程师给的策略不一定靠谱。</b>
      <span class="small">选择“听工程师”后，工程师方案会自动应用并在比赛中执行。</span>
    </div>
    <div v-if="['ferrari', 'mclaren', 'aston_martin'].includes(teamId)" class="card notice warn small">
      <b>高风险提示：</b>该车队策略部门历史表现不稳定，雨战判断尤其需要谨慎。
    </div>

    <div class="card stack-s">
      <div class="spread">
        <h3>数据检查</h3>
        <button class="small" :disabled="loading" @click="load">{{ loading ? '读取中…' : '重新读取' }}</button>
      </div>
      <template v-if="report">
        <div class="small">
          来源：{{ report.origin }} · {{ report.summary }}
          <span v-if="report.ok" class="badge ok">可以开局</span>
          <span v-else class="badge bad">有错误</span>
        </div>
        <div v-if="report.entries.length" class="tiny muted">条目：{{ report.entries.join('、') }}</div>
        <div v-for="(e, i) in errors" :key="'e' + i" class="notice bad small">✗ [{{ e.source }}] {{ e.path }} {{ e.message }}</div>
        <details v-if="warnings.length" class="small">
          <summary class="muted">{{ warnings.length }} 条提示（不影响开局）</summary>
          <div v-for="(w, i) in warnings" :key="'w' + i" class="tiny muted">· [{{ w.source }}] {{ w.path }} {{ w.message }}</div>
        </details>
      </template>
    </div>

    <div v-if="report?.teams.length" class="card">
      <h3>选择车队</h3>
      <div class="grid g3">
        <button v-for="t in report.teams" :key="t.id" class="team-card" :class="{ on: teamId === t.id }" :style="{ '--c': t.color }" @click="teamId = t.id">
          <div class="spread">
            <b>{{ t.name }}</b>
            <span class="badge">目标 P{{ t.targetPosition }}</span>
          </div>
          <div class="tiny muted">{{ t.drivers.join(' / ') || '无正式车手' }}</div>
          <div v-if="t.special" class="tiny"><span class="badge warn">特殊机制：{{ specialLabels[t.special] ?? t.special }}</span></div>
          <div v-if="t.description" class="tiny desc">{{ t.description }}</div>
        </button>
      </div>
    </div>

    <div v-if="isFerrari" class="card notice ferrari small stack-s">
      <b>法拉利 · 过渡领队</b>
      <div>
        2025 年底，瓜尔蒂耶里主导的钢制气缸盖发动机方案失败，SF-25 赛季惨淡，埃尔坎解除了瓦塞尔的领队职务。内部继任人选还要考察，2026 年是过渡年——你是从外部请来的过渡领队。
      </div>
      <ul class="tiny">
        <li>稳住媒体：<b>媒体支持率</b>过低会被撤职。</li>
        <li>平衡粉丝：<b>汉密尔顿粉丝</b>与<b>勒克莱尔粉丝</b>的意见差距过大会被撤职。</li>
        <li>升级件分配、优先车手、车队指令和比赛成绩都会影响两边粉丝。</li>
      </ul>
    </div>

    <div v-else-if="special === 'mclaren'" class="card notice special-team small stack-s">
      <b>迈凯伦 · 临时领队</b>
      <div>斯特拉因交通事故至少休养一年。扎克·布朗任命玩家临时执掌车队。</div>
      <ul class="tiny"><li>软件适配完成前，每场正赛有 1/5 概率发生动力单元异常。</li><li>自主适配较慢；与梅赛德斯合作较快，但会共享车体资料并强化对手。</li><li>诺里斯与皮亚斯特里缠斗时，诺里斯约有 1/20 概率引发队友碰撞。</li></ul>
    </div>
    <div v-else-if="special === 'mercedes'" class="card notice special-team small stack-s">
      <b>梅赛德斯 · Toto 的接班人计划</b>
      <div>玩家以副领队身份接受 Toto Wolff 的考核。</div>
      <ul class="tiny"><li>获得 ADUO 前，每场正赛有 1/7 概率发生动力单元故障。</li><li>政治压力过高会使 FIA 禁止 1:18 热态压缩比方案。</li><li>Toto 满意度过低会直接导致撤职。</li></ul>
    </div>
    <div v-else-if="special === 'red_bull'" class="card notice special-team small stack-s">
      <b>红牛 · 人手危机</b>
      <div>玩家协助梅基斯处理人才流失与 RB23 准备不足的问题。</div>
      <ul class="tiny"><li>RB23 准备不足会显著提高车手失误概率。</li><li>GP 正与迈凯伦谈判，需要持续争取留任。</li><li>夏休时维斯塔潘必须位列车手榜前三，否则会触发解约条款。</li></ul>
    </div>

    <div class="card stack-s">
      <label class="field">
        你为什么被选中？（可选）
        <textarea
          v-model="selectionReason"
          rows="3"
          :maxlength="REASON_MAX"
          :placeholder="special ? '例如：擅长危机管理、技术协调与车手关系……' : '例如：在青训体系里带出过多位冠军……留空也可以'"
        ></textarea>
      </label>
      <div class="tiny muted spread">
        <span>会写进开场叙事和 AI 的背景资料。留空则由 AI 自由发挥。</span>
        <span class="num">{{ selectionReason.length }}/{{ REASON_MAX }}</span>
      </div>
    </div>

    <div class="card grid g3">
      <label class="field">领队名字<input v-model="principal" type="text" placeholder="默认使用你的用户名" /></label>
      <label class="field">
        难度（影响 AI 车队研发效率）
        <div class="seg">
          <button :class="{ on: difficulty === 'easy' }" @click="difficulty = 'easy'">轻松</button>
          <button :class="{ on: difficulty === 'normal' }" @click="difficulty = 'normal'">标准</button>
          <button :class="{ on: difficulty === 'hard' }" @click="difficulty = 'hard'">困难</button>
        </div>
      </label>
      <label class="field">
        随机性
        <div class="seg">
          <button :class="{ on: randomness === 'deterministic' }" title="回滚后用同样的决策会得到同样结果" @click="randomness = 'deterministic'">可复现</button>
          <button :class="{ on: randomness === 'fresh' }" title="每次模拟都重新随机" @click="randomness = 'fresh'">每次重抽</button>
        </div>
      </label>
    </div>

    <div class="row" style="justify-content: flex-end">
      <span v-if="store.status && store.status.latestFloor > 0" class="tiny muted">存档会挂在当前最新楼层（#{{ store.status.latestFloor }}）</span>
      <button class="primary" :disabled="!report?.ok || !teamId || store.busy" @click="start">开始执掌车队</button>
    </div>
  </div>
</template>

<style scoped>
.newgame {
  height: 100%;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hero {
  position: relative;
  padding: 18px 16px 14px;
  border-radius: var(--radius);
  background: linear-gradient(120deg, #1b1e26, #121419);
  border: 1px solid var(--line);
  overflow: hidden;
}
.stripe {
  position: absolute;
  inset: 0 auto 0 0;
  width: 6px;
  background: var(--red);
}
.team-card {
  text-align: left;
  border-left: 4px solid var(--c);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.team-card.on {
  outline: 2px solid var(--c);
  background: color-mix(in srgb, var(--c) 12%, var(--bg3));
}
.desc {
  color: #b9bfcc;
}
.notice.ferrari {
  border-left: 4px solid #dc0000;
}
.notice.ferrari ul {
  margin: 0;
  padding-left: 18px;
}
.notice.special-team {
  border-left: 4px solid var(--team);
}
.notice.special-team ul {
  margin: 0;
  padding-left: 18px;
}
.strategy-warning {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-left: 6px solid var(--red);
}
</style>
