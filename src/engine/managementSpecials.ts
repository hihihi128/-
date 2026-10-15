import { addNarration, addNews, playerTeam } from './log';
import { PU_PART_TYPES } from './powerunit';
import type { Action, GameState, PartSpec, PartType, TeamState } from './types';
import { clamp, pushCapped, round1, round2, stamp } from './util';

const CAP = 12;
const weekKey = (state: GameState) => `${state.season.number}-w${state.season.week}`;
const raceKey = (state: GameState) => `${state.season.number}-${state.season.roundIndex}`;
const append = (state: GameState, target: { log: Array<{ at: string; text: string }> }, text: string) => pushCapped(target.log, { at: stamp(state), text }, CAP);
const DIRECTIONS: PartType[][] = [
  ['chassis', 'sidepods'],
  ['floor', 'front_wing'],
  ['suspension', 'rear_wing'],
  ['gearbox', 'chassis'],
];

export function applyAlpinePuPenalty(state: GameState, team: TeamState, partType: PartType, spec: PartSpec): void {
  const alpine = state.alpine;
  if (!alpine?.integrationPenaltyActive || team.special !== 'alpine') return;
  const key = `${partType}:${spec.id}`;
  const tracked = alpine.penalizedPowerSpecs[key];
  if (tracked && spec.perf === tracked.perfAfter && spec.rel === tracked.relAfter) return;
  spec.perf = round1(Math.max(1, spec.perf - 4));
  spec.rel = round1(clamp(spec.rel - 5, 1, 100));
  alpine.penalizedPowerSpecs[key] = { partType, specId: spec.id, perfAfter: spec.perf, relAfter: spec.rel };
}

function restoreAlpinePuSpecs(state: GameState): void {
  const alpine = state.alpine;
  const team = Object.values(state.teams).find(value => value.special === 'alpine');
  if (!alpine || !team) return;
  for (const { partType, specId } of Object.values(alpine.penalizedPowerSpecs)) {
    const spec = team.parts[partType]?.specs.find(value => value.id === specId);
    if (!spec) continue;
    spec.perf = round1(spec.perf + 4);
    spec.rel = round1(clamp(spec.rel + 5, 1, 100));
  }
  alpine.penalizedPowerSpecs = {};
}

export function settleLegacyAlpinePenalty(state: GameState): void {
  restoreAlpinePuSpecs(state);
  if (state.alpine) state.alpine.integrationPenaltyActive = false;
}

export function initManagementSpecials(state: GameState, preserveExisting = false): void {
  const r = state.rules;
  const alpineTeam = Object.values(state.teams).find(value => value.special === 'alpine');
  const initializeAlpine = !preserveExisting || !state.alpine;
  if (initializeAlpine) state.alpine = alpineTeam ? {
    briatoreSatisfaction: r.alpine.startBriatoreSatisfaction,
    fanPressure: r.alpine.startFanPressure,
    gaslyCommitment: r.alpine.startGaslyCommitment,
    puIntegration: r.alpine.startPuIntegration,
    integrationPenaltyActive: true,
    penalizedPowerSpecs: {},
    rndDirection: [...DIRECTIONS[0]],
    lastActionRound: null,
    lastActionRace: null,
    gaslyLeaving: false,
    dismissed: null,
    log: [],
  } : null;
  if (initializeAlpine && state.alpine && alpineTeam) for (const partType of PU_PART_TYPES) {
    for (const spec of alpineTeam.parts[partType]?.specs ?? []) applyAlpinePuPenalty(state, alpineTeam, partType, spec);
  }
  if (!preserveExisting || !state.haas) state.haas = Object.values(state.teams).some(value => value.special === 'haas') ? {
    geneSupport: r.haas.startGeneSupport,
    toyotaSupport: r.haas.startToyotaSupport,
    toyotaInfluence: r.haas.startToyotaInfluence,
    fundingProvided: 0,
    preferredParts: [...DIRECTIONS[1]],
    lastActionRound: null,
    lastActionRace: null,
    partnershipWithdrawn: false,
    dismissed: null,
    log: [],
  } : null;
  if (!preserveExisting || !state.williams) state.williams = Object.values(state.teams).some(value => value.special === 'williams') ? {
    vowlesConfidence: r.williams.startVowlesConfidence,
    successionReadiness: r.williams.startSuccessionReadiness,
    focus: null,
    focusRound: null,
    focusRace: null,
    facilityInvestment: 0,
    developmentInvestment: 0,
    vowlesDeparted: false,
    confirmedSuccessor: false,
    log: [],
  } : null;
  if (!preserveExisting || !state.randomEvents) state.randomEvents = { lastRoundKey: null, weekKey: null, weeklyQuota: 0, weeklyStarted: 0, current: null, history: [] };
}

export function alpineManagement(state: GameState, strategy: 'back_colapinto' | 'reassure_gasly' | 'integrate_power_unit'): { ok: boolean; message: string } {
  if (playerTeam(state).special !== 'alpine') return { ok: false, message: '当前车队没有阿尔派管理机制' };
  return applyAlpineManagement(state, strategy);
}

function applyAlpineManagement(state: GameState, strategy: 'back_colapinto' | 'reassure_gasly' | 'integrate_power_unit'): { ok: boolean; message: string } {
  const a = state.alpine;
  if (!a) return { ok: false, message: '当前车队没有阿尔派管理机制' };
  if (a.lastActionRound === weekKey(state)) return { ok: false, message: '每周只能执行一次阿尔派管理行动' };
  a.lastActionRound = weekKey(state);
  a.lastActionRace = raceKey(state);
  let text: string;
  if (strategy === 'back_colapinto') {
    a.fanPressure = round1(clamp(a.fanPressure - 14, 0, 100));
    a.gaslyCommitment = round1(clamp(a.gaslyCommitment - 8, 0, 100));
    a.briatoreSatisfaction = round1(clamp(a.briatoreSatisfaction + 4, 0, 100));
    text = `${state.teams.alpine?.isPlayer ? '玩家' : '阿尔派管理层'}公开支持科拉平托，并要求车队避免把赛道事故责任全部推给他。粉丝压力下降，但加斯利感到被冷落。`;
  } else if (strategy === 'reassure_gasly') {
    a.fanPressure = round1(clamp(a.fanPressure + 7, 0, 100));
    a.gaslyCommitment = round1(clamp(a.gaslyCommitment + 14, 0, 100));
    a.briatoreSatisfaction = round1(clamp(a.briatoreSatisfaction - 3, 0, 100));
    text = `${state.teams.alpine?.isPlayer ? '玩家' : '阿尔派管理层'}向加斯利保证公平待遇和核心地位。加斯利留队意愿回升，但科拉平托粉丝开始质疑车队。`;
  } else {
    a.puIntegration = Math.min(100, a.puIntegration + state.rules.alpine.integrationGain);
    a.fanPressure = round1(clamp(a.fanPressure + 3, 0, 100));
    a.briatoreSatisfaction = round1(clamp(a.briatoreSatisfaction + 1, 0, 100));
    text = `车队把本周管理资源投入梅赛德斯动力单元与 A526 的匹配，适配进度达到 ${a.puIntegration}%。`;
    if (a.puIntegration >= 100 && a.integrationPenaltyActive) {
      restoreAlpinePuSpecs(state);
      a.integrationPenaltyActive = false;
      text += '早期性能和可靠性损失已经消除。';
    }
  }
  append(state, a, text); addNews(state, '车队', text);
  return { ok: true, message: text };
}

export function alpineOnPriority(state: GameState, driverId: string | null): void {
  if (playerTeam(state).special !== 'alpine') return;
  const a = state.alpine;
  if (!a) return;
  if (driverId === 'colapinto') {
    a.fanPressure = round1(clamp(a.fanPressure - 10, 0, 100));
    a.gaslyCommitment = round1(clamp(a.gaslyCommitment - 9, 0, 100));
  } else if (driverId === 'gasly') {
    a.fanPressure = round1(clamp(a.fanPressure + 12, 0, 100));
    a.gaslyCommitment = round1(clamp(a.gaslyCommitment + 7, 0, 100));
  } else {
    a.fanPressure = round1(clamp(a.fanPressure + 4, 0, 100));
    a.gaslyCommitment = round1(clamp(a.gaslyCommitment + 3, 0, 100));
  }
}

export function haasBalance(state: GameState, strategy: 'protect_independence' | 'accept_toyota' | 'compromise'): { ok: boolean; message: string } {
  if (playerTeam(state).special !== 'haas') return { ok: false, message: '当前车队没有哈斯股东平衡机制' };
  return applyHaasBalance(state, strategy);
}

function applyHaasBalance(state: GameState, strategy: 'protect_independence' | 'accept_toyota' | 'compromise'): { ok: boolean; message: string } {
  const h = state.haas;
  if (!h) return { ok: false, message: '当前车队没有哈斯股东平衡机制' };
  if (h.lastActionRound === weekKey(state)) return { ok: false, message: '每周只能执行一次哈斯股东行动' };
  h.lastActionRound = weekKey(state);
  h.lastActionRace = raceKey(state);
  const team = Object.values(state.teams).find(value => value.special === 'haas');
  if (!team) return { ok: false, message: '哈斯车队数据缺失' };
  let text: string;
  if (strategy === 'protect_independence') {
    h.geneSupport = round1(clamp(h.geneSupport + 12, 0, 100));
    h.toyotaSupport = round1(clamp(h.toyotaSupport - 8, 0, 100));
    h.toyotaInfluence = round1(clamp(h.toyotaInfluence - 3, 0, 100));
    text = `${team.isPlayer ? '玩家' : '哈斯管理层'}支持吉恩·哈斯保留最终决定权。车队独立性增强，但丰田放慢资源投入。`;
  } else if (strategy === 'accept_toyota') {
    h.geneSupport = round1(clamp(h.geneSupport - 8, 0, 100));
    h.toyotaSupport = round1(clamp(h.toyotaSupport + 12, 0, 100));
    h.toyotaInfluence = round1(clamp(h.toyotaInfluence + 10, 0, 100));
    team.funds = round2(team.funds + 5);
    h.fundingProvided = round2(h.fundingProvided + 5);
    text = `${team.isPlayer ? '玩家' : '哈斯管理层'}接受丰田追加技术与资金支持。车队获得 $5.0M，但丰田对日常事务的影响明显扩大。`;
  } else {
    h.geneSupport = round1(clamp(h.geneSupport + 4, 0, 100));
    h.toyotaSupport = round1(clamp(h.toyotaSupport + 5, 0, 100));
    h.toyotaInfluence = round1(clamp(h.toyotaInfluence + 4, 0, 100));
    team.funds = round2(team.funds + 2);
    h.fundingProvided = round2(h.fundingProvided + 2);
    text = `${team.isPlayer ? '玩家' : '哈斯管理层'}达成折中：丰田提供 $2.0M，吉恩·哈斯保留关键否决权。`;
  }
  append(state, h, text); addNews(state, '股东', text);
  return { ok: true, message: text };
}

export function williamsBudgetFocus(state: GameState, focus: 'facilities' | 'development' | 'reserve'): { ok: boolean; message: string } {
  if (playerTeam(state).special !== 'williams') return { ok: false, message: '当前车队没有威廉姆斯接班机制' };
  return applyWilliamsBudgetFocus(state, focus);
}

function applyWilliamsBudgetFocus(state: GameState, focus: 'facilities' | 'development' | 'reserve'): { ok: boolean; message: string } {
  const w = state.williams;
  if (!w) return { ok: false, message: '当前车队没有威廉姆斯接班机制' };
  const key = weekKey(state);
  if (w.focusRound === key) return { ok: false, message: '本周预算方向已经确定' };
  w.focus = focus; w.focusRound = key; w.focusRace = raceKey(state);
  const label = focus === 'facilities' ? '设施更新' : focus === 'development' ? '赛车升级' : '保留现金';
  const text = `${state.teams.williams?.isPlayer ? '玩家' : '威廉姆斯管理层'}把本周有限预算的优先级设为${label}。`;
  append(state, w, text); addNews(state, '预算', text);
  return { ok: true, message: text };
}

export function managementActionBlocker(state: GameState, action: Action): string | null {
  const special = playerTeam(state).special;
  if (action.type === 'START_PROJECT') {
    if (special === 'alpine' && state.alpine && !state.alpine.rndDirection.includes(action.partType)) return `布里亚托利已经决定本阶段只研发：${state.alpine.rndDirection.map(type => state.rules.parts[type]?.name ?? type).join('、')}`;
    if (special === 'haas' && state.haas && state.haas.toyotaInfluence >= state.rules.haas.interferenceThreshold && !state.haas.preferredParts.includes(action.partType)) return `丰田当前要求研发资源集中在：${state.haas.preferredParts.map(type => state.rules.parts[type]?.name ?? type).join('、')}`;
    if (special === 'williams' && state.williams && (state.williams.focusRound !== weekKey(state) || state.williams.focus !== 'development')) return '请先把威廉姆斯本周预算方向设为赛车升级';
  }
  if (action.type === 'UPGRADE_FACILITY' && special === 'williams' && state.williams && (state.williams.focusRound !== weekKey(state) || state.williams.focus !== 'facilities')) return '请先把威廉姆斯本周预算方向设为设施更新';
  return null;
}

export function recordManagementInvestment(state: GameState, action: Action, ok: boolean): void {
  if (!ok || playerTeam(state).special !== 'williams' || !state.williams) return;
  const team = playerTeam(state);
  if (action.type === 'START_PROJECT') {
    const project = team.projects[team.projects.length - 1];
    state.williams.developmentInvestment = round2(state.williams.developmentInvestment + (project?.cost ?? 0));
    state.williams.successionReadiness = round1(clamp(state.williams.successionReadiness + 3, 0, 100));
  }
  if (action.type === 'UPGRADE_FACILITY') {
    const project = team.projects[team.projects.length - 1];
    state.williams.facilityInvestment = round2(state.williams.facilityInvestment + (project?.cost ?? 0));
    state.williams.successionReadiness = round1(clamp(state.williams.successionReadiness + 4, 0, 100));
  }
}

export function afterManagementRace(state: GameState): void {
  const key = raceKey(state);
  if (state.alpine) {
    const a = state.alpine;
    if (a.lastActionRace !== key) { a.briatoreSatisfaction -= 5; a.fanPressure += 5; a.gaslyCommitment -= 4; }
    if (a.fanPressure > 70) a.briatoreSatisfaction -= 3;
    if (a.gaslyCommitment < 25) a.gaslyCommitment -= 3;
    a.briatoreSatisfaction = round1(clamp(a.briatoreSatisfaction, 0, 100));
    a.fanPressure = round1(clamp(a.fanPressure, 0, 100));
    a.gaslyCommitment = round1(clamp(a.gaslyCommitment, 0, 100));
    if (a.gaslyCommitment <= 0 && !a.gaslyLeaving) {
      a.gaslyLeaving = true;
      const text = '长期偏袒科拉平托使加斯利失去信心。他通知车队，赛季结束后不会续约。';
      if (state.teams.alpine?.isPlayer) addNarration(state, 'gasly_exit', '加斯利决定离开阿尔派', text);
      else addNews(state, '车手', `阿尔派：${text}`);
    }
    if (a.briatoreSatisfaction < state.rules.alpine.dismissBriatoreSatisfaction && !a.dismissed) {
      if (state.teams.alpine?.isPlayer) {
        a.dismissed = `布里亚托利满意度降至 ${a.briatoreSatisfaction}`;
        state.flags.fired = true;
        state.flags.firedReason = a.dismissed;
      } else {
        a.briatoreSatisfaction = Math.max(state.rules.alpine.dismissBriatoreSatisfaction + 8, state.rules.alpine.startBriatoreSatisfaction - 10);
        addNews(state, '车队', '阿尔派因管理层满意度过低调整了领队分工。');
      }
    }
    if ((state.season.roundIndex + 1) % 3 === 0) { a.rndDirection = [...DIRECTIONS[Math.floor((state.season.roundIndex + 1) / 3) % DIRECTIONS.length]]; addNews(state, '研发', `布里亚托利将下一阶段研发方向定为${a.rndDirection.map(type => state.rules.parts[type]?.name ?? type).join('与')}。`); }
  }
  if (state.haas) {
    const h = state.haas;
    const team = Object.values(state.teams).find(value => value.special === 'haas');
    if (team) {
      h.toyotaInfluence = round1(clamp(h.toyotaInfluence + state.rules.haas.influencePerRace, 0, 100));
      if (h.lastActionRace !== key) { h.geneSupport -= 4; h.toyotaSupport -= 4; }
      if (!h.partnershipWithdrawn && h.toyotaSupport > 20) {
        const grant = round2(0.3 + h.toyotaInfluence / 100);
        team.funds = round2(team.funds + grant); h.fundingProvided = round2(h.fundingProvided + grant);
      }
      h.geneSupport = round1(clamp(h.geneSupport, 0, 100)); h.toyotaSupport = round1(clamp(h.toyotaSupport, 0, 100));
      if (h.toyotaSupport <= 10 && !h.partnershipWithdrawn) { h.partnershipWithdrawn = true; addNews(state, '股东', '丰田冻结进一步资金与技术投入。'); }
      if (h.geneSupport < state.rules.haas.dismissGeneSupport && !h.dismissed) {
        if (team.isPlayer) {
          h.dismissed = `吉恩·哈斯支持度降至 ${h.geneSupport}`;
          state.flags.fired = true;
          state.flags.firedReason = h.dismissed;
        } else {
          h.geneSupport = Math.max(state.rules.haas.dismissGeneSupport + 8, state.rules.haas.startGeneSupport - 10);
          addNews(state, '车队', '哈斯因股东支持不足调整了管理架构。');
        }
      }
      if ((state.season.roundIndex + 1) % 3 === 0) h.preferredParts = [...DIRECTIONS[(Math.floor((state.season.roundIndex + 1) / 3) + 1) % DIRECTIONS.length]];
    }
  }
  if (state.williams) {
    const w = state.williams;
    if (w.focusRace !== key) { w.vowlesConfidence -= 4; w.successionReadiness -= 2; }
    else if (w.focus === 'reserve') { w.vowlesConfidence += 1; w.successionReadiness += 1; }
    w.vowlesConfidence = round1(clamp(w.vowlesConfidence, 0, 100)); w.successionReadiness = round1(clamp(w.successionReadiness, 0, 100));
  }
}

/** 让非玩家车队按周处理管理型特殊机制。 */
export function advanceAiManagementSpecial(state: GameState, team: TeamState): void {
  if (team.isPlayer) return;
  if (team.special === 'alpine' && state.alpine?.lastActionRound !== weekKey(state)) {
    const strategy = state.alpine!.integrationPenaltyActive
      ? 'integrate_power_unit'
      : state.alpine!.gaslyCommitment < 45 ? 'reassure_gasly' : 'back_colapinto';
    applyAlpineManagement(state, strategy);
  } else if (team.special === 'haas' && state.haas?.lastActionRound !== weekKey(state)) {
    const strategy = team.funds < 15 && state.haas!.geneSupport > state.rules.haas.dismissGeneSupport + 12
      ? 'accept_toyota'
      : 'protect_independence';
    applyHaasBalance(state, strategy);
  } else if (team.special === 'williams' && state.williams?.focusRound !== weekKey(state)) {
    const choices = ['development', 'facilities', 'reserve'] as const;
    applyWilliamsBudgetFocus(state, choices[state.season.week % choices.length]);
  }
}

export function completeWilliamsHandover(state: GameState): void {
  const w = state.williams;
  if (!w || w.vowlesDeparted || state.season.number !== 1) return;
  w.vowlesDeparted = true;
  const isPlayer = state.teams.williams?.isPlayer === true;
  if ((!isPlayer || !state.flags.fired) && w.vowlesConfidence >= state.rules.williams.dismissVowlesConfidence && w.successionReadiness >= state.rules.williams.successionThreshold) {
    w.confirmedSuccessor = true;
    const text = `${state.season.year} 赛季结束后，James Vowles 返回梅赛德斯。董事会确认接班计划正式完成。`;
    if (isPlayer) addNarration(state, 'williams_handover', '沃尔斯返回梅赛德斯', `${text} 玩家接任威廉姆斯正式领队。`);
    else addNews(state, '车队', `威廉姆斯：${text}`);
  } else {
    const text = '沃尔斯返回梅赛德斯后，董事会延长了威廉姆斯接班考核。';
    if (isPlayer) addNarration(state, 'williams_handover_delayed', '威廉姆斯延长接班考核', `${text} 玩家暂未转正。`);
    else addNews(state, '车队', text);
  }
}

export function completeAlpineDriverExit(state: GameState): void {
  if (!state.alpine?.gaslyLeaving) return;
  const driver = state.drivers.gasly;
  const team = state.teams.alpine;
  const car = team?.cars.find(value => value.driverId === 'gasly');
  if (!driver || !team || !car) return;
  car.driverId = null;
  driver.teamId = null;
  state.alpine.gaslyLeaving = false;
  state.alpine.gaslyCommitment = state.rules.alpine.startGaslyCommitment;
  addNews(state, '车手', '加斯利拒绝与阿尔派续约，赛季结束后成为自由车手。');
  const text = '长期的队内失衡最终造成实际后果。加斯利在合同市场开放前离队，阿尔派必须签下一名新车手。';
  if (state.teams.alpine?.isPlayer) addNarration(state, 'gasly_departure', '加斯利离开阿尔派', text);
  else addNews(state, '车手', text);
}
