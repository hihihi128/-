/**
 * 提示词构建：把存档压缩成给 AI 看的「实时数据」块。
 * 引擎是唯一事实来源；AI 据此叙事，并按协议输出少量可量化的剧情后果。
 */
import { FIA_ISSUE_LABELS, LABELS } from './defaults';
import { ferrariTurboAdvantageActive } from './nextTeamSpecials';
import { rankOfTeam } from './development';
import { capRemaining, costCapOf } from './finance';
import { aduoLine } from './aduo';
import { fanCamps, fanGap, ferrariActive } from './ferrari';
import { driverName, teamName } from './log';
import { describeLog, UPDATE_TAG } from './protocol';
import { carRatings, driverOverall, moraleLabel, teamPaceRanking, trackScore } from './ratings';
import { nextActionFor, sortedDrivers, sortedTeams } from './season';
import { planLabel } from './strategy';
import type { GameState } from './types';
import { money, signed } from './util';
import { revealedWeather } from './view';
import { currentRound } from './weekend';
import { marketCloseBlockers } from './market';

export interface PromptOptions {
  /** 显示几条最近新闻 */
  newsCount?: number;
  /** 是否附带输出协议提醒（世界书里已有完整规则时可关闭） */
  protocolReminder?: boolean;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function buildStatePrompt(state: GameState, opts: PromptOptions = {}): string {
  const newsCount = opts.newsCount ?? 4;
  const rules = state.rules;
  const team = state.teams[state.meta.playerTeamId];
  const roundDef = currentRound(state);
  const track = roundDef ? state.tracks[roundDef.trackId] : undefined;
  const phase = state.season.phase;
  const L: string[] = [];

  L.push('<F1领队模拟器·实时数据>');
  L.push('（以下内容由游戏引擎计算，是唯一事实来源。叙事必须与之一致：不得编造未发生的比赛结果、圈速或零件数值；没跑过的场次不要写出结果。）');
  L.push('【正文保密规则】员工、工程师、策略师和维修组的能力分、技能分、等级、内部评分、判定概率及随机检定仅供引擎计算。正文不得直接或变相写出这些数值，也不得使用“某个 XX 分水平的工程师做了某事”之类表达；只能用姓名、职务、实际言行和定性表现叙述。');

  // 赛季与赛道
  const next = nextActionFor(state);
  if (phase === 'season_end') {
    L.push(`赛季：${state.season.year} 赛季已结束（第 ${state.season.number} 个赛季）`);
  } else if (track && roundDef) {
    L.push(
      `赛季：${state.season.year}（第 ${state.season.number} 季）第 ${state.season.roundIndex + 1}/${state.calendar.length} 站 · ${roundDef.name || track.name} · 赛道「${track.name}」（${track.type}，${track.laps} 圈，超车容易度 ${track.overtaking}，轮胎负荷 ${track.tyreStress}）${roundDef.sprint ? ' · 冲刺赛周末' : ''}`,
    );
  }
  L.push(`当前阶段：${LABELS.phase[phase]}${next ? `（玩家的下一步操作：${next.label}）` : ''}`);
  if (state.weekend && state.weekend.roundIndex === state.season.roundIndex && phase !== 'pre_race') {
    const w = state.weekend;
    const rw = revealedWeather(w, phase, true);
    const weatherBits = [
      rw.qualifying ? `排位${LABELS.weather[rw.qualifying]}` : `排位降雨概率 ${pct(w.forecast.qualifying)}`,
      rw.race ? `正赛${LABELS.weather[rw.race]}` : `正赛降雨概率 ${pct(w.forecast.race)}${w.forecast.raceRainWindow ? `，预计第 ${w.forecast.raceRainWindow[0]}–${w.forecast.raceRainWindow[1]} 圈可能降雨` : ''}`,
    ];
    L.push(`天气：${weatherBits.join('，')}`);
    const live = w.liveRace;
    if (live) {
      const recent = live.events.slice(-3).map(e => `第${e.lap}圈 ${e.text}`).join('；');
      const decision = live.pendingDecision ? `当前暂停等待领队确认：${live.pendingDecision.reasons.join('、')}。` : live.stage === 'finished' ? '比赛已经结束，可以总结已确认的比赛结果。' : '比赛正在等待下一次引擎推进。';
      L.push(`【实时比赛】${live.kind === 'sprint' ? '冲刺赛' : '正赛'}第 ${live.completedLaps}/${live.totalLaps} 圈，赛道${live.surface}，当前降雨强度 ${Math.round(live.rain * 100)}%，未来 ${live.forecast.horizonLaps} 圈预报仅供参考（降雨概率 ${pct(live.forecast.rainProbability)}，置信度 ${pct(live.forecast.confidence)}）。${recent ? `已发生：${recent}。` : ''}${decision}AI 只能叙述已发生事件或讨论选项，不能推进圈数、选择轮胎、改变天气或编造结果。`);
    }
  }

  // 车队
  const rank = rankOfTeam(state, team.id);
  const teamRows = sortedTeams(state);
  const leader = teamRows[0];
  const pts = state.standings.teams[team.id]?.points ?? 0;
  L.push(
    `玩家：${state.meta.principalName}（{{user}}），${team.name} 车队领队 · 车队积分榜 P${rank}（${pts} 分${leader && leader !== team.id ? `，榜首 ${state.teams[leader].name} ${state.standings.teams[leader]?.points ?? 0} 分` : ''}）`,
  );
  const market = state.market?.window;
  if (market) {
    const ownDeals = market.agreements.filter(a => a.toTeamId === team.id || a.fromTeamId === team.id);
    const blockers = marketCloseBlockers(state);
    L.push(`【合同市场】目标 ${market.targetYear} 赛季，状态 ${market.status}。${ownDeals.length ? `本队已确认：${ownDeals.map(a => `${a.personId}（${a.annualSalary.toFixed(2)}M/年，至${a.endYear}）`).join('、')}。` : '本队尚无新协议。'}${blockers.length ? `关闭前：${blockers.filter(x => x.includes(team.name) || x.startsWith('请先')).join('；')}。` : ''}AI 只能叙述已经确认的公开协议，不能谈判、承诺或改写合同。`);
  }
  L.push(
    `资金 ${money(team.funds)} · 预算帽剩余 ${money(capRemaining(team, rules))}/${money(costCapOf(team, rules))} · 董事会信心 ${team.boardConfidence.toFixed(0)}（目标车队第 ${team.targetPosition}）· 媒体声誉 ${team.mediaReputation.toFixed(0)} · 员工士气 ${team.staffMorale.toFixed(0)}`,
  );

  const aduo = aduoLine(state);
  if (aduo) L.push(aduo);
  if (state.meta.selectionReason) L.push(`玩家被选中的原因（玩家自述）：${state.meta.selectionReason}`);
  if (state.ferrari) {
    const f = state.ferrari;
    const fr = rules.ferrari;
    const fans = fanCamps(f).map(id => `${driverName(state, id)}粉丝 ${f.fans[id].toFixed(0)}`).join(' / ');
    L.push(
      f.dismissed
        ? `【法拉利·已撤职】玩家已被埃尔坎解除过渡领队职务：${f.dismissed}。本局结束，叙事应围绕离任与余波展开。`
        : `【法拉利·过渡领队考核】媒体支持率 ${team.mediaReputation.toFixed(0)}（低于 ${fr.minMedia} 撤职，低于 ${fr.warnMedia} 告急）· ${fans}（差距 ${fanGap(f).toFixed(0)}，超过 ${fr.maxFanGap} 撤职）。升级件分配、优先车手、车队指令和成绩都会影响两边粉丝；意大利媒体比别处苛刻。小涡轮起步优势${ferrariTurboAdvantageActive(state) ? `仍生效，每场正赛提升 ${fr.turboStartGainMin}–${fr.turboStartGainMax} 位` : '已经消失'}；ADUO 四队联盟${f.aduoAlliance ? `已加入${f.aduoLobbyGranted ? '，且已获得一次额外认证机会' : '，等待后续 FIA 游说'}` : '尚未加入'}。`,
    );
  }
  if (state.mclaren) {
    const m = state.mclaren;
    L.push(`【迈凯伦·临时领队】斯特拉因交通事故至少休养一年，玩家受扎克·布朗邀请临时执掌车队。动力单元软件${m.softwareResolved ? '已经完成适配' : m.route ? `正在走${m.route === 'independent' ? '自主适配' : '与梅赛德斯合作'}路线（剩余 ${m.weeksLeft} 周）` : `尚未选择适配路线，每场正赛有 ${Math.round(rules.mclaren.failureChance * 100)}% 异常风险`}。诺里斯与皮亚斯特里首次近距离缠斗时存在 5% 额外队友碰撞风险。`);
  }
  if (state.mercedes) {
    const m = state.mercedes;
    L.push(m.dismissed
      ? `【梅赛德斯·已撤职】Toto Wolff 已终止玩家的接班人培养计划：${m.dismissed}。`
      : `【梅赛德斯·接班人计划】Toto 满意度 ${m.totoSatisfaction.toFixed(0)}（低于 ${rules.mercedes.dismissTotoSatisfaction} 撤职）· 政治压力 ${m.politicalPressure.toFixed(0)}/${rules.mercedes.banPoliticalPressure} · 热态压缩比 ${m.compressionRatio} · ADUO ${m.aduoApproved ? '已批准' : `审批 ${m.aduoProgress}%（批准前每场正赛有 ${Math.round(rules.mercedes.failureChance * 100)}% 动力单元故障风险）`}。`);
  }
  if (state.redBull) {
    const r = state.redBull;
    const maxPos = sortedDrivers(state).indexOf('verstappen') + 1;
    L.push(`【红牛·人手危机】RB22 准备不足使车手更容易失误。GP 留任意愿 ${r.gpRetention.toFixed(0)}${r.gpTransferred ? '，已经转投迈凯伦' : ''}。夏休检查${r.summerChecked ? '已完成' : '尚未进行'}；维斯塔潘当前车手榜 P${maxPos}${r.verstappenExit ? '，解约条款已经触发并已转投梅赛德斯' : '，夏休时必须位列前三'}。`);
  }
  if (state.astonMartin) {
    const a = state.astonMartin;
    L.push(`【阿斯顿·马丁·替罪羊危机】Jonathan Wheatley 因 AMR26 预期表现极差被撤职，玩家与纽维接手残局。本田动力单元约少 100 马力，且与车体产生危险振动。${a.aduoEngineArrived ? '首批 ADUO 动力单元已经到货，保护性退赛检查停止' : `每 ${rules.astonMartin.vibrationInterval} 圈以 ${Math.round(rules.astonMartin.vibrationRetireChance * 100)}% 概率为防止永久性手部损伤强制退赛；ADUO 提前进度 ${a.aduoProgress}%`}。本田冲突 ${a.hondaConflict} · 纽维适配 ${a.neweyProgress}% · 西班牙媒体压力 ${a.mediaPressure} · 老斯特罗尔满意 ${a.strollFavor} · 阿隆索粉丝愤怒 ${a.alonsoFanAnger}。`);
  }
  if (state.racingBulls) {
    const r = state.racingBulls;
    L.push(`【小红牛·副领队】玩家辅佐艾伦·佩尔曼。红牛每站可能临时调走一名正式车手。${r.pendingRecall ? `当前必须从储备车手中选择替补，待替车手：${driverName(state, r.pendingRecall.driverId)}` : r.activeRecall ? `当前由 ${driverName(state, r.activeRecall.replacementId)} 顶替 ${driverName(state, r.activeRecall.driverId)} 一站` : '当前阵容正常'}。`);
  }
  if (state.audi) {
    const a = state.audi;
    L.push(`【奥迪·副领队】比诺托负责技术，玩家处理围场政治。奥迪涡轮问题${a.turboFixed ? '已经通过 ADUO 解决' : `尚未解决，起步随机丢 ${rules.audi.startDropMin}–${rules.audi.startDropMax} 位`}。ADUO 进度 ${a.aduoProgress}% · 政治支持 ${a.politicalSupport}${a.alliance ? ' · 已与阿斯顿·马丁、梅赛德斯和法拉利结盟' : ' · 尚未组成四队联盟'}。`);
  }
  if (state.alpine) {
    const a = state.alpine;
    L.push(`【阿尔派·布里亚托利接班人】布里亚托利满意度 ${a.briatoreSatisfaction} · 科拉平托粉丝压力 ${a.fanPressure} · 加斯利留队意愿 ${a.gaslyCommitment}${a.gaslyLeaving ? '（已经决定离队）' : ''} · 梅赛德斯动力单元匹配 ${a.puIntegration}% · 当前研发方向 ${a.rndDirection.map(type => rules.parts[type]?.name ?? type).join('、')}。玩家无权改变布里亚托利决定的大方向。`);
  }
  if (state.haas) {
    const h = state.haas;
    L.push(`【哈斯·共同领队】吉恩·哈斯支持 ${h.geneSupport} · 丰田支持 ${h.toyotaSupport} · 丰田影响力 ${h.toyotaInfluence}% · 丰田累计投入 $${h.fundingProvided.toFixed(1)}M${h.partnershipWithdrawn ? ' · 丰田已冻结投入' : ''}。影响力达到 ${rules.haas.interferenceThreshold}% 后，丰田会限制研发方向。`);
  }
  if (state.williams) {
    const w = state.williams;
    const currentFocus = w.focusRound === `${state.season.number}-w${state.season.week}` ? w.focus : null;
    const focus = currentFocus === 'facilities' ? '设施' : currentFocus === 'development' ? '赛车升级' : currentFocus === 'reserve' ? '保留现金' : '尚未决定';
    L.push(`【威廉姆斯·接班培养】沃尔斯信心 ${w.vowlesConfidence} · 接班准备度 ${w.successionReadiness}/${rules.williams.successionThreshold} · 本周预算方向 ${focus} · 设施累计投入 $${w.facilityInvestment.toFixed(1)}M · 升级累计投入 $${w.developmentInvestment.toFixed(1)}M${w.confirmedSuccessor ? ' · 已正式接任' : ''}。`);
  }
  if (state.randomEvents?.current && (state.randomEvents.current.status === 'resolved' || state.randomEvents.current.status === 'unresolved')) L.push(`【本周随机事件】${state.randomEvents.current.title}：${state.randomEvents.current.detail}`);
  if (state.meta.playerTeamId === 'cadillac') L.push('【凯迪拉克·新军】车队通过全球公开招募组建，没有额外特殊机制，但初始赛车性能很差，需要依靠研发和人才市场追赶。');
  if (state.fiaMeeting?.current) {
    const f = state.fiaMeeting;
    const current = f.current!;
    const forced = current.forcedStance ? `布里亚托利已经决定玩家必须${current.forcedStance === 'support' ? '支持' : '反对'}。` : '';
    const proposal = current.issue === 'ferrari_turbo' ? `支持方：${(current.supporters ?? []).map(id => teamName(state, id)).join('、')}；奥迪是否支持独立于 ADUO 联盟关系。` : '';
    L.push(`【FIA 领队座谈会·必须先处理】议题：${FIA_ISSUE_LABELS[current.issue]}。辩论对手：${current.opponents.map(id => teamName(state, id)).join('、')}。${proposal}${forced}政治资本 ${f.politicalCapital}。玩家必须通过正常领队谈话选择立场，系统按董事会信心、媒体声望、政治资本与确定性随机数进行说服检定。`);
  }

  // 赛车
  const ranking = teamPaceRanking(state, phase !== 'season_end' && track ? track : null, 'disclosed');
  const paceRank = ranking.findIndex(r => r.teamId === team.id) + 1;
  L.push(`赛车（本站性能全场第 ${paceRank}/${ranking.length}）：`);
  for (const car of team.cars) {
    const r = carRatings(team, car, rules, 'disclosed');
    const ts = track ? trackScore(r, track).toFixed(1) : '-';
    const unverified = Object.keys(rules.parts)
      .map(pt => team.parts[pt].specs.find(s => s.id === car.fitted[pt]))
      .filter(s => s && !s.verified)
      .map(s => `${rules.parts[s!.type].name} v${s!.version}`);
    L.push(
      `- ${car.slot} 号车（${driverName(state, car.driverId)}）：本站适配 ${ts} · 下压力 ${r.downforce} 气动效率 ${r.efficiency} 动力 ${r.power} 机械抓地 ${r.mechanical} 轮胎友好 ${r.tyre} 可靠性 ${r.reliability}${unverified.length ? ` · 新件待验证：${unverified.join('、')}` : ''}`,
    );
  }

  // 车手
  L.push('车手：');
  const driverRows = sortedDrivers(state);
  for (const car of team.cars) {
    if (!car.driverId) continue;
    const d = state.drivers[car.driverId];
    const st = state.standings.drivers[d.id];
    const pos = driverRows.indexOf(d.id) + 1;
    const pu = Object.entries(rules.puAllocation)
      .map(([pt, lim]) => `${rules.parts[pt]?.name ?? pt} ${d.puUsed?.[pt] ?? 1}/${lim}`)
      .join('、');
    L.push(
      `- ${d.name}（id:${d.id}，#${d.number}，${d.age} 岁）${pu ? `动力单元已用 ${pu} · ` : ''}综合 ${driverOverall(d)} · 心态 ${d.morale.toFixed(0)}（${moraleLabel(d.morale)}）· 对你的信任 ${d.trust.toFixed(0)} · 体能 ${d.fitness.toFixed(0)} · 状态 ${signed(d.form)} · 车手榜 P${pos}（${st?.points ?? 0} 分）${team.driverPriority === d.id ? ' · 车队优先车手' : ''}${d.traits.length ? ` · 性格：${d.traits.join('、')}` : ''}`,
    );
  }
  const reserves = Object.values(state.drivers).filter(d => d.teamId === team.id && !team.cars.some(c => c.driverId === d.id));
  if (reserves.length) L.push(`替补：${reserves.map(d => `${d.name}（id:${d.id}）`).join('、')}`);

  // 本站策略
  if (state.weekend && state.weekend.roundIndex === state.season.roundIndex && phase !== 'pre_race' && phase !== 'season_end') {
    const w = state.weekend;
    const bits = team.cars
      .filter(c => c.driverId && w.plans[c.driverId])
      .map(c => {
        const p = w.plans[c.driverId!];
        const tyre = p.tyrePlan === 'auto' ? '轮胎策略交给策略组' : planLabel(rules, p.tyrePlan);
        return `${driverName(state, c.driverId)}：练习「${LABELS.program[p.practiceProgram]}」/ 排位「${LABELS.approach[p.qualiApproach]}」/ ${tyre} / ${LABELS.paceMode[p.paceMode]}模式 / ${LABELS.pitTiming[p.pitTiming]}`;
      });
    if (bits.length) L.push(`领队的本站策略：${bits.join('；')}`);
    const o = w.teamOrders;
    L.push(`车队指令：${o.mode === 'favor' && o.favorDriverId ? `偏向 ${driverName(state, o.favorDriverId)}` : LABELS.orders[o.mode]}`);
  }

  // 研发与库存
  const projects = team.projects.map(p => `${p.label}（剩余 ${p.weeksLeft} 周${p.expected ? `，预期 +${p.expected[0]}~+${p.expected[1]}` : ''}）`);
  if (projects.length) L.push(`进行中的项目：${projects.join('；')}`);
  const pending: string[] = [];
  for (const [pt, parts] of Object.entries(team.parts)) {
    for (const s of parts.specs) {
      const n = parts.stock[s.id] ?? 0;
      const fitted = team.cars.some(c => c.fitted[pt] === s.id);
      if (n > 0 && !fitted && s.version > 1) pending.push(`${rules.parts[pt].name} v${s.version} ×${n}`);
    }
  }
  if (pending.length) L.push(`仓库里未装车的升级件：${pending.join('、')}`);

  // 积分榜
  const topDrivers = driverRows.slice(0, 5).map((id, i) => `P${i + 1} ${driverName(state, id)} ${state.standings.drivers[id].points}`);
  if (topDrivers.length) L.push(`车手积分榜：${topDrivers.join(' · ')}`);

  // 新闻
  const news = state.news.slice(-newsCount).map(n => `[${n.tag}] ${n.text}`);
  if (news.length) L.push(`最近新闻：${news.join(' / ')}`);

  // 最近的 AI 调整
  const lastAi = state.aiLog.slice(-3).filter(e => e.ok).map(e => describeLog(state, e));
  if (lastAi.length) L.push(`上一轮剧情已结算：${lastAi.join('；')}`);

  // 待叙述
  if (state.narration.length) {
    L.push('【待叙述事件】请在本次回复中自然地描写这些刚刚发生的事（可通过车手、工程师、媒体等角色之口），不要逐条照抄数据：');
    state.narration.forEach((e, i) => L.push(`${i + 1}. [${e.title}] ${e.detail}`));
  }

  // 可引用 ID
  const ids = team.cars
    .filter(c => c.driverId)
    .map(c => `${c.driverId}=${driverName(state, c.driverId)}`)
    .concat(reserves.map(d => `${d.id}=${d.name}`));
  const rivals = driverRows.filter(id => state.drivers[id]?.teamId !== team.id).slice(0, 6).map(id => `${id}=${driverName(state, id)}`);
  L.push(`可在指令中引用的车手 id：本队 ${ids.join('，')}${rivals.length ? `；其他 ${rivals.join('，')}` : ''}`);
  if (opts.protocolReminder !== false) {
    const lim = rules.aiLimits;
    L.push(
      `若剧情产生可量化的后果，在回复末尾用 <${UPDATE_TAG}> 每行一个 JSON 输出（没有就不输出）。单条幅度上限：心态/信任 ±${lim.morale}/±${lim.trust}，董事会 ±${lim.board}，媒体/士气 ±${lim.media}/±${lim.staff}，资金 ±${lim.funds}M，体能 ±${lim.fitness}，罚退 ≤${lim.penalty} 格${ferrariActive(state) ? `，粉丝意见 ±${lim.fans}（{"op":"fans","driver":"车手id","delta":数值}）` : ''}；每条回复最多 ${lim.maxCommands} 条。`,
    );
  }
  L.push('</F1领队模拟器·实时数据>');
  return L.join('\n');
}
