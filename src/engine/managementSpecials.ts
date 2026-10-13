import { addNarration, addNews, playerTeam } from './log';
import type { Action, GameState, PartType, TeamState } from './types';
import { clamp, pushCapped, round1, round2, stamp } from './util';

const CAP = 12;
const roundKey = (state: GameState) => `${state.season.number}-${state.season.roundIndex}`;
const append = (state: GameState, target: { log: Array<{ at: string; text: string }> }, text: string) => pushCapped(target.log, { at: stamp(state), text }, CAP);
const DIRECTIONS: PartType[][] = [
  ['chassis', 'sidepods'],
  ['floor', 'front_wing'],
  ['suspension', 'rear_wing'],
  ['gearbox', 'chassis'],
];

function adjustCurrentSpecs(team: TeamState, types: PartType[], perf: number, rel: number): void {
  const seen = new Set<string>();
  for (const car of team.cars) for (const type of types) {
    const spec = team.parts[type]?.specs.find(value => value.id === car.fitted[type]);
    if (!spec || seen.has(spec.id)) continue;
    spec.perf = round1(Math.max(1, spec.perf + perf));
    spec.rel = round1(clamp(spec.rel + rel, 1, 100));
    seen.add(spec.id);
  }
}

export function initManagementSpecials(state: GameState, team: TeamState): void {
  const r = state.rules;
  state.alpine = team.special === 'alpine' ? {
    briatoreSatisfaction: r.alpine.startBriatoreSatisfaction,
    fanPressure: r.alpine.startFanPressure,
    gaslyCommitment: r.alpine.startGaslyCommitment,
    puIntegration: r.alpine.startPuIntegration,
    integrationPenaltyActive: true,
    rndDirection: [...DIRECTIONS[0]],
    lastActionRound: null,
    gaslyLeaving: false,
    dismissed: null,
    log: [],
  } : null;
  if (state.alpine) adjustCurrentSpecs(team, ['power_unit', 'ers'], -4, -5);
  state.haas = team.special === 'haas' ? {
    geneSupport: r.haas.startGeneSupport,
    toyotaSupport: r.haas.startToyotaSupport,
    toyotaInfluence: r.haas.startToyotaInfluence,
    fundingProvided: 0,
    preferredParts: [...DIRECTIONS[1]],
    lastActionRound: null,
    partnershipWithdrawn: false,
    dismissed: null,
    log: [],
  } : null;
  state.williams = team.special === 'williams' ? {
    vowlesConfidence: r.williams.startVowlesConfidence,
    successionReadiness: r.williams.startSuccessionReadiness,
    focus: null,
    focusRound: null,
    facilityInvestment: 0,
    developmentInvestment: 0,
    vowlesDeparted: false,
    confirmedSuccessor: false,
    dismissed: null,
    log: [],
  } : null;
  state.randomEvents = { lastRoundKey: null, current: null, history: [] };
}

export function alpineManagement(state: GameState, strategy: 'back_colapinto' | 'reassure_gasly' | 'integrate_power_unit'): { ok: boolean; message: string } {
  const a = state.alpine;
  if (!a) return { ok: false, message: '当前车队没有阿尔派管理机制' };
  if (a.lastActionRound === roundKey(state)) return { ok: false, message: '每站只能执行一次阿尔派管理行动' };
  a.lastActionRound = roundKey(state);
  let text: string;
  if (strategy === 'back_colapinto') {
    a.fanPressure = round1(clamp(a.fanPressure - 14, 0, 100));
    a.gaslyCommitment = round1(clamp(a.gaslyCommitment - 8, 0, 100));
    a.briatoreSatisfaction = round1(clamp(a.briatoreSatisfaction + 4, 0, 100));
    text = '玩家公开支持克拉平托，并要求车队避免把赛道事故责任全部推给他。粉丝压力下降，但加斯利感到被冷落。';
  } else if (strategy === 'reassure_gasly') {
    a.fanPressure = round1(clamp(a.fanPressure + 7, 0, 100));
    a.gaslyCommitment = round1(clamp(a.gaslyCommitment + 14, 0, 100));
    a.briatoreSatisfaction = round1(clamp(a.briatoreSatisfaction - 3, 0, 100));
    text = '玩家向加斯利保证公平待遇和核心地位。加斯利留队意愿回升，但克拉平托粉丝开始质疑车队。';
  } else {
    a.puIntegration = Math.min(100, a.puIntegration + state.rules.alpine.integrationGain);
    a.fanPressure = round1(clamp(a.fanPressure + 3, 0, 100));
    a.briatoreSatisfaction = round1(clamp(a.briatoreSatisfaction + 1, 0, 100));
    text = `车队把本周管理资源投入梅赛德斯动力单元与 A526 的匹配，适配进度达到 ${a.puIntegration}%。`;
    if (a.puIntegration >= 100 && a.integrationPenaltyActive) {
      a.integrationPenaltyActive = false;
      adjustCurrentSpecs(state.teams.alpine, ['power_unit', 'ers'], 4, 5);
      text += '早期性能和可靠性损失已经消除。';
    }
  }
  append(state, a, text); addNews(state, '车队', text);
  return { ok: true, message: text };
}

export function alpineOnPriority(state: GameState, driverId: string | null): void {
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
  const h = state.haas;
  if (!h) return { ok: false, message: '当前车队没有哈斯股东平衡机制' };
  if (h.lastActionRound === roundKey(state)) return { ok: false, message: '每站只能执行一次哈斯股东行动' };
  h.lastActionRound = roundKey(state);
  const team = playerTeam(state);
  let text: string;
  if (strategy === 'protect_independence') {
    h.geneSupport = round1(clamp(h.geneSupport + 12, 0, 100));
    h.toyotaSupport = round1(clamp(h.toyotaSupport - 8, 0, 100));
    h.toyotaInfluence = round1(clamp(h.toyotaInfluence - 3, 0, 100));
    text = '玩家支持吉恩·哈斯保留最终决定权。车队独立性增强，但丰田放慢资源投入。';
  } else if (strategy === 'accept_toyota') {
    h.geneSupport = round1(clamp(h.geneSupport - 8, 0, 100));
    h.toyotaSupport = round1(clamp(h.toyotaSupport + 12, 0, 100));
    h.toyotaInfluence = round1(clamp(h.toyotaInfluence + 10, 0, 100));
    team.funds = round2(team.funds + 5);
    h.fundingProvided = round2(h.fundingProvided + 5);
    text = '玩家接受丰田追加技术与资金支持。车队获得 $5.0M，但丰田对日常事务的影响明显扩大。';
  } else {
    h.geneSupport = round1(clamp(h.geneSupport + 4, 0, 100));
    h.toyotaSupport = round1(clamp(h.toyotaSupport + 5, 0, 100));
    h.toyotaInfluence = round1(clamp(h.toyotaInfluence + 4, 0, 100));
    team.funds = round2(team.funds + 2);
    h.fundingProvided = round2(h.fundingProvided + 2);
    text = '玩家达成折中：丰田提供 $2.0M，吉恩·哈斯保留关键否决权。';
  }
  append(state, h, text); addNews(state, '股东', text);
  return { ok: true, message: text };
}

export function williamsBudgetFocus(state: GameState, focus: 'facilities' | 'development' | 'reserve'): { ok: boolean; message: string } {
  const w = state.williams;
  if (!w) return { ok: false, message: '当前车队没有威廉姆斯接班机制' };
  const key = roundKey(state);
  if (w.focusRound === key) return { ok: false, message: '本站预算方向已经确定' };
  w.focus = focus; w.focusRound = key;
  const label = focus === 'facilities' ? '设施更新' : focus === 'development' ? '赛车升级' : '保留现金';
  const text = `玩家把本站有限预算的优先级设为${label}。`;
  append(state, w, text); addNews(state, '预算', text);
  return { ok: true, message: text };
}

export function managementActionBlocker(state: GameState, action: Action): string | null {
  if (action.type === 'START_PROJECT') {
    if (state.alpine && !state.alpine.rndDirection.includes(action.partType)) return `布里亚托已经决定本阶段只研发：${state.alpine.rndDirection.map(type => state.rules.parts[type]?.name ?? type).join('、')}`;
    if (state.haas && state.haas.toyotaInfluence >= state.rules.haas.interferenceThreshold && !state.haas.preferredParts.includes(action.partType)) return `丰田当前要求研发资源集中在：${state.haas.preferredParts.map(type => state.rules.parts[type]?.name ?? type).join('、')}`;
    if (state.williams && (state.williams.focusRound !== roundKey(state) || state.williams.focus !== 'development')) return '请先把威廉姆斯本站预算方向设为赛车升级';
  }
  if (action.type === 'UPGRADE_FACILITY' && state.williams && (state.williams.focusRound !== roundKey(state) || state.williams.focus !== 'facilities')) return '请先把威廉姆斯本站预算方向设为设施更新';
  return null;
}

export function recordManagementInvestment(state: GameState, action: Action, ok: boolean): void {
  if (!ok || !state.williams) return;
  if (action.type === 'START_PROJECT') {
    const project = playerTeam(state).projects[playerTeam(state).projects.length - 1];
    state.williams.developmentInvestment = round2(state.williams.developmentInvestment + (project?.cost ?? 0));
    state.williams.successionReadiness = round1(clamp(state.williams.successionReadiness + 3, 0, 100));
  }
  if (action.type === 'UPGRADE_FACILITY') {
    const project = playerTeam(state).projects[playerTeam(state).projects.length - 1];
    state.williams.facilityInvestment = round2(state.williams.facilityInvestment + (project?.cost ?? 0));
    state.williams.successionReadiness = round1(clamp(state.williams.successionReadiness + 4, 0, 100));
  }
}

export function afterManagementRace(state: GameState): void {
  const key = roundKey(state);
  if (state.alpine) {
    const a = state.alpine;
    if (a.lastActionRound !== key) { a.briatoreSatisfaction -= 5; a.fanPressure += 5; a.gaslyCommitment -= 4; }
    if (a.fanPressure > 70) a.briatoreSatisfaction -= 3;
    if (a.gaslyCommitment < 25) a.gaslyCommitment -= 3;
    a.briatoreSatisfaction = round1(clamp(a.briatoreSatisfaction, 0, 100));
    a.fanPressure = round1(clamp(a.fanPressure, 0, 100));
    a.gaslyCommitment = round1(clamp(a.gaslyCommitment, 0, 100));
    if (a.gaslyCommitment <= 0 && !a.gaslyLeaving) { a.gaslyLeaving = true; addNarration(state, 'gasly_exit', '加斯利决定离开阿尔派', '长期偏袒克拉平托使加斯利失去信心。他通知车队，赛季结束后不会续约。'); }
    if (a.briatoreSatisfaction < state.rules.alpine.dismissBriatoreSatisfaction && !a.dismissed) { a.dismissed = `布里亚托满意度降至 ${a.briatoreSatisfaction}`; state.flags.fired = true; state.flags.firedReason = a.dismissed; }
    if ((state.season.roundIndex + 1) % 3 === 0) { a.rndDirection = [...DIRECTIONS[Math.floor((state.season.roundIndex + 1) / 3) % DIRECTIONS.length]]; addNews(state, '研发', `布里亚托将下一阶段研发方向定为${a.rndDirection.map(type => state.rules.parts[type]?.name ?? type).join('与')}。`); }
  }
  if (state.haas) {
    const h = state.haas;
    h.toyotaInfluence = round1(clamp(h.toyotaInfluence + state.rules.haas.influencePerRace, 0, 100));
    if (h.lastActionRound !== key) { h.geneSupport -= 4; h.toyotaSupport -= 4; }
    if (!h.partnershipWithdrawn && h.toyotaSupport > 20) {
      const grant = round2(0.3 + h.toyotaInfluence / 100);
      playerTeam(state).funds = round2(playerTeam(state).funds + grant); h.fundingProvided = round2(h.fundingProvided + grant);
    }
    h.geneSupport = round1(clamp(h.geneSupport, 0, 100)); h.toyotaSupport = round1(clamp(h.toyotaSupport, 0, 100));
    if (h.toyotaSupport <= 10 && !h.partnershipWithdrawn) { h.partnershipWithdrawn = true; addNews(state, '股东', '丰田冻结进一步资金与技术投入。'); }
    if (h.geneSupport < state.rules.haas.dismissGeneSupport && !h.dismissed) { h.dismissed = `吉恩·哈斯支持度降至 ${h.geneSupport}`; state.flags.fired = true; state.flags.firedReason = h.dismissed; }
    if ((state.season.roundIndex + 1) % 3 === 0) h.preferredParts = [...DIRECTIONS[(Math.floor((state.season.roundIndex + 1) / 3) + 1) % DIRECTIONS.length]];
  }
  if (state.williams) {
    const w = state.williams;
    if (w.focusRound !== key) { w.vowlesConfidence -= 4; w.successionReadiness -= 2; }
    else if (w.focus === 'reserve') { w.vowlesConfidence += 1; w.successionReadiness += 1; }
    w.vowlesConfidence = round1(clamp(w.vowlesConfidence, 0, 100)); w.successionReadiness = round1(clamp(w.successionReadiness, 0, 100));
    w.focus = null;
  }
}

export function completeWilliamsHandover(state: GameState): void {
  const w = state.williams;
  if (!w || w.vowlesDeparted || state.season.year !== 2026) return;
  w.vowlesDeparted = true;
  if (w.vowlesConfidence >= state.rules.williams.dismissVowlesConfidence && w.successionReadiness >= state.rules.williams.successionThreshold) {
    w.confirmedSuccessor = true;
    addNarration(state, 'williams_handover', '沃尔斯返回梅赛德斯', '2026 赛季结束后，James Vowles 返回梅赛德斯。董事会确认玩家接任威廉姆斯正式领队。');
  } else {
    addNarration(state, 'williams_handover_delayed', '威廉姆斯延长接班考核', '沃尔斯返回梅赛德斯后，董事会认为玩家尚未准备好正式接任。玩家暂时继续主持车队，但必须与外部候选人竞争。');
  }
}
