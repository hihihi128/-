<script setup lang="ts">
import { computed, ref } from 'vue';
import { FIA_ISSUE_LABELS } from '../../../engine/defaults';
import type { Action } from '../../../engine/types';
import Bar from '../components/Bar.vue';
import Kpi from '../components/Kpi.vue';
import NegotiationPanel from '../components/NegotiationPanel.vue';
import RandomEventPanel from '../components/RandomEventPanel.vue';
import SpecialActionDialog from '../components/SpecialActionDialog.vue';
import { call, money, pct, store } from '../bridge';

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
const am = computed(() => v.value.astonMartin);
const vcarb = computed(() => v.value.racingBulls);
const au = computed(() => v.value.audi);
const alpine = computed(() => v.value.alpine);
const haas = computed(() => v.value.haas);
const williams = computed(() => v.value.williams);
const fia = computed(() => v.value.fiaMeeting);
const fiaIssue: Record<string, string> = FIA_ISSUE_LABELS;
const driverLabel = (id?: string) => v.value.drivers.find((driver: any) => driver.id === id)?.name ?? id ?? '-';
const teamLabel = (id?: string) => v.value.teams.find((team: any) => team.id === id)?.name ?? id ?? '-';
const demandLabels: Record<string, string> = { downforce: '下压力', efficiency: '气动效率', power: '动力', mechanical: '机械抓地' };
const activeNegotiation = computed(() => store.negotiation?.status === 'active' ? store.negotiation : null);
const negotiationActiveFor = (kind: string) => activeNegotiation.value?.kind === kind;
const specialAction = ref<{ action: Action; title: string; subject?: string; hint: string } | null>(null);
const specialActionBlocked = computed(() => store.busy || !!store.status?.generating || !!specialAction.value);
const overviewRoot = ref<HTMLElement | null>(null);
const fiaStanceLabel: Record<string, string> = { support: '支持议题', oppose: '反对议题', compromise: '提出折中' };

function openSpecialAction(action: Action, title: string, hint: string, subject?: string): void {
  specialAction.value = { action, title, hint, subject };
}

async function cancelActiveNegotiation() {
  const result = await call(api => api.cancelSpecialNegotiation());
  if (result) store.negotiation = result.session;
}

function tone(v: number, good = 60, bad = 35): 'ok' | 'warn' | 'bad' {
  return v >= good ? 'ok' : v >= bad ? 'warn' : 'bad';
}
</script>

<template>
  <div ref="overviewRoot" class="stack" tabindex="-1">
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

    <div v-if="activeNegotiation" class="notice warn spread small">
      <span>正在进行：{{ activeNegotiation.title }}（{{ activeNegotiation.round }}/{{ activeNegotiation.maxRounds }} 轮）</span>
      <button class="small" :disabled="store.busy" @click="cancelActiveNegotiation">取消当前谈判</button>
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
      <div class="notice small" :class="fr.turboAdvantageActive ? 'ok' : 'warn'">
        {{ fr.turboAdvantageActive ? `小涡轮起步优势生效：每场正赛提升 ${fr.turboStartGainMin}–${fr.turboStartGainMax} 位。` : fr.turboSpoolSeconds > 0 ? `FIA 已增加 ${fr.turboSpoolSeconds} 秒起压时间，起步优势消失。` : 'ADUO 升级已装车，小涡轮起步优势消失。' }}
      </div>
      <div class="small">ADUO 四队联盟：<b>{{ fr.aduoAlliance ? '已加入' : '未加入' }}</b> · FIA 额外机会：<b>{{ fr.aduoLobbyGranted ? '已获得' : '尚未获得' }}</b></div>
      <NegotiationPanel v-if="!fr.aduoAlliance" kind="aduo_alliance" />
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
      <div v-else class="row"><button class="primary" :disabled="specialActionBlocked" @click="openSpecialAction({ type: 'START_MCLAREN_FIX', route: 'independent' }, '启动自主适配', `预计需要 ${v.specialRules.mclaren.independentWeeks} 周完成动力单元软件适配。`, '迈凯伦动力单元软件')">自主适配（{{ v.specialRules.mclaren.independentWeeks }}周）</button><button :disabled="specialActionBlocked" @click="openSpecialAction({ type: 'START_MCLAREN_FIX', route: 'mercedes' }, '与梅赛德斯合作适配', `预计需要 ${v.specialRules.mclaren.cooperationWeeks} 周；合作会共享车体资料并提升梅赛德斯研发能力。`, '迈凯伦动力单元软件')">与梅奔合作（{{ v.specialRules.mclaren.cooperationWeeks }}周）</button></div>
      <div class="tiny muted">合作路线会把车体资料交给梅赛德斯，并提高其技术研发能力。诺里斯与皮亚斯特里缠斗时存在额外碰撞风险。</div>
    </div>

    <div v-if="mb" class="card stack-s special-card">
      <div class="spread"><h3>梅赛德斯 · 接班人考核与政治斗争</h3><span v-if="mb.dismissed" class="badge bad">已撤职</span><span v-else class="badge">压缩比 {{ mb.compressionRatio }}</span></div>
      <Bar label="Toto 满意度" :value="mb.totoSatisfaction" :mark="v.specialRules.mercedes.dismissTotoSatisfaction" :color="mb.totoSatisfaction < 30 ? '#ff5a5a' : '#00a19c'" :hint="`低于 ${v.specialRules.mercedes.dismissTotoSatisfaction} 会被撤职`" />
      <Bar label="政治压力" :value="mb.politicalPressure" :max="120" :mark="v.specialRules.mercedes.banPoliticalPressure" :color="mb.politicalPressure >= 80 ? '#ff5a5a' : '#ffb347'" :hint="`达到 ${v.specialRules.mercedes.banPoliticalPressure} 会失去 1:18 压缩比`" />
      <Bar label="ADUO 审批" :value="mb.aduoProgress" color="#6aa6ff" :hint="mb.aduoApproved ? '已获批准，动力单元故障风险消失' : `批准前每场正赛有 ${Math.round(v.specialRules.mercedes.failureChance * 100)}% 故障风险`" />
      <div class="row"><button :disabled="specialActionBlocked || !!mb.dismissed || negotiationActiveFor('mercedes_politics')" @click="openSpecialAction({ type: 'MERCEDES_POLITICS', strategy: 'lobby_aduo' }, '游说 ADUO', '每周只能执行一次政治行动；其他车队会在正赛后继续施压。', 'ADUO 审批')">游说 ADUO</button><button :disabled="specialActionBlocked || !!mb.dismissed || negotiationActiveFor('mercedes_politics')" @click="openSpecialAction({ type: 'MERCEDES_POLITICS', strategy: 'defend' }, '技术辩护', '每周只能执行一次政治行动；其他车队会在正赛后继续施压。', '压缩比与技术方案')">技术辩护</button><button :disabled="specialActionBlocked || !!mb.dismissed || negotiationActiveFor('mercedes_politics')" @click="openSpecialAction({ type: 'MERCEDES_POLITICS', strategy: 'compromise' }, '政治妥协', '每周只能执行一次政治行动；其他车队会在正赛后继续施压。', '梅赛德斯政治压力')">政治妥协</button></div>
      <NegotiationPanel v-if="!mb.dismissed" kind="mercedes_politics" />
      <div class="tiny muted">每周只能执行一次政治行动。每场正赛后，其他车队都会继续施压。</div>
    </div>

    <div v-if="rb" class="card stack-s special-card">
      <div class="spread"><h3>红牛 · 人才与维斯塔潘危机</h3><span class="badge" :class="(rb.verstappenPosition ?? 99) <= 3 ? 'ok' : 'bad'">维斯塔潘 P{{ rb.verstappenPosition || '-' }}</span></div>
      <Bar label="GP 留任意愿" :value="rb.gpRetention" :color="rb.gpRetention < 25 ? '#ff5a5a' : '#3671c6'" :hint="rb.gpTransferred ? 'GP 已决定转投迈凯伦' : '每场正赛后都会下降'" />
      <button :disabled="specialActionBlocked || rb.gpTransferred || negotiationActiveFor('red_bull_gp')" @click="openSpecialAction({ type: 'RED_BULL_RETAIN_GP' }, '提交 GP 留任方案', `将按既有规则投入 ${v.specialRules.redBull.gpNegotiationCost}M$；谈判仍按原流程进行。`, 'GP 留任')">提交 GP 留任方案（{{ v.specialRules.redBull.gpNegotiationCost }}M$）</button>
      <NegotiationPanel v-if="!rb.gpTransferred" kind="red_bull_gp" />
      <div class="small" :class="rb.verstappenExit ? 'notice bad' : 'notice warn'">{{ rb.verstappenExit ? '维斯塔潘的解约条款已经触发，他已转投梅赛德斯。' : rb.summerChecked ? '夏休检查已通过。' : '夏休时维斯塔潘必须位列车手榜前三。' }}</div>
      <div class="tiny muted">RB22 准备不足会使红牛车手的单车失误概率提高 {{ Math.round((v.specialRules.redBull.mistakeMultiplier - 1) * 100) }}%。</div>
    </div>

    <div v-if="am" class="card stack-s special-card">
      <div class="spread"><h3>阿斯顿·马丁 · 本田振动危机</h3><span class="badge" :class="am.aduoEngineArrived ? 'ok' : 'bad'">{{ am.aduoEngineArrived ? '首批 ADUO 已到货' : `每${v.nextSpecialRules.astonMartin.vibrationInterval}圈 ${Math.round(v.nextSpecialRules.astonMartin.vibrationRetireChance * 100)}% 保护性退赛` }}</span></div>
      <Bar label="ADUO 提前进度" :value="am.aduoProgress" color="#006f62" :hint="am.aduoEngineArrived ? '危险振动退赛检查已停止' : '公开车手安全数据可以加速到货'" />
      <Bar label="本田—纽维冲突" :value="am.hondaConflict" :color="am.hondaConflict > 70 ? '#ff5a5a' : '#ffb347'" hint="越高越难合作" />
      <Bar label="纽维适配车体" :value="am.neweyProgress" color="#56b4a9" :hint="am.chassisUpgradeReady ? '升级已经装车' : '完成后释放气动潜力'" />
      <Bar label="西班牙媒体压力" :value="am.mediaPressure" color="#f08b32" hint="每场比赛后持续降低媒体声望和董事会信心" />
      <div class="grid2"><Bar label="老斯特罗尔满意" :value="am.strollFavor" color="#2d9c7b" /><Bar label="阿隆索粉丝愤怒" :value="am.alonsoFanAnger" color="#d45d5d" /></div>
      <div class="row"><button :disabled="specialActionBlocked || negotiationActiveFor('aston_honda')" @click="openSpecialAction({ type: 'ASTON_CRISIS', strategy: 'pressure_honda' }, '用车手安全施压', '数值将按既有危机处理规则结算；不会跳过本田—纽维谈判流程。', '本田 ADUO 提前进度')">用车手安全施压</button><button :disabled="specialActionBlocked || negotiationActiveFor('aston_honda')" @click="openSpecialAction({ type: 'ASTON_CRISIS', strategy: 'mediate' }, '调解本田与纽维', '数值将按既有危机处理规则结算；不会跳过本田—纽维谈判流程。', '本田与纽维冲突')">调解本田与纽维</button><button :disabled="specialActionBlocked || negotiationActiveFor('aston_honda')" @click="openSpecialAction({ type: 'ASTON_CRISIS', strategy: 'push_newey' }, '催促适配车体', '数值将按既有危机处理规则结算；不会跳过本田—纽维谈判流程。', '纽维适配车体')">催促适配车体</button></div>
      <NegotiationPanel kind="aston_honda" />
      <div class="tiny muted">调整优先车手也会改变老斯特罗尔满意度与阿隆索粉丝愤怒。</div>
    </div>

    <div v-if="vcarb" class="card stack-s special-card">
      <div class="spread"><h3>小红牛 · 红牛临时调用</h3><span class="badge" :class="vcarb.pendingRecall ? 'bad' : vcarb.activeRecall ? 'warn' : 'ok'">{{ vcarb.pendingRecall ? '等待替补选择' : vcarb.activeRecall ? '替补正在出赛' : '阵容正常' }}</span></div>
      <template v-if="vcarb.pendingRecall"><div class="notice warn small">红牛已调走 {{ driverLabel(vcarb.pendingRecall?.driverId) }}。请选择本周末替补。</div><div class="row"><button v-for="d in vcarb.candidates" :key="d.id" :disabled="specialActionBlocked" @click="openSpecialAction({ type: 'RACING_BULLS_SELECT_RESERVE', driverId: d.id }, '确认临时替补', '替补只按既有规则参加本周末，不会改变其他阵容安排。', d.name)">选择 {{ d.name }}</button></div></template>
      <div v-else class="small muted">每个比赛周末有 {{ Math.round(v.nextSpecialRules.racingBulls.recallChance * 100) }}% 概率被红牛调走一名正式车手，替补只出赛一站。</div>
    </div>

    <div v-if="au" class="card stack-s special-card">
      <div class="spread"><h3>奥迪 · 涡轮与 ADUO 联盟</h3><span class="badge" :class="au.turboFixed ? 'ok' : 'bad'">{{ au.turboFixed ? '涡轮问题已解决' : `起步随机掉 ${v.nextSpecialRules.audi.startDropMin}–${v.nextSpecialRules.audi.startDropMax} 位` }}</span></div>
      <Bar label="ADUO 推进" :value="au.aduoProgress" color="#d33" :hint="au.alliance ? '盟友：阿斯顿·马丁、梅赛德斯、法拉利' : '与三支车队组成 ADUO 联盟'" />
      <Bar label="政治支持" :value="au.politicalSupport" color="#555" />
      <div v-if="!au.alliance" class="row"><button :disabled="specialActionBlocked || negotiationActiveFor('aduo_alliance')" @click="openSpecialAction({ type: 'AUDI_ALLIANCE' }, '组建四队 ADUO 联盟', '联盟谈判仍按既有流程进行；补充内容不会改变联盟的数值条件。', '阿斯顿·马丁、梅赛德斯、法拉利')">组建四队 ADUO 联盟</button></div>
      <NegotiationPanel v-if="!au.alliance" kind="aduo_alliance" />
    </div>

    <div v-if="alpine" class="card stack-s special-card">
      <div class="spread"><h3>阿尔派 · 布里亚托利接班人</h3><span class="badge" :class="alpine.dismissed ? 'bad' : 'warn'">{{ alpine.dismissed ? '已撤职' : '副领队考核中' }}</span></div>
      <Bar label="布里亚托利满意度" :value="alpine.briatoreSatisfaction" :mark="v.nextSpecialRules.alpine.dismissBriatoreSatisfaction" color="#0093cc" :hint="`低于 ${v.nextSpecialRules.alpine.dismissBriatoreSatisfaction} 会被撤职`" />
      <Bar label="科拉平托粉丝压力" :value="alpine.fanPressure" color="#f28ab2" hint="越高越危险" />
      <Bar label="加斯利留队意愿" :value="alpine.gaslyCommitment" color="#2d5f8b" :hint="alpine.gaslyLeaving ? '加斯利已经决定赛季末离队' : '长期受到不公平待遇会离队'" />
      <Bar label="梅奔动力单元匹配" :value="alpine.puIntegration" color="#00a19c" hint="达到 100% 后消除开局性能和可靠性损失" />
      <div class="small muted">布里亚托利当前只允许研发：{{ alpine.rndDirection.map((x) => v.labels.parts[x] ?? x).join('、') }}</div>
      <div class="row"><button :disabled="specialActionBlocked" @click="openSpecialAction({ type: 'ALPINE_MANAGEMENT', strategy: 'back_colapinto' }, '公开支持科拉平托', '每周只能执行一次；支持任何一方都会依既有规则让另一方承担代价。', '科拉平托')">公开支持科拉平托</button><button :disabled="specialActionBlocked" @click="openSpecialAction({ type: 'ALPINE_MANAGEMENT', strategy: 'reassure_gasly' }, '安抚加斯利', '每周只能执行一次；支持任何一方都会依既有规则让另一方承担代价。', '加斯利')">安抚加斯利</button><button :disabled="specialActionBlocked || alpine.puIntegration >= 100" @click="openSpecialAction({ type: 'ALPINE_MANAGEMENT', strategy: 'integrate_power_unit' }, '推进动力匹配', '每周只能执行一次；支持任何一方都会依既有规则让另一方承担代价。', '梅赛德斯动力单元')">推进动力匹配</button></div>
      <div class="tiny muted">每周只能执行一次。选择任何一方都会让另一方承担代价。</div>
    </div>

    <div v-if="haas" class="card stack-s special-card">
      <div class="spread"><h3>哈斯 · 吉恩与丰田的平衡</h3><span class="badge" :class="haas.toyotaInfluence >= v.nextSpecialRules.haas.interferenceThreshold ? 'warn' : 'ok'">丰田影响 {{ Math.round(haas.toyotaInfluence) }}%</span></div>
      <Bar label="吉恩·哈斯支持" :value="haas.geneSupport" :mark="v.nextSpecialRules.haas.dismissGeneSupport" color="#b6babd" hint="过低会解除玩家职务" />
      <Bar label="丰田支持" :value="haas.toyotaSupport" color="#e60012" :hint="haas.partnershipWithdrawn ? '丰田已冻结投入' : '越高越愿意提供资金和技术'" />
      <Bar label="丰田影响力" :value="haas.toyotaInfluence" :mark="v.nextSpecialRules.haas.interferenceThreshold" color="#e60012" :hint="`达到 ${v.nextSpecialRules.haas.interferenceThreshold}% 后会限制研发方向`" />
      <div class="small">丰田累计投入：{{ money(haas.fundingProvided) }}。当前偏好：{{ haas.preferredParts.map((x) => v.labels.parts[x] ?? x).join('、') }}。</div>
      <div class="row"><button :disabled="specialActionBlocked || negotiationActiveFor('haas_toyota')" @click="openSpecialAction({ type: 'HAAS_BALANCE', strategy: 'protect_independence' }, '维护车队独立', '平衡结果按既有吉恩与丰田关系规则结算。', '吉恩·哈斯与丰田')">维护车队独立</button><button :disabled="specialActionBlocked || haas.partnershipWithdrawn || negotiationActiveFor('haas_toyota')" @click="openSpecialAction({ type: 'HAAS_BALANCE', strategy: 'accept_toyota' }, '接受丰田追加投入', '平衡结果按既有吉恩与丰田关系规则结算。', '丰田追加投入')">接受丰田追加投入</button><button :disabled="specialActionBlocked || negotiationActiveFor('haas_toyota')" @click="openSpecialAction({ type: 'HAAS_BALANCE', strategy: 'compromise' }, '提出折中', '平衡结果按既有吉恩与丰田关系规则结算。', '吉恩·哈斯与丰田')">提出折中</button></div>
      <NegotiationPanel kind="haas_toyota" />
    </div>

    <div v-if="williams" class="card stack-s special-card">
      <div class="spread"><h3>威廉姆斯 · 沃尔斯接班培养</h3><span class="badge" :class="williams.confirmedSuccessor ? 'ok' : 'warn'">{{ williams.confirmedSuccessor ? '已正式接任' : '培养中' }}</span></div>
      <Bar label="沃尔斯信心" :value="williams.vowlesConfidence" color="#64c4ff" />
      <Bar label="接班准备度" :value="williams.successionReadiness" :mark="v.nextSpecialRules.williams.successionThreshold" color="#005aff" :hint="`2026 年底至少需要 ${v.nextSpecialRules.williams.successionThreshold}`" />
      <div class="small">本周方向：{{ williams.focusRound === `${v.season.number}-w${v.season.week}` ? (williams.focus === 'facilities' ? '设施更新' : williams.focus === 'development' ? '赛车升级' : '保留现金') : '尚未决定' }}</div>
      <div class="grid2 small"><div>设施累计投入：{{ money(williams.facilityInvestment) }}</div><div>赛车升级投入：{{ money(williams.developmentInvestment) }}</div></div>
      <div class="row"><button :disabled="specialActionBlocked" @click="openSpecialAction({ type: 'WILLIAMS_BUDGET_FOCUS', focus: 'facilities' }, '优先设施', '每周只能确定一次预算方向；设施和研发动作仍须符合本周方向。', '威廉姆斯预算')">优先设施</button><button :disabled="specialActionBlocked" @click="openSpecialAction({ type: 'WILLIAMS_BUDGET_FOCUS', focus: 'development' }, '优先赛车升级', '每周只能确定一次预算方向；设施和研发动作仍须符合本周方向。', '威廉姆斯预算')">优先赛车升级</button><button :disabled="specialActionBlocked" @click="openSpecialAction({ type: 'WILLIAMS_BUDGET_FOCUS', focus: 'reserve' }, '保留现金', '每周只能确定一次预算方向；设施和研发动作仍须符合本周方向。', '威廉姆斯预算')">保留现金</button></div>
      <div class="tiny muted">每周只能确定一次预算方向。设施和研发动作必须符合本周方向。</div>
    </div>

    <RandomEventPanel mode="card" />

    <div v-if="fia?.current" class="card stack-s fia-meeting">
      <div class="spread"><h3>FIA 领队座谈会</h3><span class="badge warn">第 {{ fia.current.index }} 次会议</span></div>
      <div class="notice warn small">议题：{{ fiaIssue[fia.current.issue] }}。对手：{{ fia.current.opponents.map(teamLabel).join('、') }}。</div>
      <div v-if="fia.current.issue === 'ferrari_turbo'" class="small">
        支持增加 {{ v.specialRules.ferrari.turboSpoolSeconds }} 秒起压时间：{{ (fia.current.supporters ?? []).map(teamLabel).join('、') }}。
        <span v-if="fia.current.supporters?.includes('audi')">奥迪本次支持限制法拉利，即使已加入 ADUO 联盟也不会改变立场。</span>
      </div>
      <div v-if="fia.current.forcedStance" class="notice warn small">{{ p.team.id === 'alpine' ? '布里亚托利已经决定支持提案。' : '车队已经公开支持提案。' }}你必须以支持立场参加正常领队谈判。</div>
      <Bar label="政治资本" :value="fia.politicalCapital" color="#355c8a" hint="董事会信心、媒体声望和政治资本共同决定说服检定" />
      <div class="row"><button class="primary" :disabled="specialActionBlocked || negotiationActiveFor('fia_roundtable') || (!!fia.current.forcedStance && fia.current.forcedStance !== 'support')" @click="openSpecialAction({ type: 'FIA_DEBATE', stance: 'support' }, '支持 FIA 议题', `必须遵守当前会议的强制立场${fia.current.forcedStance ? `：${fiaStanceLabel[fia.current.forcedStance]}。` : '；当前没有强制立场。'}领队谈判仍按既有流程进行。`, fiaIssue[fia.current.issue])">支持议题</button><button :disabled="specialActionBlocked || negotiationActiveFor('fia_roundtable') || (!!fia.current.forcedStance && fia.current.forcedStance !== 'oppose')" @click="openSpecialAction({ type: 'FIA_DEBATE', stance: 'oppose' }, '反对 FIA 议题', `必须遵守当前会议的强制立场${fia.current.forcedStance ? `：${fiaStanceLabel[fia.current.forcedStance]}。` : '；当前没有强制立场。'}领队谈判仍按既有流程进行。`, fiaIssue[fia.current.issue])">反对议题</button><button :disabled="specialActionBlocked || negotiationActiveFor('fia_roundtable') || (!!fia.current.forcedStance && fia.current.forcedStance !== 'compromise')" @click="openSpecialAction({ type: 'FIA_DEBATE', stance: 'compromise' }, '提出 FIA 折中', `必须遵守当前会议的强制立场${fia.current.forcedStance ? `：${fiaStanceLabel[fia.current.forcedStance]}。` : '；当前没有强制立场。'}领队谈判仍按既有流程进行。`, fiaIssue[fia.current.issue])">提出折中</button></div>
      <NegotiationPanel kind="fia_roundtable" />
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

    <SpecialActionDialog
      v-if="specialAction"
      :action="specialAction.action"
      :title="specialAction.title"
      :subject="specialAction.subject"
      :hint="specialAction.hint"
      :expected-revision-id="store.status?.revisionId"
      :fallback-focus="overviewRoot"
      @close="specialAction = null"
    />
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
