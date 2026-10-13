import { addNarration, addNews, playerTeam } from './log';
import { recordPuFit, resetPuUsage } from './powerunit';
import { Rng } from './rng';
import type { FiaMeetingIssue, GameState, LiveRaceState, TeamState } from './types';
import { clamp, pushCapped, round1, stamp } from './util';

const CAP = 12;
const roundKey = (state: GameState) => `${state.season.number}-${state.season.roundIndex}`;
const append = (state: GameState, target: { log: Array<{ at: string; text: string }> }, text: string) => pushCapped(target.log, { at: stamp(state), text }, CAP);

export function initNextTeamSpecials(state: GameState, team: TeamState): void {
  state.astonMartin = team.special === 'aston_martin' ? {
    aduoEngineArrived: false, aduoProgress: 0, hondaConflict: state.rules.astonMartin.startHondaConflict,
    neweyProgress: 0, chassisUpgradeReady: false, mediaPressure: state.rules.astonMartin.startMediaPressure,
    alonsoFanAnger: 25, strollFavor: 65, lastActionRound: null, log: [],
  } : null;
  state.racingBulls = team.special === 'racing_bulls' ? { pendingRecall: null, activeRecall: null, log: [] } : null;
  state.audi = team.special === 'audi' ? { turboFixed: false, aduoProgress: 0, alliance: null, politicalSupport: 35, lastActionRound: null, log: [] } : null;
  state.fiaMeeting = { politicalCapital: state.rules.fiaMeeting.startPoliticalCapital, completed: 0, current: null, log: [] };
}

function buffCurrentParts(team: TeamState, partTypes: string[], gain: number): void {
  const touched = new Set<string>();
  for (const car of team.cars) for (const partType of partTypes) {
    const spec = team.parts[partType]?.specs.find(value => value.id === car.fitted[partType]);
    if (spec && !touched.has(spec.id)) { spec.perf = round1(spec.perf + gain); touched.add(spec.id); }
  }
}

function completeAstonAduo(state: GameState): void {
  const a = state.astonMartin;
  if (!a || a.aduoEngineArrived || a.aduoProgress < 100) return;
  a.aduoEngineArrived = true;
  buffCurrentParts(state.teams.aston_martin, ['power_unit'], state.rules.astonMartin.aduoPuBuff);
  addNews(state, '研发', '本田首批 ADUO 动力单元提前到货。振动达到危险阈值时的强制退赛风险已经消失。');
  addNarration(state, 'aston_aduo', '本田 ADUO 动力单元到货', '在车手安全舆论与 FIA 压力下，本田交付了首批改进动力单元。车队终于可以停止每十圈一次的振动风险检查。');
}

function completeAstonChassis(state: GameState): void {
  const a = state.astonMartin;
  if (!a || a.chassisUpgradeReady || a.neweyProgress < 100) return;
  a.chassisUpgradeReady = true;
  buffCurrentParts(state.teams.aston_martin, ['floor', 'sidepods', 'rear_wing'], state.rules.astonMartin.chassisBuff);
  addNews(state, '研发', '纽维完成动力单元适配车体升级，释放了被引擎空间限制压住的气动潜力。');
}

export function astonCrisis(state: GameState, strategy: 'pressure_honda' | 'mediate' | 'push_newey'): { ok: boolean; message: string } {
  const a = state.astonMartin;
  if (!a) return { ok: false, message: '当前车队没有阿斯顿·马丁危机机制' };
  if (a.lastActionRound === roundKey(state)) return { ok: false, message: '每站只能执行一次危机行动' };
  a.lastActionRound = roundKey(state);
  let text: string;
  if (strategy === 'pressure_honda') {
    a.aduoProgress = Math.min(100, a.aduoProgress + state.rules.astonMartin.aduoPressureGain);
    a.hondaConflict = round1(clamp(a.hondaConflict + 10, 0, 100));
    a.mediaPressure = round1(clamp(a.mediaPressure - 4, 0, 100));
    text = `车队公开车手手部安全数据向本田与 FIA 施压，ADUO 提前进度达到 ${a.aduoProgress}%。`;
  } else if (strategy === 'mediate') {
    a.hondaConflict = round1(clamp(a.hondaConflict - state.rules.astonMartin.mediationGain, 0, 100));
    a.mediaPressure = round1(clamp(a.mediaPressure - 3, 0, 100));
    text = '玩家安排纽维、本田和车手代表闭门调解，双方冲突明显下降。';
  } else {
    a.neweyProgress = Math.min(100, a.neweyProgress + state.rules.astonMartin.neweyProgressGain);
    a.hondaConflict = round1(clamp(a.hondaConflict + 4, 0, 100));
    text = `玩家催促纽维交付动力单元适配车体，升级进度达到 ${a.neweyProgress}%。`;
  }
  completeAstonAduo(state); completeAstonChassis(state);
  append(state, a, text); addNews(state, '车队', text);
  return { ok: true, message: text };
}

export function astonOnPriority(state: GameState, driverId: string | null): void {
  const a = state.astonMartin;
  if (!a) return;
  if (driverId === 'stroll') {
    a.strollFavor = round1(clamp(a.strollFavor + 12, 0, 100));
    a.alonsoFanAnger = round1(clamp(a.alonsoFanAnger + 15, 0, 100));
  } else if (driverId === 'alonso') {
    a.strollFavor = round1(clamp(a.strollFavor - 12, 0, 100));
    a.alonsoFanAnger = round1(clamp(a.alonsoFanAnger - 8, 0, 100));
  } else {
    a.strollFavor = round1(clamp(a.strollFavor - 3, 0, 100));
    a.alonsoFanAnger = round1(clamp(a.alonsoFanAnger - 10, 0, 100));
  }
}

export function maybeTriggerRacingBullsRecall(state: GameState, rng: Rng): void {
  const r = state.racingBulls;
  if (!r || r.pendingRecall || r.activeRecall || !rng.chance(state.rules.racingBulls.recallChance)) return;
  const team = state.teams.racing_bulls;
  const candidates = Object.values(state.drivers).filter(d => d.role === 'reserve' && (d.teamId === 'red_bull' || d.teamId === 'racing_bulls')).map(d => d.id);
  if (!team?.cars.length || !candidates.length) return;
  const car = team.cars[rng.int(0, team.cars.length - 1)];
  if (!car.driverId) return;
  r.pendingRecall = { driverId: car.driverId, candidateIds: candidates };
  const text = `红牛因突发事件调走 ${state.drivers[car.driverId]?.name ?? car.driverId} 一站。请从储备车手中选择替补。`;
  append(state, r, text); addNarration(state, 'racing_bulls_recall', '红牛紧急调用车手', text);
}

export function selectRacingBullsReserve(state: GameState, driverId: string): { ok: boolean; message: string } {
  const r = state.racingBulls;
  const pending = r?.pendingRecall;
  if (!r || !pending) return { ok: false, message: '当前没有需要处理的红牛车手调用' };
  if (!pending.candidateIds.includes(driverId)) return { ok: false, message: '该车手不在可用储备名单中' };
  const team = state.teams.racing_bulls;
  const car = team.cars.find(value => value.driverId === pending.driverId);
  const replacement = state.drivers[driverId];
  const original = state.drivers[pending.driverId];
  if (!car || !replacement || !original) return { ok: false, message: '车手或赛车数据缺失' };
  r.activeRecall = { driverId: original.id, replacementId: replacement.id, replacementTeamId: replacement.teamId };
  car.driverId = replacement.id; original.role = 'reserve'; replacement.role = 'race'; replacement.teamId = 'racing_bulls';
  resetPuUsage(state, replacement, car);
  r.pendingRecall = null;
  const text = `${replacement.name} 将顶替 ${original.name} 参加本周末，正赛车手将在赛后归队。`;
  append(state, r, text); addNews(state, '车手', text);
  return { ok: true, message: text };
}

function restoreRacingBullsDriver(state: GameState): void {
  const r = state.racingBulls, active = r?.activeRecall;
  if (!r || !active) return;
  const team = state.teams.racing_bulls;
  const car = team.cars.find(value => value.driverId === active.replacementId);
  const original = state.drivers[active.driverId], replacement = state.drivers[active.replacementId];
  if (car && original && replacement) {
    car.driverId = original.id; original.role = 'race'; original.teamId = 'racing_bulls';
    replacement.role = 'reserve'; replacement.teamId = active.replacementTeamId;
    for (const [partType, specId] of Object.entries(car.fitted)) if (original.puPool?.[partType] && !original.puPool[partType].includes(specId)) recordPuFit(state, original.id, partType, specId);
  }
  r.activeRecall = null;
}

function completeAudiTurbo(state: GameState): void {
  const a = state.audi;
  if (!a || a.turboFixed || a.aduoProgress < 100) return;
  a.turboFixed = true;
  buffCurrentParts(state.teams.audi, ['power_unit'], 5);
  addNews(state, '研发', '奥迪获准使用 ADUO 解决涡轮问题，起步随机掉位风险已经消失。');
}

export function audiAlliance(state: GameState, partner: 'aston_martin' | 'mercedes' | 'ferrari'): { ok: boolean; message: string } {
  const a = state.audi;
  if (!a) return { ok: false, message: '当前车队没有奥迪联盟机制' };
  if (a.alliance) return { ok: false, message: '奥迪已经选择了 ADUO 政治盟友' };
  a.alliance = partner;
  a.aduoProgress = Math.min(100, a.aduoProgress + state.rules.audi.allianceProgress);
  a.politicalSupport = round1(clamp(a.politicalSupport + 15, 0, 100));
  const name = state.teams[partner]?.name ?? partner;
  const text = `奥迪与${name}组成 ADUO 联盟，共同向 FIA 和其他车队施压。`;
  append(state, a, text); addNews(state, '政治', text); completeAudiTurbo(state);
  return { ok: true, message: text };
}

export function applyAudiStartDrop(state: GameState, session: LiveRaceState, rng: Rng): void {
  if (!state.audi || state.audi.turboFixed || session.kind !== 'race') return;
  for (const car of Object.values(session.cars).filter(value => value.teamId === 'audi')) {
    const from = session.order.indexOf(car.driverId);
    if (from < 0) continue;
    const loss = rng.int(state.rules.audi.startDropMin, state.rules.audi.startDropMax);
    const to = Math.min(session.order.length - 1, from + loss);
    session.order.splice(from, 1); session.order.splice(to, 0, car.driverId);
    session.events.push({ id: `${session.id}:start-audi-${car.driverId}`, lap: 1, type: 'start', text: `${car.driverId} 因奥迪涡轮迟滞在起步丢掉 ${to - from} 个位置`, drivers: [car.driverId], key: true });
  }
  session.order.forEach((id, index) => { session.cars[id].cumulativeTime = index * .25; });
}

const ISSUE_LABELS: Record<FiaMeetingIssue, string> = { aduo: 'ADUO 动力单元升级', driver_safety: '车手安全与强制退赛', cost_cap: '预算帽与新车队扶持' };
function debateNoise(state: GameState, key: string): number {
  let n = 0; for (const ch of `${state.meta.createdAt}:${state.meta.dataSignature}:${key}`) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return n % 21 - 10;
}

function openFiaMeeting(state: GameState): void {
  const meeting = state.fiaMeeting!;
  const completedRaces = state.season.roundIndex + 1;
  const perSeason = Math.floor(state.calendar.length / state.rules.fiaMeeting.interval);
  const expectedCompleted = (state.season.number - 1) * perSeason + Math.floor(completedRaces / state.rules.fiaMeeting.interval);
  if (meeting.current || completedRaces % state.rules.fiaMeeting.interval !== 0 || meeting.completed >= expectedCompleted) return;
  const issues: FiaMeetingIssue[] = ['aduo', 'driver_safety', 'cost_cap'];
  const opponents = state.teamOrder.filter(id => id !== state.meta.playerTeamId);
  meeting.current = { index: meeting.completed + 1, issue: issues[meeting.completed % issues.length], opponents: [opponents[meeting.completed % opponents.length], opponents[(meeting.completed + 3) % opponents.length]] };
  addNarration(state, 'fia_meeting', `FIA 领队座谈会：${ISSUE_LABELS[meeting.current.issue]}`, `三站比赛结束后，FIA 召集领队座谈。玩家必须选择立场，并与${meeting.current.opponents.map(id => state.teams[id]?.name ?? id).join('、')}的代表辩论。`);
}

export function fiaDebate(state: GameState, stance: 'support' | 'oppose' | 'compromise'): { ok: boolean; message: string } {
  const meeting = state.fiaMeeting, current = meeting?.current;
  if (!meeting || !current) return { ok: false, message: '当前没有待处理的 FIA 领队座谈会' };
  const team = playerTeam(state);
  const stanceBonus = stance === 'compromise' ? 8 : 0;
  const score = team.boardConfidence * .3 + team.mediaReputation * .3 + meeting.politicalCapital * .4 + stanceBonus + debateNoise(state, `${current.index}:${stance}`);
  const success = score >= 55;
  const delta = success ? (stance === 'compromise' ? 6 : 10) : -8;
  meeting.politicalCapital = round1(clamp(meeting.politicalCapital + delta, 0, 100));
  team.mediaReputation = round1(clamp(team.mediaReputation + (success ? 2 : -2), 0, 100));
  if (current.issue === 'aduo' && stance !== 'oppose' && success) {
    if (state.astonMartin) { state.astonMartin.aduoProgress = Math.min(100, state.astonMartin.aduoProgress + 22); completeAstonAduo(state); }
    if (state.audi) { state.audi.aduoProgress = Math.min(100, state.audi.aduoProgress + 25); completeAudiTurbo(state); }
    if (state.mercedes && !state.mercedes.aduoApproved) state.mercedes.aduoProgress = Math.min(100, state.mercedes.aduoProgress + 20);
  }
  const text = `${ISSUE_LABELS[current.issue]}辩论${success ? '取得优势' : '未能说服多数领队'}。政治资本变为 ${meeting.politicalCapital}。`;
  append(state, meeting, text); addNews(state, 'FIA', text); meeting.completed += 1; meeting.current = null;
  return { ok: true, message: text };
}

export function afterNextTeamRace(state: GameState): void {
  if (state.astonMartin) {
    const a = state.astonMartin, team = state.teams.aston_martin;
    const angerPenalty = Math.floor(a.alonsoFanAnger / 25);
    const patronPenalty = a.strollFavor < 35 ? 4 : 0;
    team.boardConfidence = round1(clamp(team.boardConfidence - state.rules.astonMartin.mediaConfidenceLoss - patronPenalty, 0, 100));
    team.mediaReputation = round1(clamp(team.mediaReputation - 2 - angerPenalty, 0, 100));
    a.mediaPressure = round1(clamp(a.mediaPressure + 5 + angerPenalty, 0, 100));
    a.hondaConflict = round1(clamp(a.hondaConflict + 3, 0, 100));
    addNews(state, '媒体', `西班牙媒体继续声讨阿斯顿·马丁，董事会信心降至 ${team.boardConfidence}，媒体声望降至 ${team.mediaReputation}。`);
  }
  if (state.audi?.alliance && !state.audi.turboFixed) {
    state.audi.aduoProgress = Math.min(100, state.audi.aduoProgress + state.rules.audi.progressPerRace);
    completeAudiTurbo(state);
  }
  restoreRacingBullsDriver(state);
  openFiaMeeting(state);
}

export function specialDecisionBlocker(state: GameState, actionType: string | undefined): string | null {
  if (state.racingBulls?.pendingRecall && actionType !== 'RACING_BULLS_SELECT_RESERVE' && actionType !== 'CLEAR_NARRATION') return '红牛已经调走一名正式车手。请先选择本周末替补车手。';
  if (state.fiaMeeting?.current && actionType !== 'FIA_DEBATE' && actionType !== 'CLEAR_NARRATION') return 'FIA 领队座谈会正在等待你的立场。请先完成辩论。';
  return null;
}

export function astonVibrationActive(state: GameState): boolean { return !!state.astonMartin && !state.astonMartin.aduoEngineArrived; }
