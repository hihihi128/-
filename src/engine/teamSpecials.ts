import { addNarration, addNews, playerTeam } from './log';
import { affordError, charge } from './finance';
import { recordPuFit, resetPuUsage } from './powerunit';
import type { GameState, TeamState } from './types';
import { clamp, deepClone, pushCapped, round1, stamp } from './util';

const LOG_CAP = 10;
const weekKey = (state: GameState) => `${state.season.number}-w${state.season.week}`;
const log = (state: GameState, target: { log: Array<{ at: string; text: string }> }, text: string) => pushCapped(target.log, { at: stamp(state), text }, LOG_CAP);

export function initTeamSpecials(state: GameState, preserveExisting = false): void {
  const mclaren = Object.values(state.teams).find(value => value.special === 'mclaren');
  const mercedes = Object.values(state.teams).find(value => value.special === 'mercedes');
  const redBull = Object.values(state.teams).find(value => value.special === 'red_bull');
  if (!preserveExisting || !state.mclaren) state.mclaren = mclaren ? { softwareResolved: false, route: null, weeksLeft: 0, weeksTotal: 0, mercedesBuffApplied: false, log: [] } : null;
  if (!preserveExisting || !state.mercedes) state.mercedes = mercedes ? {
    aduoApproved: false,
    aduoProgress: 0,
    politicalPressure: state.rules.mercedes.startPoliticalPressure,
    compressionRatio: '1:18',
    totoSatisfaction: state.rules.mercedes.startTotoSatisfaction,
    dismissed: null,
    lastActionRound: null,
    log: [],
  } : null;
  if (!preserveExisting || !state.redBull) state.redBull = redBull ? {
    gpRetention: state.rules.redBull.startGpRetention,
    gpTransferred: false,
    summerChecked: false,
    verstappenExit: false,
    lastActionRound: null,
    log: [],
  } : null;
}

export function startMcLarenFix(state: GameState, route: 'independent' | 'mercedes'): { ok: boolean; message: string } {
  if (playerTeam(state).special !== 'mclaren') return { ok: false, message: '当前车队没有迈凯伦软件适配机制' };
  return applyMcLarenFix(state, route);
}

function applyMcLarenFix(state: GameState, route: 'independent' | 'mercedes'): { ok: boolean; message: string } {
  const m = state.mclaren;
  if (!m) return { ok: false, message: '当前车队没有迈凯伦软件适配机制' };
  if (m.softwareResolved) return { ok: false, message: '动力单元软件适配问题已经解决' };
  if (m.route) return { ok: false, message: '专项项目已经启动，不能中途更换路线' };
  m.route = route;
  m.weeksLeft = route === 'independent' ? state.rules.mclaren.independentWeeks : state.rules.mclaren.cooperationWeeks;
  m.weeksTotal = m.weeksLeft;
  const text = route === 'independent'
    ? `迈凯伦启动自主车体与动力单元软件适配项目，预计 ${m.weeksLeft} 周完成。`
    : `迈凯伦与梅赛德斯启动联合适配项目，预计 ${m.weeksLeft} 周完成；迈凯伦将共享车体资料。`;
  log(state, m, text);
  addNews(state, '研发', text);
  if (state.teams.mclaren?.isPlayer) addNarration(state, 'mclaren_fix', '迈凯伦软件适配路线确定', text);
  else addNews(state, '技术', text);
  return { ok: true, message: text };
}

export function mercedesPolitics(state: GameState, strategy: 'lobby_aduo' | 'defend' | 'compromise'): { ok: boolean; message: string } {
  if (playerTeam(state).special !== 'mercedes') return { ok: false, message: '当前车队没有梅赛德斯政治机制' };
  return applyMercedesPolitics(state, strategy);
}

function applyMercedesPolitics(state: GameState, strategy: 'lobby_aduo' | 'defend' | 'compromise'): { ok: boolean; message: string } {
  const m = state.mercedes;
  if (!m) return { ok: false, message: '当前车队没有梅赛德斯政治机制' };
  if (m.dismissed) return { ok: false, message: `你已被 Toto Wolff 撤职：${m.dismissed}` };
  if (m.lastActionRound === weekKey(state)) return { ok: false, message: '每周只能执行一次政治行动' };
  m.lastActionRound = weekKey(state);
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
  if (playerTeam(state).special !== 'red_bull') return { ok: false, message: '当前车队没有红牛 GP 留任机制' };
  return applyRetainGp(state);
}

function applyRetainGp(state: GameState): { ok: boolean; message: string } {
  const r = state.redBull;
  const team = Object.values(state.teams).find(value => value.special === 'red_bull');
  if (!r) return { ok: false, message: '当前车队没有红牛 GP 留任机制' };
  if (!team) return { ok: false, message: '红牛车队数据缺失' };
  if (r.gpTransferred) return { ok: false, message: 'GP 已经决定转投迈凯伦' };
  if (r.lastActionRound === weekKey(state)) return { ok: false, message: '每周只能与 GP 谈判一次' };
  const cost = state.rules.redBull.gpNegotiationCost;
  const paymentError = affordError(team, cost, 'misc', state.rules);
  if (paymentError) return { ok: false, message: paymentError };
  r.lastActionRound = weekKey(state);
  charge(team, cost, 'misc', state.rules);
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
  if (state.teams.mclaren?.isPlayer) addNarration(state, 'mclaren_fix_done', '动力单元软件适配完成', routeText);
  else addNews(state, '技术', `迈凯伦：${routeText}`);
}

/** 让非玩家车队按稳定、可复现的规则处理自己的特殊机制。 */
export function advanceAiTeamSpecial(state: GameState, team: TeamState): void {
  if (team.isPlayer) return;
  if (team.special === 'mclaren' && state.mclaren && !state.mclaren.route) {
    applyMcLarenFix(state, 'independent');
  } else if (team.special === 'mercedes' && state.mercedes && state.mercedes.lastActionRound !== weekKey(state)) {
    const strategy = state.mercedes.politicalPressure >= state.rules.mercedes.banPoliticalPressure - 12
      ? 'defend'
      : state.mercedes.aduoApproved ? 'defend' : 'lobby_aduo';
    applyMercedesPolitics(state, strategy);
  } else if (team.special === 'red_bull' && state.redBull && !state.redBull.gpTransferred
    && state.redBull.gpRetention <= state.rules.redBull.startGpRetention
    && state.redBull.lastActionRound !== weekKey(state)) {
    applyRetainGp(state);
  }
}

function driverPosition(state: GameState, id: string): number {
  return Object.keys(state.standings.drivers).sort((a, b) => {
    const A = state.standings.drivers[a], B = state.standings.drivers[b];
    return B.points - A.points || B.wins - A.wins || (A.best ?? 99) - (B.best ?? 99);
  }).indexOf(id) + 1;
}

function transferGpToMcLaren(state: GameState): void {
  const redBull = state.teams.red_bull;
  const mclaren = state.teams.mclaren;
  const gp = redBull?.staff.raceEngineer;
  if (!redBull || !mclaren || !gp) return;
  const displaced = mclaren.staff.raceEngineer;
  const promoted = redBull.staff.raceEngineer2;
  redBull.staff.raceEngineer = { ...deepClone(promoted), role: 'raceEngineer' };
  redBull.staff.raceEngineer2 = { ...deepClone(displaced), role: 'raceEngineer2' };
  mclaren.staff.raceEngineer = { ...deepClone(gp), role: 'raceEngineer' };
  const window = state.market?.window;
  if (window && window.status !== 'closed') {
    window.projectedRosters.red_bull.staff.raceEngineer = redBull.staff.raceEngineer.id ?? null;
    window.projectedRosters.red_bull.staff.raceEngineer2 = redBull.staff.raceEngineer2.id ?? null;
    window.projectedRosters.mclaren.staff.raceEngineer = mclaren.staff.raceEngineer.id ?? null;
  }
}

function syncDriverPuToCar(state: GameState, driverId: string, car: TeamState['cars'][number]): void {
  const driver = state.drivers[driverId];
  if (!driver) return;
  if (!driver.puUsed) return resetPuUsage(state, driver, car);
  for (const [partType, specId] of Object.entries(car.fitted)) {
    if (driver.puPool?.[partType] && !driver.puPool[partType].includes(specId)) recordPuFit(state, driver.id, partType, specId);
  }
}

function transferVerstappenToMercedes(state: GameState): void {
  const redBull = state.teams.red_bull;
  const mercedes = state.teams.mercedes;
  const max = state.drivers.verstappen;
  if (!redBull || !mercedes || !max) return;
  const maxCar = redBull.cars.find(car => car.driverId === max.id);
  const targetCar = mercedes.cars.find(car => car.slot === 1) ?? mercedes.cars[0];
  const displacedId = targetCar?.driverId;
  if (!maxCar || !targetCar || !displacedId) return;
  const displaced = state.drivers[displacedId];
  maxCar.driverId = displacedId;
  targetCar.driverId = max.id;
  max.teamId = 'mercedes';
  max.role = 'race';
  if (displaced) {
    displaced.teamId = 'red_bull';
    displaced.role = 'race';
  }
  syncDriverPuToCar(state, max.id, targetCar);
  syncDriverPuToCar(state, displacedId, maxCar);
  if (redBull.driverPriority === max.id) redBull.driverPriority = null;
  if (mercedes.driverPriority === displacedId) mercedes.driverPriority = null;
  if (state.weekend?.teamOrders.favorDriverId === max.id || state.weekend?.teamOrders.favorDriverId === displacedId) {
    state.weekend.teamOrders = { mode: 'free', favorDriverId: null };
  }
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
        const spec = team.parts.ice?.specs.find(s => s.id === car.fitted.ice);
        if (spec && !penalized.has(spec.id)) {
          spec.perf = round1(Math.max(1, spec.perf - 2));
          penalized.add(spec.id);
        }
      }
      addNews(state, 'FIA', 'FIA 禁止梅赛德斯利用热胀冷缩维持 1:18 压缩比，动力单元必须恢复 1:16。');
    }
    if (m.totoSatisfaction < state.rules.mercedes.dismissTotoSatisfaction && !m.dismissed) {
      if (state.teams.mercedes?.isPlayer) {
        m.dismissed = `Toto 满意度降至 ${m.totoSatisfaction}`;
        state.flags.fired = true;
        state.flags.firedReason = m.dismissed;
        addNarration(state, 'fired', 'Toto 终止接班人计划', `Toto Wolff 认为玩家没有通过副领队考核，并立即解除职务。${m.dismissed}。`);
      } else {
        m.totoSatisfaction = Math.max(state.rules.mercedes.dismissTotoSatisfaction + 8, state.rules.mercedes.startTotoSatisfaction - 10);
        addNews(state, '车队', 'Toto Wolff 因管理层满意度过低调整了梅赛德斯管理架构。');
      }
    }
  }
  if (state.redBull) {
    const r = state.redBull;
    r.gpRetention = round1(clamp(r.gpRetention - state.rules.redBull.gpLossPerRace, 0, 100));
    if (r.gpRetention <= 0 && !r.gpTransferred) {
      r.gpTransferred = true;
      transferGpToMcLaren(state);
      addNews(state, '员工', 'GP 接受迈凯伦邀请并立即转会。红牛提拔二号车工程师接替他。');
    }
    const midpoint = Math.ceil(state.calendar.length / 2);
    if (!r.summerChecked && state.season.roundIndex + 1 >= midpoint) {
      r.summerChecked = true;
      const pos = driverPosition(state, 'verstappen');
      if (pos < 1 || pos > 3) {
        r.verstappenExit = true;
        transferVerstappenToMercedes(state);
        addNews(state, '车手', `夏休到来时维斯塔潘仅列车手榜第 ${pos}，其解约条款触发并转会梅赛德斯。`);
        if (state.teams.red_bull?.isPlayer || state.teams.mercedes?.isPlayer) addNarration(state, 'verstappen_clause', '维斯塔潘触发解约条款', '维斯塔潘在夏休时未进入积分榜前三，合同解约条款生效。他立即转投梅赛德斯，梅赛德斯原一号车手转入红牛填补席位。');
        else addNews(state, '车手市场', '维斯塔潘触发解约条款并转投梅赛德斯，红牛接收梅赛德斯原一号车手。');
      } else addNews(state, '车手', `夏休检查：维斯塔潘位列车手榜第 ${pos}，解约条款没有触发。`);
    }
  }
}

export function dismissalReason(state: GameState): string | null {
  const special = playerTeam(state).special;
  if (special === 'ferrari') return state.ferrari?.dismissed ?? null;
  if (special === 'mercedes') return state.mercedes?.dismissed ?? null;
  if (special === 'alpine') return state.alpine?.dismissed ?? null;
  if (special === 'haas') return state.haas?.dismissed ?? null;
  return null;
}

export function redBullCrashMultiplier(state: GameState, teamId: string): number {
  return state.redBull && teamId === 'red_bull' ? state.rules.redBull.mistakeMultiplier : 1;
}

export function specialFailureChance(state: GameState, type: 'mclaren_pu' | 'mercedes_pu'): number {
  if (type === 'mclaren_pu') return state.mclaren && !state.mclaren.softwareResolved ? state.rules.mclaren.failureChance : 0;
  return state.mercedes && !state.mercedes.aduoApproved ? state.rules.mercedes.failureChance : 0;
}
