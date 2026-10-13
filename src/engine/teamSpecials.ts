import { addNarration, addNews, playerTeam } from './log';
import type { GameState, TeamState } from './types';
import { clamp, pushCapped, round1, stamp } from './util';

const LOG_CAP = 10;
const roundKey = (state: GameState) => `${state.season.number}-${state.season.roundIndex}`;
const log = (state: GameState, target: { log: Array<{ at: string; text: string }> }, text: string) => pushCapped(target.log, { at: stamp(state), text }, LOG_CAP);

export function initTeamSpecials(state: GameState, team: TeamState): void {
  state.mclaren = team.special === 'mclaren' ? { softwareResolved: false, route: null, weeksLeft: 0, mercedesBuffApplied: false, log: [] } : null;
  state.mercedes = team.special === 'mercedes' ? {
    aduoApproved: false,
    aduoProgress: 0,
    politicalPressure: state.rules.mercedes.startPoliticalPressure,
    compressionRatio: '1:18',
    totoSatisfaction: state.rules.mercedes.startTotoSatisfaction,
    dismissed: null,
    lastActionRound: null,
    log: [],
  } : null;
  state.redBull = team.special === 'red_bull' ? {
    gpRetention: state.rules.redBull.startGpRetention,
    gpTransferred: false,
    summerChecked: false,
    verstappenExit: false,
    lastActionRound: null,
    log: [],
  } : null;
}

export function startMcLarenFix(state: GameState, route: 'independent' | 'mercedes'): { ok: boolean; message: string } {
  const m = state.mclaren;
  if (!m) return { ok: false, message: '当前车队没有迈凯伦软件适配机制' };
  if (m.softwareResolved) return { ok: false, message: '动力单元软件适配问题已经解决' };
  if (m.route) return { ok: false, message: '专项项目已经启动，不能中途更换路线' };
  m.route = route;
  m.weeksLeft = route === 'independent' ? state.rules.mclaren.independentWeeks : state.rules.mclaren.cooperationWeeks;
  const text = route === 'independent'
    ? `迈凯伦启动自主车体与动力单元软件适配项目，预计 ${m.weeksLeft} 周完成。`
    : `迈凯伦与梅赛德斯启动联合适配项目，预计 ${m.weeksLeft} 周完成；迈凯伦将共享车体资料。`;
  log(state, m, text);
  addNews(state, '研发', text);
  addNarration(state, 'mclaren_fix', '迈凯伦软件适配路线确定', text);
  return { ok: true, message: text };
}

export function mercedesPolitics(state: GameState, strategy: 'lobby_aduo' | 'defend' | 'compromise'): { ok: boolean; message: string } {
  const m = state.mercedes;
  if (!m) return { ok: false, message: '当前车队没有梅赛德斯政治机制' };
  if (m.dismissed) return { ok: false, message: `你已被 Toto Wolff 撤职：${m.dismissed}` };
  if (m.lastActionRound === roundKey(state)) return { ok: false, message: '每站只能执行一次政治行动' };
  m.lastActionRound = roundKey(state);
  let text = '';
  if (strategy === 'lobby_aduo') {
    m.aduoProgress = Math.min(100, m.aduoProgress + state.rules.mercedes.aduoProgressPerLobby);
    m.politicalPressure = round1(clamp(m.politicalPressure + 4, 0, 120));
    m.totoSatisfaction = round1(clamp(m.totoSatisfaction - 2, 0, 100));
    if (m.aduoProgress >= 100 && !m.aduoApproved) {
      m.aduoApproved = true;
      text = 'FIA 批准梅赛德斯使用 ADUO 解决动力单元可靠性问题。';
    } else text = `车队继续向 FIA 争取 ADUO，审批进度达到 ${m.aduoProgress}%。`;
  } else if (strategy === 'defend') {
    m.politicalPressure = round1(clamp(m.politicalPressure - 16, 0, 120));
    m.totoSatisfaction = round1(clamp(m.totoSatisfaction + 3, 0, 100));
    text = '车队提交热态压缩比技术辩护，暂时压低了其他车队的政治压力。';
  } else {
    m.politicalPressure = round1(clamp(m.politicalPressure - 28, 0, 120));
    m.totoSatisfaction = round1(clamp(m.totoSatisfaction - 8, 0, 100));
    text = '车队向竞争对手作出政治妥协，压力显著下降，但 Toto 对让步很不满意。';
  }
  log(state, m, text);
  addNews(state, '政治', text);
  return { ok: true, message: text };
}

export function retainGp(state: GameState): { ok: boolean; message: string } {
  const r = state.redBull;
  const team = playerTeam(state);
  if (!r) return { ok: false, message: '当前车队没有红牛 GP 留任机制' };
  if (r.gpTransferred) return { ok: false, message: 'GP 已经决定转投迈凯伦' };
  if (r.lastActionRound === roundKey(state)) return { ok: false, message: '每站只能与 GP 谈判一次' };
  if (team.funds < state.rules.redBull.gpNegotiationCost) return { ok: false, message: '资金不足以提供留任方案' };
  r.lastActionRound = roundKey(state);
  team.funds = round1(team.funds - state.rules.redBull.gpNegotiationCost);
  r.gpRetention = round1(clamp(r.gpRetention + state.rules.redBull.gpNegotiationGain, 0, 100));
  const text = `车队向 GP 提交留任方案，留任意愿升至 ${r.gpRetention}。`;
  log(state, r, text);
  addNews(state, '员工', text);
  return { ok: true, message: text };
}

export function advanceSpecialWeeks(state: GameState): void {
  const m = state.mclaren;
  if (!m?.route || m.softwareResolved || m.weeksLeft <= 0) return;
  m.weeksLeft -= 1;
  if (m.weeksLeft > 0) return;
  m.softwareResolved = true;
  const routeText = m.route === 'independent' ? '迈凯伦完成自主软件适配，动力单元异常风险消失。' : '迈凯伦与梅赛德斯完成联合软件适配，动力单元异常风险消失。';
  if (m.route === 'mercedes' && !m.mercedesBuffApplied) {
    const mercedes = state.teams.mercedes;
    if (mercedes) {
      const gain = state.rules.mclaren.mercedesDevelopmentBuff;
      mercedes.staff.technicalDirector.skill = round1(clamp(mercedes.staff.technicalDirector.skill + gain, 1, 100));
      mercedes.staff.aeroChief.skill = round1(clamp(mercedes.staff.aeroChief.skill + gain, 1, 100));
      m.mercedesBuffApplied = true;
    }
  }
  log(state, m, routeText);
  addNews(state, '研发', routeText);
  addNarration(state, 'mclaren_fix_done', '动力单元软件适配完成', routeText);
}

function driverPosition(state: GameState, id: string): number {
  return Object.keys(state.standings.drivers).sort((a, b) => state.standings.drivers[b].points - state.standings.drivers[a].points || state.standings.drivers[b].wins - state.standings.drivers[a].wins).indexOf(id) + 1;
}

export function afterSpecialRace(state: GameState): void {
  if (state.mercedes) {
    const m = state.mercedes;
    m.politicalPressure = round1(clamp(m.politicalPressure + state.rules.mercedes.pressurePerRace, 0, 120));
    const rank = Object.keys(state.standings.teams).sort((a, b) => state.standings.teams[b].points - state.standings.teams[a].points).indexOf('mercedes') + 1;
    m.totoSatisfaction = round1(clamp(m.totoSatisfaction + (rank <= 2 ? 2 : -3), 0, 100));
    if (m.politicalPressure >= state.rules.mercedes.banPoliticalPressure && m.compressionRatio === '1:18') {
      m.compressionRatio = '1:16';
      const team = state.teams.mercedes;
      const penalized = new Set<string>();
      for (const car of team?.cars ?? []) {
        const spec = team.parts.power_unit?.specs.find(s => s.id === car.fitted.power_unit);
        if (spec && !penalized.has(spec.id)) {
          spec.perf = round1(Math.max(1, spec.perf - 2));
          penalized.add(spec.id);
        }
      }
      addNews(state, 'FIA', 'FIA 禁止梅赛德斯利用热胀冷缩维持 1:18 压缩比，动力单元必须恢复 1:16。');
    }
    if (m.totoSatisfaction < state.rules.mercedes.dismissTotoSatisfaction && !m.dismissed) {
      m.dismissed = `Toto 满意度降至 ${m.totoSatisfaction}`;
      state.flags.fired = true;
      state.flags.firedReason = m.dismissed;
      addNarration(state, 'fired', 'Toto 终止接班人计划', `Toto Wolff 认为玩家没有通过副领队考核，并立即解除职务。${m.dismissed}。`);
    }
  }
  if (state.redBull) {
    const r = state.redBull;
    r.gpRetention = round1(clamp(r.gpRetention - state.rules.redBull.gpLossPerRace, 0, 100));
    if (r.gpRetention <= 0 && !r.gpTransferred) {
      r.gpTransferred = true;
      const gp = state.teams.red_bull?.staff.raceEngineer;
      if (gp && state.teams.mclaren) state.teams.mclaren.staff.raceEngineer = { ...gp, id: gp.id ? `${gp.id}-mclaren` : 'gp-mclaren' };
      addNews(state, '员工', 'GP 接受迈凯伦邀请，将离开红牛并加入迈凯伦。');
    }
    const midpoint = Math.ceil(state.calendar.length / 2);
    if (!r.summerChecked && state.season.roundIndex + 1 >= midpoint) {
      r.summerChecked = true;
      const pos = driverPosition(state, 'verstappen');
      if (pos < 1 || pos > 3) {
        r.verstappenExit = true;
        addNews(state, '车手', `夏休到来时维斯塔潘仅列车手榜第 ${pos}，其解约条款已触发，梅赛德斯开始推进签约。`);
        addNarration(state, 'verstappen_clause', '维斯塔潘触发解约条款', `维斯塔潘在夏休时未进入积分榜前三，合同解约条款生效。他通知车队将转投梅赛德斯。`);
      } else addNews(state, '车手', `夏休检查：维斯塔潘位列车手榜第 ${pos}，解约条款没有触发。`);
    }
  }
}

export function dismissalReason(state: GameState): string | null {
  return state.ferrari?.dismissed ?? state.mercedes?.dismissed ?? null;
}

export function redBullCrashMultiplier(state: GameState, teamId: string): number {
  return state.redBull && teamId === 'red_bull' ? state.rules.redBull.mistakeMultiplier : 1;
}

export function specialFailureChance(state: GameState, type: 'mclaren_pu' | 'mercedes_pu'): number {
  if (type === 'mclaren_pu') return state.mclaren && !state.mclaren.softwareResolved ? state.rules.mclaren.failureChance : 0;
  return state.mercedes && !state.mercedes.aduoApproved ? state.rules.mercedes.failureChance : 0;
}
