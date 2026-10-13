/**
 * 赛季流程：阶段推进、赛后结算（积分/财务/心态/零件损毁/车手成长）、赛季末与新赛季。
 */
import { maybeEvaluateAduo, resetAduoSeason, syncCustomerPu } from './aduo';
import { LABELS, STAFF_ROLES } from './defaults';
import { advanceWeeks, rankOfTeam, refreshAeroAllowance, type Outcome } from './development';
import { charge, prizeFor, settleRace, income } from './finance';
import { addNarration, addNews, driverName, playerTeam, teamName } from './log';
import { closeMarket, openMarket } from './market';
import { emptyStandings } from './newgame';
import { ferrariAfterRace, ferrariMediaDelta, ferrariOnAllocation, ferrariOnBench, ferrariOnOrder } from './ferrari';
import { afterSpecialRace } from './teamSpecials';
import { afterNextTeamRace, maybeTriggerRacingBullsRecall } from './nextTeamSpecials';
import { afterManagementRace, completeAlpineDriverExit, completeWilliamsHandover } from './managementSpecials';
import { triggerWeekendRandomEvent } from './randomEvents';
import { resetPuUsage, recordPuFit } from './powerunit';
import { advanceRaceSession, applyRaceDecision, createRaceSession, finishRaceSession, type RaceExtras } from './race';
import { activeEntries, bestSpec, carRatings, disclosedPerf, driverOverall, findSpec, raceSkill, trackScore } from './ratings';
import type { Rng } from './rng';
import type { Action, CarState, DriverState, GameState, PartSpec, RaceResult, TeamState } from './types';
import { clamp, deepClone, money, round1, round2 } from './util';
import { createWeekend, currentRound, currentTrack, runPractice, runQualifying } from './weekend';

const ok = (message: string): Outcome => ({ ok: true, message });
const fail = (message: string): Outcome => ({ ok: false, message });

export interface NextAction {
  action: Action;
  label: string;
}

export function nextActionFor(state: GameState): NextAction | null {
  const active = state.weekend?.liveRace;
  // A generic advance must never silently consume a strategy window. The panel uses
  // liveRace's session/revision/window tokens for the dedicated live controls.
  if (active) return null;
  const isLast = state.season.roundIndex >= state.calendar.length - 1;
  const round = currentRound(state);
  const track = round ? state.tracks[round.trackId] : undefined;
  switch (state.season.phase) {
    case 'preseason':
      return { action: { type: 'START_SEASON' }, label: `开始赛季（${round?.weeksGap ?? 0} 周后首站：${track?.name ?? ''}）` };
    case 'pre_race':
      return { action: { type: 'START_WEEKEND' }, label: `进入${track?.name ?? ''}比赛周末` };
    case 'practice':
      return { action: { type: 'RUN_PRACTICE' }, label: '进行练习赛' };
    case 'sprint_qualifying':
      return { action: { type: 'RUN_SPRINT_QUALIFYING' }, label: '进行冲刺排位赛' };
    case 'sprint':
      return { action: { type: 'RUN_SPRINT' }, label: '开始冲刺赛' };
    case 'qualifying':
      return { action: { type: 'RUN_QUALIFYING' }, label: '进行排位赛' };
    case 'race':
      return { action: { type: 'RUN_RACE' }, label: '开始正赛' };
    case 'post_race':
      return { action: { type: 'FINISH_ROUND' }, label: isLast ? '结束赛季' : '结束本站，前往下一站' };
    case 'season_end':
      return { action: { type: 'START_NEXT_SEASON' }, label: '开始新赛季' };
    default:
      return null;
  }
}

export function startSeason(state: GameState, rng: Rng): Outcome {
  if (state.season.phase !== 'preseason') return fail('只能在季前阶段开始赛季');
  if (state.market?.window?.status !== 'closed') {
    retainUntouchedMarket(state);
    const closed = closeMarket(state);
    if (!closed.ok) return fail(closed.message);
    // First-season contracts may install a generated free agent after createGame
    // initialized PU pools; reset against the now-final seats before any race.
    for (const d of Object.values(state.drivers)) {
      if (d.teamId) resetPuUsage(state, d, state.teams[d.teamId]?.cars.find(c => c.driverId === d.id));
    }
  }
  const gap = state.calendar[0]?.weeksGap ?? 0;
  advanceWeeks(state, gap, rng);
  state.season.phase = 'pre_race';
  const track = currentTrack(state);
  addNews(state, '赛季', `${state.season.year} 赛季正式开始，首站：${track.name}。`);
  addNarration(state, 'season_start', '赛季开始', `季前准备结束（经过 ${gap} 周），车队抵达首站 ${track.name}（${track.type}）。`);
  return ok(`赛季开始，${gap} 周后抵达首站`);
}

/** Compatibility path for a window the player did not interact with at all. */
function retainUntouchedMarket(state: GameState): void {
  const pendingMarket = state.market?.window;
  if (!pendingMarket || pendingMarket.agreements.length || pendingMarket.releases.length) return;
  for (const [teamId, team] of Object.entries(state.teams)) {
    const roster = pendingMarket.projectedRosters[teamId];
    for (const car of team.cars) roster.raceSeats[String(car.slot)] = car.driverId;
    roster.reserveIds = Object.values(state.drivers).filter(d => d.teamId === teamId && d.role === 'reserve').map(d => d.id);
    for (const role of STAFF_ROLES) roster.staff[role] = team.staff[role].id ?? `${teamId}-${role}`;
  }
  pendingMarket.aiResolved = true;
  pendingMarket.status = 'ai_resolved';
}

export function startWeekend(state: GameState, rng: Rng): Outcome {
  if (state.season.phase !== 'pre_race') return fail('当前阶段不能进入比赛周末');
  state.weekend = createWeekend(state, rng);
  maybeTriggerRacingBullsRecall(state, rng);
  triggerWeekendRandomEvent(state, rng);
  state.season.phase = 'practice';
  const track = currentTrack(state);
  const w = state.weekend;
  addNarration(
    state,
    'weekend_start',
    `${track.name} 比赛周末开始`,
    `车队来到 ${track.name}（${track.type}，${track.laps} 圈）。天气预报：排位赛降雨概率 ${Math.round(w.forecast.qualifying * 100)}%，正赛降雨概率 ${Math.round(w.forecast.race * 100)}%${w.forecast.raceRainWindow ? `，预计第 ${w.forecast.raceRainWindow[0]}–${w.forecast.raceRainWindow[1]} 圈可能降雨` : ''}。${currentRound(state)?.sprint ? '本站是冲刺赛周末。' : ''}`,
  );
  return ok(`进入 ${track.name} 比赛周末`);
}

export function doPractice(state: GameState, rng: Rng): Outcome {
  if (state.season.phase !== 'practice' || !state.weekend) return fail('当前不是练习赛阶段');
  runPractice(state, rng);
  state.season.phase = currentRound(state)?.sprint ? 'sprint_qualifying' : 'qualifying';
  return ok('练习赛结束');
}

export function doQualifying(state: GameState, rng: Rng, kind: 'qualifying' | 'sprint_qualifying'): Outcome {
  if (state.season.phase !== kind || !state.weekend) return fail(`当前不是${LABELS.phase[kind]}阶段`);
  const res = runQualifying(state, rng, kind);
  state.season.phase = kind === 'qualifying' ? 'race' : 'sprint';
  return ok(`${LABELS.phase[kind]}结束，杆位：${driverName(state, res.order[0])}`);
}

/** Compatibility automatic finish. It resumes any paused matching session instead of rerolling it. */
export function doRace(state: GameState, rng: Rng, kind: 'race' | 'sprint'): Outcome {
  if (state.season.phase !== kind || !state.weekend) return fail(`当前不是${LABELS.phase[kind]}阶段`);
  let live = state.weekend.liveRace;
  if (live && live.kind !== kind) return fail('另一场比赛正在进行，不能重新发车');
  if (!live) {
    if (kind === 'race') applyAllocationFairness(state);
    live = createRaceSession(state, rng, kind, expectedPositions(state));
    state.weekend.liveRace = live;
  }
  while (live.stage !== 'finished') {
    if (live.pendingDecision) {
      const choices = live.pendingDecision.eligibleDriverIds.map(driverId => ({ driverId, pit: 'auto' as const }));
      if (!applyRaceDecision(state, live, live.pendingDecision.id, choices)) return fail('自动策略无法处理当前决策窗口');
    } else advanceRaceSession(state, live, 'next_decision');
  }
  return finalizeLiveRace(state, rng);
}

/** Creates an interactive session. Launch effects are applied only once. */
export function startLiveRace(state: GameState, rng: Rng, kind: 'race' | 'sprint'): Outcome {
  if (state.season.phase !== kind || !state.weekend) return fail(`当前不是${LABELS.phase[kind]}阶段`);
  if (state.weekend.liveRace) return fail('比赛已经开始');
  if (kind === 'race') applyAllocationFairness(state);
  state.weekend.liveRace = createRaceSession(state, rng, kind, expectedPositions(state));
  return ok(`${LABELS.phase[kind]}已发车，等待起跑策略确认`);
}

export function advanceLiveRace(state: GameState, rng: Rng, sessionId: string, revision: number, until: 'next_lap' | 'next_decision'): Outcome {
  const live = state.weekend?.liveRace;
  if (!live || live.id !== sessionId || live.revision !== revision) return fail('比赛状态已更新，请刷新后重试');
  if (live.pendingDecision) return fail('请先确认当前策略决策');
  advanceRaceSession(state, live, until);
  live.revision++;
  return live.stage === 'finished' ? finalizeLiveRace(state, rng) : ok(live.pendingDecision ? '比赛暂停，等待策略决策' : `已完成第 ${live.completedLaps} 圈`);
}

export function resolveLiveRaceDecision(state: GameState, rng: Rng, sessionId: string, revision: number, windowId: string, drivers: Parameters<typeof applyRaceDecision>[3], orders?: Parameters<typeof applyRaceDecision>[4]): Outcome {
  const live = state.weekend?.liveRace;
  if (!live || live.id !== sessionId || live.revision !== revision) return fail('比赛状态已更新，请刷新后重试');
  if (!applyRaceDecision(state, live, windowId, drivers, orders)) return fail('策略决策无效或已过期');
  return live.stage === 'finished' ? finalizeLiveRace(state, rng) : ok('策略已确认，将在下一未完成圈生效');
}

function finalizeLiveRace(state: GameState, rng: Rng): Outcome {
  const live = state.weekend?.liveRace;
  const completed = live && finishRaceSession(state, live);
  if (!live || !completed) return fail('比赛尚未完成');
  const { result, extras } = completed;
  applyRaceOutcome(state, result, extras, live.expectedPositions, rng);
  if (result.kind === 'race') { state.weekend!.race = result; state.weekend!.parcFerme = false; state.season.phase = 'post_race'; }
  else { state.weekend!.sprint = result; state.season.phase = 'qualifying'; }
  state.weekend!.liveRace = null;
  const winner = result.classification[0];
  return ok(`${LABELS.phase[result.kind]}结束，冠军：${driverName(state, winner?.driverId)}`);
}

export function finishRound(state: GameState, rng: Rng): Outcome {
  if (state.season.phase !== 'post_race') return fail('请先完成正赛');
  // 心态向 60 回归；清理报废的旧零件规格（控制存档体积）
  for (const d of Object.values(state.drivers)) d.morale = round1(d.morale + (60 - d.morale) * 0.15);
  for (const tid of state.teamOrder) pruneObsoleteSpecs(state.teams[tid]);
  if (state.season.roundIndex >= state.calendar.length - 1) {
    seasonEnd(state);
    return ok('赛季结束');
  }
  maybeEvaluateAduo(state, state.season.roundIndex + 1);
  state.season.roundIndex += 1;
  refreshAeroAllowance(state);
  const gap = state.calendar[state.season.roundIndex].weeksGap;
  advanceWeeks(state, gap, rng);
  state.season.phase = 'pre_race';
  const track = currentTrack(state);
  addNarration(state, 'travel', `前往 ${track.name}`, `${gap} 周后，车队来到第 ${state.season.roundIndex + 1} 站 ${track.name}。工厂在这段时间里继续推进研发与生产。`);
  return ok(`推进 ${gap} 周，来到 ${track.name}`);
}

/** 删除既没有库存、也没装车、且不是最新两个版本的旧规格 */
export function pruneObsoleteSpecs(team: TeamState): void {
  for (const parts of Object.values(team.parts)) {
    const latest = [...parts.specs].sort((a, b) => b.version - a.version).slice(0, 2).map(s => s.id);
    parts.specs = parts.specs.filter(
      s => latest.includes(s.id) || (parts.stock[s.id] ?? 0) > 0 || team.cars.some(c => Object.values(c.fitted).includes(s.id)),
    );
    for (const [id, n] of Object.entries(parts.stock)) {
      if (n <= 0 && !parts.specs.some(s => s.id === id)) delete parts.stock[id];
    }
  }
}

// ───────────────────────────── 赛前：升级件分配公平性 ─────────────────────────────

/** 正赛开始前：同队两台车性能差距过大时，吃亏的车手会不满 */
export function applyAllocationFairness(state: GameState): string[] {
  const team = playerTeam(state);
  const notes: string[] = [];
  if (team.cars.length < 2) return notes;
  const scored = team.cars
    .filter(c => c.driverId)
    .map(c => ({ car: c, overall: carRatings(team, c, state.rules, 'disclosed').overall }))
    .sort((a, b) => b.overall - a.overall);
  if (scored.length < 2) return notes;
  const top = scored[0];
  for (const s of scored.slice(1)) {
    const gap = top.overall - s.overall;
    if (gap < 0.4) continue;
    const d = state.drivers[s.car.driverId!];
    const egoMul = 0.5 + d.ego / 100;
    const priorityMul = team.driverPriority === top.car.driverId ? 0.7 : 1;
    const dm = round1(Math.min(6, gap * 2.5 * egoMul * priorityMul));
    const dt = round1(Math.min(5, gap * 2 * egoMul * priorityMul));
    d.morale = round1(clamp(d.morale - dm, 0, 100));
    d.trust = round1(clamp(d.trust - dt, 0, 100));
    const winner = state.drivers[top.car.driverId!];
    winner.morale = round1(clamp(winner.morale + 1, 0, 100));
    const note = `${d.name} 的赛车比 ${winner.name} 慢约 ${gap.toFixed(1)} 分（升级件分配），心态 -${dm}、信任 -${dt}`;
    const fans = ferrariOnAllocation(state, winner.id, d.id, gap);
    notes.push(note);
    addNews(state, '车手', note);
    if (fans) addNews(state, '粉丝', fans);
    addNarration(
      state,
      'allocation',
      '升级件分配引发不满',
      `${note}。${d.name} 的自尊心${d.ego >= 65 ? '很强，明显不服' : d.ego >= 40 ? '一般，但心里有疙瘩' : '不强，只是有些失落'}。${fans ? `社交媒体上：${fans}。` : ''}`,
    );
  }
  return notes;
}

/** 依据赛车 + 车手能力估算的预期名次 */
function expectedPositions(state: GameState): Record<string, number> {
  const track = currentTrack(state);
  const wet = state.weekend?.weather.race === 'wet';
  const list = activeEntries(state).map(e => ({
    id: e.driver.id,
    v: trackScore(carRatings(e.team, e.car, state.rules), track) * state.rules.secPerCarPoint + raceSkill(e.driver, wet) * state.rules.secPerDriverPoint,
  }));
  list.sort((a, b) => b.v - a.v);
  const out: Record<string, number> = {};
  list.forEach((e, i) => (out[e.id] = i + 1));
  return out;
}

// ───────────────────────────── 赛后结算 ─────────────────────────────

function applyRaceOutcome(state: GameState, result: RaceResult, extras: RaceExtras, expected: Record<string, number>, rng: Rng): void {
  const sprint = result.kind === 'sprint';
  const ri = state.season.roundIndex;
  const pointsByTeam: Record<string, number> = {};

  for (const e of result.classification) {
    const ds = state.standings.drivers[e.driverId];
    const ts = state.standings.teams[e.teamId];
    const d = state.drivers[e.driverId];
    pointsByTeam[e.teamId] = (pointsByTeam[e.teamId] ?? 0) + e.points;
    if (ds) {
      ds.points += e.points;
      if (sprint) ds.sprintPoints += e.points;
      else {
        ds.results[ri] = e.pos ?? 'DNF';
        if (e.pos === 1) ds.wins += 1;
        if (e.pos !== null && e.pos <= 3) ds.podiums += 1;
        if (e.pos === null) ds.dnfs += 1;
        if (e.pos !== null && (ds.best === null || e.pos < ds.best)) ds.best = e.pos;
        if (result.fastestLap?.driverId === e.driverId) ds.fastestLaps += 1;
      }
    }
    if (ts) {
      ts.points += e.points;
      if (!sprint) {
        if (e.pos === 1) ts.wins += 1;
        if (e.pos !== null && e.pos <= 3) ts.podiums += 1;
        if (e.pos !== null && (ts.best === null || e.pos < ts.best)) ts.best = e.pos;
      }
    }
    if (d) {
      d.stats.points += e.points;
      if (!sprint) {
        d.stats.starts += 1;
        if (e.pos === 1) d.stats.wins += 1;
        if (e.pos !== null && e.pos <= 3) d.stats.podiums += 1;
        if (e.pos === null) d.stats.dnfs += 1;
      }
    }
  }

  // 心态与状态
  const moraleNotes: string[] = [];
  for (const e of result.classification) {
    const d = state.drivers[e.driverId];
    if (!d) continue;
    const exp = expected[e.driverId] ?? e.grid;
    const isPlayer = state.teams[e.teamId]?.isPlayer;
    const before = d.morale;
    const mul = sprint ? 0.5 : 1;
    if (e.pos !== null) {
      const delta = exp - e.pos;
      let dm = clamp(delta * 1, -5, 5);
      if (e.pos <= 3) dm += 1.5;
      if (e.pos === 1) dm += 2;
      if (e.points > 0) dm += 0.5;
      d.morale = round1(clamp(d.morale + dm * mul, 0, 100));
      d.form = round1(clamp(d.form * 0.6 + delta * 0.5 * mul, -10, 10));
    } else {
      const crash = /撞|碰撞|失控/.test(e.reason);
      d.morale = round1(clamp(d.morale - (crash ? 4 : 2) * mul, 0, 100));
      if (crash) d.form = round1(clamp(d.form - 2, -10, 10));
      if (!crash && isPlayer) d.trust = round1(clamp(d.trust - 1, 0, 100));
    }
    if (isPlayer && Math.abs(d.morale - before) >= 0.1) {
      moraleNotes.push(`${d.name} 心态 ${before.toFixed(0)}→${d.morale.toFixed(0)}`);
    }
  }

  // 车队指令后果（玩家车队）
  for (const o of result.orderOutcomes) {
    const y = state.drivers[o.yielded];
    const f = state.drivers[o.favored];
    if (!y || !f) continue;
    if (o.complied) {
      y.morale = round1(clamp(y.morale - (3 + y.ego / 20), 0, 100));
      y.trust = round1(clamp(y.trust - (2 + y.ego / 25), 0, 100));
      f.morale = round1(clamp(f.morale + 2, 0, 100));
      addNews(state, '车手', `${y.name} 服从车队指令让车给 ${f.name}，但显然并不情愿。`);
      ferrariOnOrder(state, y.id, f.id, true);
    } else {
      y.morale = round1(clamp(y.morale + 1, 0, 100));
      y.trust = round1(clamp(y.trust - 2, 0, 100));
      f.morale = round1(clamp(f.morale - 3, 0, 100));
      const team = state.teams[y.teamId ?? ''];
      if (team) {
        team.staffMorale = round1(clamp(team.staffMorale - 2, 0, 100));
        team.mediaReputation = round1(clamp(team.mediaReputation - 2, 0, 100));
      }
      addNews(state, '车手', `${y.name} 无视车队指令拒绝让车给 ${f.name}，车库气氛紧张。`);
      ferrariOnOrder(state, y.id, f.id, false);
    }
  }

  // 事故：零件损毁、维修费、体能
  const crashNotes = processCrashes(state, extras, rng);

  // 正赛后：财务、董事会、验证新件、车手成长、历史
  let financeNote = '';
  if (!sprint) {
    for (const tid of state.teamOrder) {
      const team = state.teams[tid];
      // 周末积分（含冲刺赛）
      const weekendPts = (pointsByTeam[tid] ?? 0) + (state.weekend?.sprint?.classification.filter(c => c.teamId === tid).reduce((a, c) => a + c.points, 0) ?? 0);
      const fin = settleRace(state, team, weekendPts);
      if (team.isPlayer) financeNote = `收入 ${money(fin.income)}，运营支出 ${money(fin.expense)}，现金 ${money(team.funds)}`;
      const rank = rankOfTeam(state, tid);
      const podium = result.classification.some(c => c.teamId === tid && c.pos !== null && c.pos <= 3);
      team.boardConfidence = round1(clamp(team.boardConfidence + clamp((team.targetPosition - rank) * 0.8, -3, 3) + (podium ? 1 : 0), 0, 100));
      if (team.isPlayer) {
        const best = Math.min(...result.classification.filter(c => c.teamId === tid && c.pos !== null).map(c => c.pos as number), 99);
        const crashed = result.classification.some(c => c.teamId === tid && /撞|碰撞|失控/.test(c.reason));
        const dRep = (best === 1 ? 4 : best <= 3 ? 2 : best <= 10 ? 0.5 : 0) - (crashed ? 1 : 0);
        team.mediaReputation = round1(clamp(team.mediaReputation + ferrariMediaDelta(state, dRep), 0, 100));
      }
    }
    verifyFittedParts(state);
    developDrivers(state, rng);
    const track = currentTrack(state);
    state.history.push({
      roundIndex: state.season.roundIndex,
      trackId: track.id,
      trackName: track.name,
      weather: result.weather,
      winner: result.classification[0]?.pos === 1 ? result.classification[0].driverId : null,
      pole: state.weekend?.qualifying?.order[0] ?? null,
      fastest: result.fastestLap?.driverId ?? null,
      results: result.classification.map(c => [c.driverId, c.pos, c.points, c.status]),
      sprint: state.weekend?.sprint ? state.weekend.sprint.classification.map(c => [c.driverId, c.pos, c.points, c.status]) : null,
    });
  }

  // 叙事
  const track = currentTrack(state);
  const pt = playerTeam(state);
  const top3 = result.classification
    .filter(c => c.pos !== null && c.pos <= 3)
    .map(c => `P${c.pos} ${driverName(state, c.driverId)}（${teamName(state, c.teamId)}）`)
    .join('、');
  const mine = result.classification
    .filter(c => c.teamId === pt.id)
    .map(c => {
      const plan = state.weekend?.plans[c.driverId];
      const strat = plan ? `${LABELS.paceMode[plan.paceMode]}模式` : '';
      return c.pos !== null
        ? `${driverName(state, c.driverId)} 第 ${c.pos} 名（发车 P${c.grid}，${c.pits} 次进站，${strat}，得 ${c.points} 分）`
        : `${driverName(state, c.driverId)} 退赛（${c.reason}，第 ${c.laps} 圈）`;
    })
    .join('；');
  const keyEvents = result.events
    .filter(e => e.key && e.type !== 'finish')
    .slice(0, 10)
    .map(e => `第${e.lap}圈 ${e.text}`)
    .join('；');
  addNarration(
    state,
    result.kind,
    `${track.name} ${sprint ? '冲刺赛' : '正赛'}结果`,
    [
      `${result.weather === 'wet' ? '雨战。' : ''}领奖台：${top3 || '无'}。`,
      `本队：${mine}。`,
      keyEvents ? `关键时刻：${keyEvents}。` : '',
      result.safetyCars ? `全场出动 ${result.safetyCars} 次安全车。` : '',
      result.redFlags ? `全场出示 ${result.redFlags} 次红旗。` : '',
      crashNotes.length ? `事故损失：${crashNotes.join('；')}。` : '',
      moraleNotes.length ? `心态变化：${moraleNotes.join('，')}。` : '',
      financeNote ? `财务：${financeNote}。` : '',
    ]
      .filter(Boolean)
      .join(''),
  );
  const winner = result.classification[0];
  if (winner?.pos === 1) addNews(state, sprint ? '冲刺赛' : '正赛', `${driverName(state, winner.driverId)} 赢得 ${track.name} ${sprint ? '冲刺赛' : '大奖赛'}。`);
  // 法拉利：媒体与粉丝的反应、撤职检查
  ferrariAfterRace(state, result);
  if (!sprint) afterSpecialRace(state);
  if (!sprint) afterNextTeamRace(state);
  if (!sprint) afterManagementRace(state);
}

/** 事故导致的零件损毁与维修 */
function processCrashes(state: GameState, extras: RaceExtras, rng: Rng): string[] {
  const notes: string[] = [];
  const rules = state.rules;
  for (const c of extras.crashes) {
    const team = state.teams[c.teamId];
    const car = team?.cars.find(x => x.slot === c.slot);
    if (!team || !car) continue;
    const destroyed: string[] = [];
    for (const [pt, def] of Object.entries(rules.parts)) {
      const p = c.dnf ? def.crashDamage : pt === 'front_wing' ? 1 : 0;
      if (p <= 0 || !rng.chance(p)) continue;
      const lost = findSpec(team, pt, car.fitted[pt]);
      const replacement = pickReplacement(team, pt, lost);
      if (replacement) {
        team.parts[pt].stock[replacement.id] -= 1;
        car.fitted[pt] = replacement.id;
        const pen = recordPuFit(state, c.driverId, pt, replacement.id, { fresh: true, replaced: lost?.id });
        destroyed.push(`${def.name} v${lost?.version ?? '?'}${replacement.id !== lost?.id ? `（换上 v${replacement.version}）` : ''}${pen ? `（${pen}）` : ''}`);
      } else {
        // 没有任何备件：工厂紧急赶制同规格
        charge(team, def.unitCost * 1.5, 'repair', rules);
        const pen = lost ? recordPuFit(state, c.driverId, pt, lost.id, { fresh: true, replaced: lost.id }) : '';
        destroyed.push(`${def.name} v${lost?.version ?? '?'}（无备件，紧急赶制 ${money(def.unitCost * 1.5)}）${pen ? `（${pen}）` : ''}`);
      }
    }
    const repair = round2(c.dnf ? rng.range(0.6, 1.4) : 0.25);
    charge(team, repair, 'repair', rules);
    const d = state.drivers[c.driverId];
    if (d && c.dnf) {
      d.fitness = round1(clamp(d.fitness - rng.range(5, 25), 0, 100));
      if (d.fitness < 35) {
        addNews(state, '车手', `${d.name} 在事故中受伤（体能 ${d.fitness.toFixed(0)}），可能影响下一站。`);
      }
    }
    if (team.isPlayer) {
      const note = `${driverName(state, c.driverId)} 的事故维修 ${money(repair)}${destroyed.length ? `，损毁：${destroyed.join('、')}` : ''}`;
      notes.push(note);
      addNews(state, '车队', note);
    }
  }
  return notes;
}

function pickReplacement(team: TeamState, pt: string, lost: PartSpec | undefined): PartSpec | null {
  const parts = team.parts[pt];
  if (lost && (parts.stock[lost.id] ?? 0) > 0) return lost;
  let best: PartSpec | null = null;
  for (const s of parts.specs) {
    if ((parts.stock[s.id] ?? 0) > 0 && (!best || disclosedPerf(s) > disclosedPerf(best))) best = s;
  }
  return best;
}

/** 正赛数据验证所有装车零件 */
function verifyFittedParts(state: GameState): void {
  const team = playerTeam(state);
  for (const car of team.cars) {
    for (const pt of Object.keys(state.rules.parts)) {
      const spec = findSpec(team, pt, car.fitted[pt]);
      if (!spec || spec.verified) continue;
      spec.verified = true;
      const def = state.rules.parts[pt];
      if (spec.expected) {
        const mid = (spec.expected[0] + spec.expected[1]) / 2;
        const verdict = spec.perf >= spec.expected[1] ? '超出预期' : spec.perf <= spec.expected[0] ? '低于预期，存在关联性问题' : '符合预期';
        addNews(state, '研发', `${def.name} v${spec.version} 赛道数据验证完毕：性能 ${spec.perf}（预估 ${spec.expected[0]}~${spec.expected[1]}），${verdict}。`);
        if (spec.perf < mid - 1) {
          addNarration(state, 'part_verdict', `${def.name} v${spec.version} 表现不佳`, `赛道数据显示新${def.name}的真实性能（${spec.perf}）低于工厂预估，工程师们怀疑风洞与赛道数据关联性出了问题。`);
        }
      }
    }
  }
}

/** 每站后的车手成长 / 衰退 */
function developDrivers(state: GameState, rng: Rng): void {
  for (const d of Object.values(state.drivers)) {
    if (!d.teamId) continue;
    const capped = driverOverall(d) >= d.potential;
    for (const k of Object.keys(d.attrs) as Array<keyof typeof d.attrs>) {
      let g = 0;
      if (d.age <= 24) g = rng.range(0.05, 0.35);
      else if (d.age <= 29) g = rng.range(0, 0.15);
      else if (d.age <= 33) g = rng.range(-0.1, 0.1);
      else g = k === 'pace' || k === 'wet' ? -rng.range(0, 0.25) : rng.range(-0.05, 0.05);
      if ((k === 'consistency' || k === 'tyre') && d.age > 24) g += 0.05;
      if (k === 'wet') g *= 0.5;
      if (capped && g > 0) g *= 0.1;
      d.attrs[k] = round1(clamp(d.attrs[k] + g, 1, 100));
    }
  }
}

// ───────────────────────────── 赛季末 / 新赛季 ─────────────────────────────

export function sortedTeams(state: GameState): string[] {
  return [...state.teamOrder].sort((a, b) => {
    const A = state.standings.teams[a];
    const B = state.standings.teams[b];
    return (B?.points ?? 0) - (A?.points ?? 0) || (B?.wins ?? 0) - (A?.wins ?? 0) || (A?.best ?? 99) - (B?.best ?? 99);
  });
}

export function sortedDrivers(state: GameState): string[] {
  return Object.keys(state.standings.drivers).sort((a, b) => {
    const A = state.standings.drivers[a];
    const B = state.standings.drivers[b];
    return B.points - A.points || B.wins - A.wins || (A.best ?? 99) - (B.best ?? 99);
  });
}

function seasonEnd(state: GameState): void {
  state.season.phase = 'season_end';
  const teams = sortedTeams(state);
  const drivers = sortedDrivers(state);
  const pt = playerTeam(state);
  const prizes: string[] = [];
  teams.forEach((tid, i) => {
    const prize = prizeFor(state.rules, i + 1);
    income(state.teams[tid], prize);
    if (tid === pt.id) prizes.push(`车队排名第 ${i + 1}，奖金 ${money(prize)}`);
  });
  const pos = teams.indexOf(pt.id) + 1;
  const delta = (pt.targetPosition - pos) * 8;
  pt.boardConfidence = round1(clamp(pt.boardConfidence + delta, 0, 100));
  state.lastSeason = {
    year: state.season.year,
    driverChampion: drivers[0] ?? null,
    constructorChampion: teams[0] ?? null,
    playerPosition: pos,
  };
  const fired = pt.boardConfidence < state.rules.boardFireThreshold;
  if (fired) state.flags.fired = true;
  addNews(state, '赛季', `${state.season.year} 赛季结束：车手冠军 ${driverName(state, drivers[0])}，车队冠军 ${teamName(state, teams[0])}。`);
  addNarration(
    state,
    'season_end',
    `${state.season.year} 赛季结束`,
    `车手冠军：${driverName(state, drivers[0])}；车队冠军：${teamName(state, teams[0])}。${pt.name} 最终排名第 ${pos}（目标第 ${pt.targetPosition}），${prizes.join('')}。董事会信心 ${pt.boardConfidence.toFixed(0)}。${fired ? '董事会对成绩极度不满，决定解除领队职务！' : ''}`,
  );
  completeWilliamsHandover(state);
  completeAlpineDriverExit(state);
  openMarket(state, state.season.year + 1);
}

export function startNextSeason(state: GameState, rng: Rng): Outcome {
  if (state.season.phase !== 'season_end') return fail('赛季尚未结束');
  // Existing saves and callers that never touched the new market retain the
  // historical rollover behaviour. Once a player makes any market decision,
  // the normal explicit AI-resolution and roster-completeness gates apply.
  const closingMarket = state.market?.window;
  retainUntouchedMarket(state);
  const close = closeMarket(state);
  if (!close.ok) return fail(close.message);
  const finalOrder = sortedTeams(state);
  state.season.year += 1;
  state.season.number += 1;
  state.season.roundIndex = 0;
  state.season.week = 0;
  state.season.phase = 'preseason';
  if (state.randomEvents) { state.randomEvents.current = null; state.randomEvents.lastRoundKey = null; }
  const rules = state.rules;
  for (const tid of state.teamOrder) {
    const team = state.teams[tid];
    const focusBonus = (team.nextSeasonFocus / 100) * 4;
    for (const pt of Object.keys(rules.parts)) {
      const best = bestSpec(team, pt);
      const perf = round1(clamp((best?.perf ?? 70) * rules.carryOver + 70 * (1 - rules.carryOver) + focusBonus + rng.normal(0, 0.8), 1, 100));
      const id = `${pt}-S${state.season.number}v1`;
      team.parts[pt] = {
        specs: [{ id, type: pt, version: 1, perf, rel: round1(clamp((best?.rel ?? 80) + 2, 1, 99)), verified: true, expected: null, introduced: `S${state.season.number}` }],
        stock: { [id]: pt === 'front_wing' ? 2 : 1 },
      };
      for (const car of team.cars) car.fitted[pt] = id;
    }
    const cancelled = team.projects.filter(p => p.kind === 'design' || p.kind === 'manufacture');
    team.projects = team.projects.filter(p => !(p.kind === 'design' || p.kind === 'manufacture'));
    if (team.isPlayer && cancelled.length) addNews(state, '研发', `新赛季新车：${cancelled.map(p => p.label).join('、')} 随旧车一起终止。`);
    team.costCapSpent = 0;
    team.aeroHours = 0;
  }
  if (state.rules.costCapIncludesSalaries && closingMarket?.targetYear === state.season.year) {
    for (const escrow of closingMarket.escrow) {
      const team = state.teams[escrow.payerTeamId];
      team.costCapSpent = round2(team.costCapSpent + escrow.amount);
    }
  }
  if (state.alpine?.integrationPenaltyActive) state.alpine.penalizedPowerSpecs = {};
  syncCustomerPu(state);
  resetAduoSeason(state);
  // 按上赛季排名分配风洞时长
  finalOrder.forEach((tid, i) => {
    state.teams[tid].aeroHours = Math.round(rules.aeroAllowanceBase * (rules.aeroAllowanceByPosition[Math.min(i, rules.aeroAllowanceByPosition.length - 1)] ?? 1));
  });
  for (const d of Object.values(state.drivers)) {
    d.age += 1;
    d.morale = round1(60 + (d.morale - 60) * 0.5);
    d.form = 0;
    d.fitness = 100;
    resetPuUsage(state, d, d.teamId ? state.teams[d.teamId]?.cars.find(c => c.driverId === d.id) : undefined);
  }
  state.standings = emptyStandings(state);
  state.history = [];
  state.weekend = null;
  addNarration(state, 'new_season', `${state.season.year} 赛季季前准备`, `新赛季开始，所有车队推出了新车。${playerTeam(state).name} 的新车继承了上赛季 ${Math.round(rules.carryOver * 100)}% 的研发成果。`);
  return ok(`${state.season.year} 赛季季前准备开始`);
}

/** 车手换到另一台车后，按那台车上的动力单元更新配额计数 */
function syncPuAfterSeatChange(state: GameState, d: DriverState, car: CarState): void {
  if (!d.puUsed) return resetPuUsage(state, d, car);
  for (const [pt, spec] of Object.entries(car.fitted)) if (d.puPool?.[pt] && !d.puPool[pt].includes(spec)) recordPuFit(state, d.id, pt, spec);
}

/** 把一位车手换到某台车上（如伤病时启用替补） */
export function swapDriver(state: GameState, teamId: string, slot: number, driverId: string): Outcome {
  const team = state.teams[teamId];
  const car = team?.cars.find(c => c.slot === slot);
  const d = state.drivers[driverId];
  if (!team || !car || !d) return fail('参数错误');
  if ((state.market?.window?.status === 'open' || state.market?.window?.status === 'ai_resolved') && state.market.window.targetYear > state.season.year) return fail('合同市场开放时不能修改正式车位');
  if (d.teamId !== teamId) return fail('该车手不属于本车队');
  if (state.season.phase !== 'pre_race' && state.season.phase !== 'preseason' && state.season.phase !== 'post_race') {
    return fail('只能在比赛周末之外更换车手');
  }
  const other = team.cars.find(c => c.driverId === driverId);
  const prev = car.driverId;
  if (other) other.driverId = prev;
  car.driverId = driverId;
  if (prev && !other) state.drivers[prev].role = 'reserve';
  d.role = 'race';
  // 两位正式车手对调时，双方都换到了另一台车上的动力单元
  syncPuAfterSeatChange(state, d, car);
  if (other && prev) syncPuAfterSeatChange(state, state.drivers[prev], other);
  if (prev && !other) ferrariOnBench(state, prev, driverId);
  if (!state.standings.drivers[driverId]) state.standings.drivers[driverId] = deepClone(emptyStandings({ ...state, drivers: { [driverId]: d } }).drivers[driverId]);
  addNews(state, '车队', `${d.name} 将驾驶 ${slot} 号车${prev ? `，替换 ${driverName(state, prev)}` : ''}。`);
  return ok(`${d.name} 换到 ${slot} 号车`);
}
