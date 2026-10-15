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
const supernaturalMode = ref(false);
const selectionReason = ref('');
const REASON_MAX = 300;

const difficultyGroups = [
  { id: 'easy', label: '简单车队', hint: '董事会期望与赛车实力接近，压力较小' },
  { id: 'medium', label: '中等车队', hint: '有竞争力，但特殊机制或资源会带来压力' },
  { id: 'hard', label: '困难车队', hint: '目标远超当前实力或面临严重危机' },
] as const;
const teamGroups = computed(() =>
  difficultyGroups
    .map(group => ({ ...group, teams: report.value?.teams.filter(t => (t.selectionDifficulty ?? 'medium') === group.id) ?? [] }))
    .filter(group => group.teams.length),
);

const selectedTeam = computed(() => report.value?.teams.find(t => t.id === teamId.value) ?? null);
const isFerrari = computed(() => selectedTeam.value?.special === 'ferrari');
const special = computed(() => selectedTeam.value?.special ?? '');
const specialLabels: Record<string, string> = {
  ferrari: '过渡领队',
  mclaren: '临时领队',
  mercedes: '接班人计划',
  red_bull: '人手危机',
  aston_martin: '本田振动危机',
  racing_bulls: '红牛临时调用',
  audi: '涡轮与ADUO联盟',
  alpine: '布里亚托利接班人',
  haas: '哈斯—丰田平衡',
  williams: '沃尔斯接班培养',
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
      supernaturalMode: supernaturalMode.value,
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

    <label class="card supernatural-toggle" :class="{ on: supernaturalMode }">
      <input v-model="supernaturalMode" type="checkbox" />
      <span class="toggle-copy grow">
        <span class="spread"><b>允许领队使用超自然能力</b><span class="badge" :class="supernaturalMode ? 'ok' : ''">{{ supernaturalMode ? '本局开启' : '默认关闭' }}</span></span>
        <span class="small muted">开启后可从管理面板手动描述一次干预。调用次数不限，但每次变化都受引擎硬上限约束。</span>
        <span class="tiny muted">普通聊天和“让 AI 叙述”不会自动发动能力。此选项保存到本局，开局后不能切换。</span>
      </span>
    </label>

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
      <div class="team-groups">
        <section v-for="group in teamGroups" :key="group.id" class="team-group" :class="group.id" :data-difficulty="group.id">
          <div class="group-head">
            <b>{{ group.label }}</b>
            <span class="tiny muted">{{ group.hint }} · {{ group.teams.length }} 支</span>
          </div>
          <div class="grid g3">
            <button v-for="t in group.teams" :key="t.id" class="team-card" :class="{ on: teamId === t.id }" :style="{ '--c': t.color }" @click="teamId = t.id">
              <div class="spread">
                <b>{{ t.name }}</b>
                <span class="badge">目标 P{{ t.targetPosition }}</span>
              </div>
              <div class="tiny muted">{{ t.drivers.join(' / ') || '无正式车手' }}</div>
              <div v-if="t.special" class="tiny"><span class="badge warn">特殊机制：{{ specialLabels[t.special] ?? t.special }}</span></div>
              <div v-if="t.description" class="tiny desc">{{ t.description }}</div>
            </button>
          </div>
        </section>
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
        <li>小涡轮结构每场正赛起步提升 {{ report?.specialRules?.ferrari.turboStartGainMin ?? 2 }}–{{ report?.specialRules?.ferrari.turboStartGainMax ?? 4 }} 位；ADUO 升级装车后优势消失。</li>
        <li>首次领队座谈会必定讨论增加 {{ report?.specialRules?.ferrari.turboSpoolSeconds ?? 5 }} 秒起步前起压时间。</li>
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
      <div>玩家协助梅基斯处理人才流失与 RB22 准备不足的问题。</div>
      <ul class="tiny"><li>RB22 准备不足会显著提高车手失误概率。</li><li>GP 正与迈凯伦谈判，需要持续争取留任。</li><li>夏休时维斯塔潘必须位列车手榜前三，否则会触发解约条款。</li></ul>
    </div>
    <div v-else-if="special === 'aston_martin'" class="card notice special-team small stack-s">
      <b>阿斯顿·马丁 · 本田振动危机</b>
      <div>老斯特罗尔撤掉 Jonathan Wheatley，并让玩家与纽维收拾预计垫底的 AMR26。</div>
      <ul class="tiny"><li>首批 ADUO 动力单元到货前，每{{ report?.specialRules?.astonMartin.vibrationInterval ?? 10 }}圈以 {{ Math.round((report?.specialRules?.astonMartin.vibrationRetireChance ?? .25) * 100) }}% 概率触发保护性退赛。</li><li>公开车手安全数据可加速 ADUO，但会激化本田与纽维的矛盾。</li><li>必须兼顾兰斯·斯特罗尔与阿隆索粉丝，并承受西班牙媒体持续施压。</li></ul>
    </div>
    <div v-else-if="special === 'racing_bulls'" class="card notice special-team small stack-s">
      <b>小红牛 · 临时车手调用</b>
      <div>玩家担任副领队，辅佐艾伦·佩尔曼。</div>
      <ul class="tiny"><li>每个比赛周末有 {{ Math.round((report?.specialRules?.racingBulls.recallChance ?? .05) * 100) }}% 概率被红牛调走一名正式车手。</li><li>事件发生后，必须从储备车手中选择一人顶替一站。</li></ul>
    </div>
    <div v-else-if="special === 'audi'" class="card notice special-team small stack-s">
      <b>奥迪 · 涡轮与 ADUO 联盟</b>
      <div>比诺托负责技术，玩家作为副领队处理围场政治。</div>
      <ul class="tiny"><li>修复涡轮前，两台车起步会随机丢失 {{ report?.specialRules?.audi.startDropMin ?? 2 }}–{{ report?.specialRules?.audi.startDropMax ?? 3 }} 个位置。</li><li>可与马丁、梅奔和法拉利组成四队联盟，共同向 FIA 争取 ADUO。</li></ul>
    </div>
    <div v-else-if="special === 'alpine'" class="card notice special-team small stack-s">
      <b>阿尔派 · 布里亚托利的接班人</b>
      <div>玩家在 2026 年初成为副领队。布里亚托利保留研发大方向等关键决定。</div>
      <ul class="tiny"><li>适当偏袒科拉平托，避免其粉丝向玩家和车队施压。</li><li>同时维持加斯利的留队意愿，避免长期偏袒使其离队。</li><li>逐步解决 A526 与全新梅赛德斯动力单元的匹配问题。</li></ul>
    </div>
    <div v-else-if="special === 'haas'" class="card notice special-team small stack-s">
      <b>哈斯 · 共同领队与丰田扩张</b>
      <div>玩家协助事务繁重的小松礼雄，并在吉恩·哈斯与丰田之间维持平衡。</div>
      <ul class="tiny"><li>开局资金与生产能力有限。</li><li>丰田会逐站增加影响力，同时提供更多资金。</li><li>丰田影响力过高后，会直接限制部分研发决定。</li></ul>
    </div>
    <div v-else-if="special === 'williams'" class="card notice special-team small stack-s">
      <b>威廉姆斯 · 2026 全年接班培养</b>
      <div>James Vowles 将在年底返回梅赛德斯。玩家从赛季初开始接受下一任领队培养。</div>
      <ul class="tiny"><li>有限资金无法同时满足所有需求。</li><li>每周可以选择设施、赛车升级或保留现金。</li><li>接班准备度不足会让董事会暂缓正式任命，并延长代理考核。</li></ul>
    </div>
    <div v-else-if="selectedTeam?.id === 'cadillac'" class="card notice special-team small stack-s">
      <b>凯迪拉克 · 从零开始</b>
      <div>新车队通过全球公开招募组建首支 F1 队伍。</div>
      <ul class="tiny"><li>没有额外特殊机制。</li><li>初始赛车性能很差，需要依靠研发、市场和稳定完赛追赶。</li></ul>
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
      <span v-if="supernaturalMode" class="badge warn">超自然人设已开启</span>
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
.team-groups {
  display: grid;
  gap: 12px;
  margin-top: 8px;
}
.team-group {
  --group: var(--yellow);
  border: 2px solid var(--group);
  border-radius: var(--radius);
  padding: 10px;
  background: color-mix(in srgb, var(--group) 6%, transparent);
}
.team-group.easy {
  --group: var(--blue);
}
.team-group.medium {
  --group: var(--yellow);
}
.team-group.hard {
  --group: var(--red);
}
.group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.group-head b {
  color: var(--group);
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
.supernatural-toggle {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
  border-color: #4b315f;
}
.supernatural-toggle.on {
  border-color: var(--purple);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--purple) 35%, transparent);
}
.supernatural-toggle input {
  width: 18px;
  height: 18px;
  margin: 2px 0 0;
  accent-color: var(--purple);
}
.toggle-copy {
  display: grid;
  gap: 4px;
}
</style>
