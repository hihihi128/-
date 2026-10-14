import { FIA_ISSUE_LABELS } from './defaults';
import { addNarration, addNews, playerTeam } from './log';
import { PU_PART_TYPES, recordPuFit, resetPuUsage } from './powerunit';
import { Rng } from './rng';
import { ensureDriverWeekendTyres } from './tyres';
import type { FiaMeetingIssue, GameState, LiveRaceState, TeamState } from './types';
import { clamp, pushCapped, round1, stamp } from './util';

const CAP = 12;
const weekKey = (state: GameState) => `${state.season.number}-w${state.season.week}`;
const append = (state: GameState, target: { log: Array<{ at: string; text: string }> }, text: string) => pushCapped(target.log, { at: stamp(state), text }, CAP);

export function initNextTeamSpecials(state: GameState, team: TeamState): void {
  state.astonMartin = team.special === 'aston_martin' ? {
    aduoEngineArrived: false, aduoProgress: 0, hondaConflict: state.rules.astonMartin.startHondaConflict,
    neweyProgress: 0, chassisUpgradeReady: false, mediaPressure: state.rules.astonMartin.startMediaPressure,
    alonsoFanAnger: 25, strollFavor: 65, lastActionRound: null, log: [],
  } : null;
  state.racingBulls = team.special === 'racing_bulls' ? { pendingRecall: null, activeRecall: null, log: [] } : null;
  state.audi = team.special === 'audi' ? { turboFixed: false, aduoProgress: 0, alliance: false, politicalSupport: 35, lastActionRound: null, log: [] } : null;
  state.fiaMeeting = { politicalCapital: state.rules.fiaMeeting.startPoliticalCapital, completed: 0, current: null, ferrariTurboSpoolSeconds: 0, ferrariAduoInstalled: false, ferrariTurboDebated: false, log: [] };
}

function buffCurrentParts(team: TeamState, partTypes: readonly string[], gain: number): void {
  const touched = new Set<string>();
  for (const car of team.cars) for (const partType of partTypes) {
    const spec = team.parts[partType]?.specs.find(value => value.id === car.fitted[partType]);
    const key = `${partType}:${spec?.id ?? ''}`;
    if (spec && !touched.has(key)) { spec.perf = round1(spec.perf + gain); touched.add(key); }
  }
}

function completeAstonAduo(state: GameState): void {
  const a = state.astonMartin;
  if (!a || a.aduoEngineArrived || a.aduoProgress < 100) return;
  a.aduoEngineArrived = true;
  buffCurrentParts(state.teams.aston_martin, PU_PART_TYPES, state.rules.astonMartin.aduoPuBuff);
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
  if (a.lastActionRound === weekKey(state)) return { ok: false, message: '每周只能执行一次危机行动' };
  a.lastActionRound = weekKey(state);
  const team = state.teams.aston_martin;
  let text: string;
  if (strategy === 'pressure_honda') {
    const conflictMul = 1 - a.hondaConflict / 200;
    const gain = Math.max(1, Math.round(state.rules.astonMartin.aduoPressureGain * conflictMul));
    a.aduoProgress = Math.min(100, a.aduoProgress + gain);
    a.hondaConflict = round1(clamp(a.hondaConflict + 10, 0, 100));
    a.mediaPressure = round1(clamp(a.mediaPressure - 6, 0, 100));
    team.boardConfidence = round1(clamp(team.boardConfidence + 1, 0, 100));
    text = `车队公开车手手部安全数据向本田与 FIA 施压，ADUO 提前进度达到 ${a.aduoProgress}%。`;
  } else if (strategy === 'mediate') {
    a.hondaConflict = round1(clamp(a.hondaConflict - state.rules.astonMartin.mediationGain, 0, 100));
    a.mediaPressure = round1(clamp(a.mediaPressure - 12, 0, 100));
    team.boardConfidence = round1(clamp(team.boardConfidence + 3, 0, 100));
    text = '玩家安排纽维、本田和车手代表闭门调解，双方冲突明显下降。';
  } else {
    a.neweyProgress = Math.min(100, a.neweyProgress + state.rules.astonMartin.neweyProgressGain);
    a.hondaConflict = round1(clamp(a.hondaConflict + 4, 0, 100));
    team.boardConfidence = round1(clamp(team.boardConfidence + 1, 0, 100));
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
  r.activeRecall = {
    driverId: original.id,
    replacementId: replacement.id,
    replacementTeamId: replacement.teamId,
    replacementPuUsed: replacement.puUsed ? { ...replacement.puUsed } : undefined,
    replacementPuPool: replacement.puPool ? Object.fromEntries(Object.entries(replacement.puPool).map(([key, value]) => [key, [...value]])) : undefined,
  };
  car.driverId = replacement.id; original.role = 'reserve'; replacement.role = 'race'; replacement.teamId = 'racing_bulls';
  if (state.weekend) ensureDriverWeekendTyres(state, team, replacement.id);
  resetPuUsage(state, replacement, car);
  state.standings.drivers[replacement.id] ??= { points: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 0, best: null, results: Array(state.calendar.length).fill(null), sprintPoints: 0 };
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
    replacement.puUsed = active.replacementPuUsed ? { ...active.replacementPuUsed } : undefined;
    replacement.puPool = active.replacementPuPool ? Object.fromEntries(Object.entries(active.replacementPuPool).map(([key, value]) => [key, [...value]])) : undefined;
    for (const [partType, specId] of Object.entries(car.fitted)) if (original.puPool?.[partType] && !original.puPool[partType].includes(specId)) recordPuFit(state, original.id, partType, specId);
  }
  r.activeRecall = null;
}

function completeAudiTurbo(state: GameState): void {
  const a = state.audi;
  if (!a || a.turboFixed || a.aduoProgress < 100) return;
  a.turboFixed = true;
  buffCurrentParts(state.teams.audi, ['turbocharger'], 5);
  addNews(state, '研发', '奥迪获准使用 ADUO 解决涡轮问题，起步随机掉位风险已经消失。');
}

export function audiAlliance(state: GameState): { ok: boolean; message: string } {
  const a = state.audi;
  const ferrari = state.ferrari;
  if (!a && !ferrari) return { ok: false, message: '当前车队不能发起 ADUO 联盟谈判' };
  if (ferrari) {
    if (ferrari.aduoAlliance) return { ok: false, message: '法拉利已经加入 ADUO 四队联盟' };
    ferrari.aduoAlliance = true;
    const text = '法拉利与奥迪、梅赛德斯和阿斯顿·马丁组成 ADUO 四队联盟，共同向 FIA 争取额外升级机会。';
    append(state, ferrari, text); addNews(state, '政治', text);
    return { ok: true, message: text };
  }
  if (!a) return { ok: false, message: '当前车队没有奥迪联盟机制' };
  if (a.alliance) return { ok: false, message: '奥迪已经加入 ADUO 四队联盟' };
  a.alliance = true;
  a.aduoProgress = Math.min(100, a.aduoProgress + state.rules.audi.allianceProgress);
  a.politicalSupport = round1(clamp(a.politicalSupport + 15, 0, 100));
  const text = '奥迪与阿斯顿·马丁、梅赛德斯和法拉利组成 ADUO 四队联盟，共同向 FIA 和其他车队施压。';
  append(state, a, text); addNews(state, '政治', text); completeAudiTurbo(state);
  return { ok: true, message: text };
}

export function applyAudiStartDrop(state: GameState, session: LiveRaceState, rng: Rng): void {
  const playerTeam = state.teams[state.meta.playerTeamId];
  if (session.kind !== 'race' || (playerTeam?.special === 'audi' && state.audi?.turboFixed === true)) return;
  const audiCars = Object.values(session.cars).filter(value => state.teams[value.teamId]?.special === 'audi');
  if (!audiCars.length) return;
  for (const car of audiCars) {
    const from = session.order.indexOf(car.driverId);
    if (from < 0) continue;
    const loss = rng.int(state.rules.audi.startDropMin, state.rules.audi.startDropMax);
    const to = Math.min(session.order.length - 1, from + loss);
    session.order.splice(from, 1); session.order.splice(to, 0, car.driverId);
    session.events.push({ id: `${session.id}:start-audi-${car.driverId}`, lap: 1, type: 'start', text: `${car.driverId} 因奥迪涡轮迟滞在起步丢掉 ${to - from} 个位置`, drivers: [car.driverId], key: true });
  }
  session.order.forEach((id, index) => { session.cars[id].cumulativeTime = index * .25; });
}

export function ferrariTurboAdvantageActive(state: GameState): boolean {
  return !state.fiaMeeting?.ferrariAduoInstalled
    && (state.teams.ferrari?.puHomologations ?? 0) === 0
    && (state.fiaMeeting?.ferrariTurboSpoolSeconds ?? 0) === 0;
}

/** 法拉利小涡轮在正赛起步时抢位；ADUO 首次认证装车或 FIA 起压规则生效后永久停用。 */
export function applyFerrariStartGain(state: GameState, session: LiveRaceState, rng: Rng): void {
  if (session.kind !== 'race' || !ferrariTurboAdvantageActive(state)) return;
  const ferraris = Object.values(session.cars)
    .filter(value => value.teamId === 'ferrari')
    .sort((a, b) => session.order.indexOf(a.driverId) - session.order.indexOf(b.driverId));
  for (const car of ferraris) {
    const from = session.order.indexOf(car.driverId);
    if (from < 0) continue;
    const gain = rng.int(state.rules.ferrari.turboStartGainMin, state.rules.ferrari.turboStartGainMax);
    const to = Math.max(0, from - gain);
    if (to === from) continue;
    session.order.splice(from, 1); session.order.splice(to, 0, car.driverId);
    session.events.push({ id: `${session.id}:start-ferrari-${car.driverId}`, lap: 1, type: 'start', text: `${car.driverId} 利用法拉利小涡轮快速起压在起步抢下 ${from - to} 个位置`, drivers: [car.driverId], key: true });
  }
  session.order.forEach((id, index) => { session.cars[id].cumulativeTime = index * .25; });
}

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
  const index = meeting.completed + 1;
  if (!meeting.ferrariTurboDebated) {
    const supporters = ['mercedes', 'mclaren', 'alpine'];
    if (debateNoise(state, 'ferrari-turbo:audi') >= 0) supporters.push('audi');
    if (debateNoise(state, 'ferrari-turbo:williams') >= 0) supporters.push('williams');
    const playerId = state.meta.playerTeamId;
    const aiSupporters = supporters.filter(id => id !== playerId);
    const forcedStance = playerId === 'alpine' ? 'support' : null;
    meeting.current = { index, issue: 'ferrari_turbo', opponents: aiSupporters, supporters: aiSupporters, forcedStance };
    const instruction = playerId === 'alpine'
      ? '布里亚托利已经决定支持提案，玩家必须以支持立场参加辩论。'
      : ['williams', 'mclaren', 'audi'].includes(playerId)
        ? 'FIA 要求玩家决定是否支持该提案。'
        : playerId === 'ferrari'
          ? '法拉利必须说服其他领队否决提案，才能保住起步优势。'
          : '玩家必须选择立场。';
    addNarration(state, 'fia_meeting', `FIA 领队座谈会：${FIA_ISSUE_LABELS[meeting.current.issue]}`, `${aiSupporters.map(id => state.teams[id]?.name ?? id).join('、')}主张以安全为由，在起步前增加 ${state.rules.ferrari.turboSpoolSeconds} 秒涡轮起压时间。${instruction}`);
    return;
  }
  const genericCompleted = Math.max(0, meeting.completed - 1);
  meeting.current = { index, issue: issues[genericCompleted % issues.length], opponents: [opponents[meeting.completed % opponents.length], opponents[(meeting.completed + 3) % opponents.length]], supporters: [], forcedStance: null };
  addNarration(state, 'fia_meeting', `FIA 领队座谈会：${FIA_ISSUE_LABELS[meeting.current.issue]}`, `FIA 召集领队座谈。玩家必须选择立场，并与${meeting.current.opponents.map(id => state.teams[id]?.name ?? id).join('、')}的代表辩论。`);
}

export function fiaDebate(state: GameState, stance: 'support' | 'oppose' | 'compromise'): { ok: boolean; message: string } {
  const meeting = state.fiaMeeting, current = meeting?.current;
  if (!meeting || !current) return { ok: false, message: '当前没有待处理的 FIA 领队座谈会' };
  if (current.forcedStance && stance !== current.forcedStance) return { ok: false, message: `车队已经决定本次必须${current.forcedStance === 'support' ? '支持' : current.forcedStance === 'oppose' ? '反对' : '提出折中'}提案` };
  const team = playerTeam(state);
  const stanceBonus = stance === 'compromise' ? 8 : 0;
  const score = team.boardConfidence * .3 + team.mediaReputation * .3 + meeting.politicalCapital * .4 + stanceBonus + debateNoise(state, `${current.index}:${stance}`);
  const coalitionAdjustment = current.issue === 'ferrari_turbo' ? Math.max(0, (current.supporters?.length ?? 3) - 3) * 4 : 0;
  const threshold = 55 + (stance === 'support' ? -coalitionAdjustment : coalitionAdjustment);
  const success = score >= threshold;
  const delta = success ? (stance === 'compromise' ? 6 : 10) : -8;
  meeting.politicalCapital = round1(clamp(meeting.politicalCapital + delta, 0, 100));
  team.mediaReputation = round1(clamp(team.mediaReputation + (success ? 2 : -2), 0, 100));
  if (current.issue === 'aduo' && stance !== 'oppose' && success) {
    if (state.astonMartin) { state.astonMartin.aduoProgress = Math.min(100, state.astonMartin.aduoProgress + 22); completeAstonAduo(state); }
    if (state.mercedes && !state.mercedes.aduoApproved) state.mercedes.aduoProgress = Math.min(100, state.mercedes.aduoProgress + 20);
    if (state.ferrari?.aduoAlliance && !state.ferrari.aduoLobbyGranted) {
      state.teams.ferrari.aduoUpgrades = (state.teams.ferrari.aduoUpgrades ?? 0) + 1;
      state.ferrari.aduoLobbyGranted = true;
      append(state, state.ferrari, 'FIA 游说成功：法拉利获得 1 次 ADUO 认证机会');
      addNews(state, 'ADUO', '法拉利通过四队联盟游说获得 1 次 ADUO 动力单元认证机会。');
    }
  }
  let outcome = '';
  if (current.issue === 'ferrari_turbo') {
    meeting.ferrariTurboDebated = true;
    const proposalPassed = stance === 'support' ? success : stance === 'oppose' ? !success : !success;
    meeting.ferrariTurboSpoolSeconds = proposalPassed ? state.rules.ferrari.turboSpoolSeconds : 0;
    outcome = proposalPassed
      ? `FIA 通过安全提案，法拉利必须在起步前增加 ${meeting.ferrariTurboSpoolSeconds} 秒涡轮起压时间，小涡轮起步优势消失。`
      : 'FIA 暂缓起压时间提案，法拉利保住小涡轮起步优势。';
  }
  const text = `${FIA_ISSUE_LABELS[current.issue]}辩论${success ? '取得优势' : '未能说服多数领队'}。${outcome}政治资本变为 ${meeting.politicalCapital}。`;
  append(state, meeting, text); addNews(state, 'FIA', text); meeting.completed += 1; meeting.current = null;
  return { ok: true, message: text };
}

export function afterNextTeamRace(state: GameState): void {
  if (state.astonMartin) {
    const a = state.astonMartin, team = state.teams.aston_martin;
    const angerPenalty = Math.floor(a.alonsoFanAnger / 25);
    const patronPenalty = a.strollFavor < 35 ? 4 : 0;
    const confidenceLoss = .5 + state.rules.astonMartin.mediaConfidenceLoss * a.mediaPressure / 100;
    team.boardConfidence = round1(clamp(team.boardConfidence - confidenceLoss - patronPenalty, 0, 100));
    team.mediaReputation = round1(clamp(team.mediaReputation - 1 - angerPenalty, 0, 100));
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
