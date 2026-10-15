import type { Outcome } from './development';
import { DEFAULT_PLAN, LABELS } from './defaults';
import { addNarration, driverName, playerTeam } from './log';
import { addPowerUnitWear } from './powerunit';
import { activeEntries, carRatings, trackScore } from './ratings';
import { Rng } from './rng';
import { takeTyreSet, tyreSetById, useTyreSet, weekendTyreKey } from './tyres';
import type {
  Compound,
  GameState,
  LiveQualifyingCar,
  LiveQualifyingRun,
  LiveQualifyingState,
  QualiResult,
  QualiSession,
  TeamState,
  TyreSet,
} from './types';
import { lapTime, round3 } from './util';
import {
  QUALIFYING_MAX_ADVANCE_TICKS,
  QUALIFYING_TICKS_PER_SECOND,
  qualifyingDurationTicks,
  qualifyingRunAllowance,
  qualifyingSectorIndex,
  resolvedQualifyingSectors,
} from './qualifyingRules';
import { applyPenalties, currentTrack, planOf, qualiLap, qualifyingTyreSets } from './weekend';

const TRAFFIC_LOOKAHEAD = 0.04;
const SLOW_LAP_MULTIPLIER = 1.32;

function ok(message: string): Outcome { return { ok: true, message }; }
function fail(message: string): Outcome { return { ok: false, message }; }

function structure(state: GameState) {
  const entries = activeEntries(state);
  const eliminated = entries.length - state.rules.qualiFinalists;
  const knockouts = eliminated >= 2 ? [Math.ceil(eliminated / 2), Math.floor(eliminated / 2)] : [];
  return { entries, knockouts, segmentCount: knockouts.length + 1 };
}

function entryMap(state: GameState) {
  const track = currentTrack(state);
  return new Map(activeEntries(state).map(entry => [entry.driver.id, {
    ...entry,
    score: trackScore(carRatings(entry.team, entry.car, state.rules), track),
  }]));
}

function sessionGuard(state: GameState, sessionId: string, revision: number): LiveQualifyingState | null {
  const live = state.weekend?.liveQualifying;
  if (!live || live.version !== 2 || live.id !== sessionId || live.revision !== revision || live.controlMode !== 'manual') return null;
  if (state.season.phase !== live.kind) return null;
  return live;
}

function scheduleAiRuns(live: LiveQualifyingState, rng: Rng): number[] {
  const result: number[] = [];
  const duration = live.durationTicks;
  for (let run = 0; run < live.runAllowance; run++) {
    const windows = live.runAllowance === 1
      ? [[.05, .45]]
      : live.runAllowance === 2
        ? [[.03, .12], [.46, .54]]
        : [[.02, .07], [.34, .39], [.66, .71]];
    const [start, end] = windows[run] ?? windows[windows.length - 1];
    const windowStart = Math.max(1, Math.floor(duration * start));
    const windowEnd = Math.max(windowStart, Math.floor(duration * end));
    result.push(rng.int(windowStart, windowEnd));
  }
  return result.sort((a, b) => a - b);
}

function prepareSegment(state: GameState, live: LiveQualifyingState, rng: Rng): void {
  live.stage = 'ready';
  live.paused = true;
  live.speed = 1;
  live.elapsedTicks = 0;
  live.durationTicks = qualifyingDurationTicks(live.kind, live.segmentIndex);
  live.runAllowance = qualifyingRunAllowance(live.kind, live.segmentCount);
  live.wet = (live.kind === 'qualifying' ? state.weekend!.weather.qualifying : state.weekend!.weather.sprintQualifying) === 'wet';
  live.sectors = resolvedQualifyingSectors(currentTrack(state));
  const entries = entryMap(state);
  live.cars = {};
  const visibleIds = new Set([
    ...live.alive,
    ...[...entries.values()].filter(entry => entry.team.isPlayer).map(entry => entry.driver.id),
  ]);
  for (const id of visibleIds) {
    const entry = entries.get(id);
    if (!entry) continue;
    const eligible = live.alive.includes(id);
    live.cars[id] = {
      driverId: id,
      teamId: entry.team.id,
      player: entry.team.isPlayer,
      phase: eligible ? 'garage' : 'done',
      progress: 0,
      phaseElapsedTicks: 0,
      runCount: 0,
      runAllowance: live.runAllowance,
      bestTime: null,
      lastTime: null,
      activeRun: null,
      completedRuns: [],
      scheduledReleaseTicks: !eligible || entry.team.isPlayer ? [] : scheduleAiRuns(live, rng),
      trafficStatus: 'clear',
      trafficDriverId: null,
      sector: 1,
    };
  }
  live.rngState = rng.state;
}

export function startLiveQualifying(state: GameState, outerRng: Rng, kind: 'qualifying' | 'sprint_qualifying'): Outcome {
  if (!state.weekend || state.season.phase !== kind) return fail('当前阶段不能开始实时排位');
  const existing = state.weekend.liveQualifying;
  if (existing?.controlMode === 'manual') return fail('实时排位已经开始');
  const { entries, segmentCount } = structure(state);
  const seed = existing?.rngState ?? outerRng.int(0, 0xffffffff);
  const sessionRng = Rng.restore(seed);
  const live: LiveQualifyingState = existing ?? {
    version: 2,
    id: `qualifying:${state.gameId}:${weekendTyreKey(state)}:${kind}`,
    revision: 0,
    physicsVersion: 1,
    weekendKey: weekendTyreKey(state),
    controlMode: 'manual',
    rngState: seed,
    kind,
    segmentIndex: 0,
    segmentCount,
    alive: entries.map(entry => entry.driver.id),
    finalOrder: [],
    sessions: [],
    events: [],
    stage: 'ready',
    paused: true,
    speed: 1,
    elapsedTicks: 0,
    durationTicks: qualifyingDurationTicks(kind, 0),
    wet: false,
    runAllowance: qualifyingRunAllowance(kind, segmentCount),
    sectors: [],
    cars: {},
  };
  live.controlMode = 'manual';
  prepareSegment(state, live, sessionRng);
  state.weekend.liveQualifying = live;
  state.weekend.parcFerme = true;
  return ok(`${kind === 'qualifying' ? '排位赛' : '冲刺排位赛'}实时控制台已就绪`);
}

export function setLiveQualifyingClock(
  state: GameState,
  sessionId: string,
  expectedRevision: number,
  paused: boolean,
  speed: 1 | 2 | 4 | 8,
): Outcome {
  const live = sessionGuard(state, sessionId, expectedRevision);
  if (!live) return fail('排位状态已更新，请刷新后重试');
  if (![1, 2, 4, 8].includes(speed)) return fail('未知排位播放速度');
  live.speed = speed;
  live.paused = paused;
  if (!paused && live.stage === 'ready') live.stage = 'running';
  live.revision++;
  return ok(paused ? '排位计时已暂停' : live.stage === 'finishing' ? `以 ${speed}× 完成赛道上的圈速` : `排位计时以 ${speed}× 运行`);
}

function automaticCompound(state: GameState, live: LiveQualifyingState): Compound {
  if (live.wet) return state.rules.wetCompound;
  if (live.kind === 'sprint_qualifying' && live.segmentIndex < 2) return state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0];
  return state.rules.dryCompounds[0];
}

function beginRun(state: GameState, live: LiveQualifyingState, car: LiveQualifyingCar, team: TeamState, set: TyreSet, rng: Rng): void {
  const entry = entryMap(state).get(car.driverId)!;
  const startedNew = set.state === 'new';
  const lapsBefore = set.laps;
  const sampled = qualiLap(state, entry.driver, entry.team, entry.score, currentTrack(state), live.wet, set.compound, live.segmentIndex, rng, lapsBefore);
  const fallback = currentTrack(state).baseLap * (live.wet ? 1.12 : 1) + rng.range(0.1, 0.5);
  const run: LiveQualifyingRun = {
    setId: set.id,
    compound: set.compound,
    startedNew,
    lapsBefore,
    lapsCharged: 0,
    cleanTime: sampled.time ?? round3(fallback),
    valid: sampled.time !== null,
    note: sampled.note,
    flyingStartedTick: null,
    flyingElapsedTicks: 0,
    trafficLoss: 0,
    blockerId: null,
    blockerTicks: 0,
  };
  set.state = 'used';
  car.activeRun = run;
  car.phase = 'pit_out';
  car.phaseElapsedTicks = 0;
  car.progress = 0;
  car.trafficStatus = 'clear';
  car.trafficDriverId = null;
  live.rngState = rng.state;
}

export function releaseLiveQualifyingCar(
  state: GameState,
  sessionId: string,
  expectedRevision: number,
  driverId: string,
  tyreSetId: string,
): Outcome {
  const live = sessionGuard(state, sessionId, expectedRevision);
  if (!live) return fail('排位状态已更新，请刷新后重试');
  if (live.elapsedTicks >= live.durationTicks) return fail('本分段计时已经结束');
  const car = live.cars[driverId];
  if (!car?.player || car.phase !== 'garage' || car.runCount >= car.runAllowance) return fail('该车当前不能放车');
  const team = state.teams[car.teamId];
  const legal = qualifyingTyreSets(state, team, driverId, live.kind, live.segmentIndex);
  const set = tyreSetById(team, driverId, live.weekendKey, tyreSetId);
  if (!set || !legal.some(candidate => candidate.id === set.id)) return fail('所选轮胎组不可用或不符合本分段规则');
  const rng = Rng.restore(live.rngState);
  beginRun(state, live, car, team, set, rng);
  live.revision++;
  return ok(`${driverName(state, driverId)} 已排队驶出维修区`);
}

function chargeLap(state: GameState, car: LiveQualifyingCar): void {
  const run = car.activeRun;
  if (!run) return;
  const team = state.teams[car.teamId];
  const set = tyreSetById(team, car.driverId, weekendTyreKey(state), run.setId);
  useTyreSet(set, 1);
  const entry = entryMap(state).get(car.driverId);
  if (entry) addPowerUnitWear(entry.car, .02);
  run.lapsCharged++;
}

function phaseDurationTicks(state: GameState, car: LiveQualifyingCar): number {
  const run = car.activeRun;
  const track = currentTrack(state);
  if (car.phase === 'pit_out' || car.phase === 'pit_in') return Math.max(20, Math.round(track.pitLoss * QUALIFYING_TICKS_PER_SECOND / 2));
  const base = Math.max(1, run?.cleanTime ?? track.baseLap);
  if (car.phase === 'out_lap' || car.phase === 'in_lap') return Math.round(base * SLOW_LAP_MULTIPLIER * QUALIFYING_TICKS_PER_SECOND);
  return Math.round(base * QUALIFYING_TICKS_PER_SECOND);
}

function nearestSlowCar(car: LiveQualifyingCar, snapshot: Record<string, { phase: LiveQualifyingCar['phase']; progress: number }>): { id: string; gap: number } | null {
  let nearest: { id: string; gap: number } | null = null;
  for (const [id, other] of Object.entries(snapshot)) {
    if (id === car.driverId || (other.phase !== 'out_lap' && other.phase !== 'in_lap')) continue;
    const gap = (other.progress - snapshot[car.driverId].progress + 1) % 1;
    const retainedRange = car.activeRun?.blockerId === id ? TRAFFIC_LOOKAHEAD * 2.5 : TRAFFIC_LOOKAHEAD;
    if (gap <= 0 || gap > retainedRange) continue;
    if (!nearest || gap < nearest.gap) nearest = { id, gap };
  }
  return nearest;
}

function completeRun(car: LiveQualifyingCar): void {
  const run = car.activeRun;
  if (!run) return;
  car.completedRuns.push({
    compound: run.compound,
    setId: run.setId,
    startedNew: run.startedNew,
    lapsBefore: run.lapsBefore,
    lapsAdded: run.lapsCharged,
    time: run.valid ? car.lastTime : null,
    cleanTime: run.valid ? run.cleanTime : null,
    trafficLoss: round3(run.trafficLoss),
    note: run.note,
  });
  car.runCount++;
  car.activeRun = null;
  car.phaseElapsedTicks = 0;
  car.progress = 0;
  car.trafficStatus = 'clear';
  car.trafficDriverId = null;
}

function moveOneTick(state: GameState, live: LiveQualifyingState): void {
  const snapshot = Object.fromEntries(Object.values(live.cars).map(car => [car.driverId, { phase: car.phase, progress: car.progress }]));
  for (const car of Object.values(live.cars).sort((a, b) => a.driverId.localeCompare(b.driverId))) {
    if (car.phase === 'garage' || car.phase === 'done') continue;
    const duration = phaseDurationTicks(state, car);
    let multiplier = 1;
    const previousProgress = car.progress;
    if (car.phase === 'flying_lap' && car.activeRun) {
      const slow = nearestSlowCar(car, snapshot);
      if (slow) {
        const sectorIndex = qualifyingSectorIndex(live.sectors, car.progress);
        const sector = live.sectors[sectorIndex];
        const blocker = live.cars[slow.id];
        const blockerDuration = blocker ? phaseDurationTicks(state, blocker) : duration;
        if (duration >= blockerDuration) {
          car.trafficStatus = 'clear';
          car.trafficDriverId = null;
          car.activeRun.blockerId = null;
          car.activeRun.blockerTicks = 0;
        } else {
        if (car.activeRun.blockerId !== slow.id) car.activeRun.blockerTicks = 0;
        car.activeRun.blockerId = slow.id;
        car.activeRun.blockerTicks++;
        car.trafficDriverId = slow.id;
        const yieldTicks = Math.round(sector.yieldSeconds * QUALIFYING_TICKS_PER_SECOND);
        if (car.activeRun.blockerTicks <= yieldTicks) {
          const passingFloor = Math.min(1, duration / blockerDuration + .03);
          multiplier = Math.max(.8, passingFloor, 1 - .14 * sector.trafficSensitivity);
          car.trafficStatus = 'slower_ahead';
        } else car.trafficStatus = 'yielding';
        }
      } else {
        car.trafficStatus = 'clear';
        car.trafficDriverId = null;
        car.activeRun.blockerId = null;
        car.activeRun.blockerTicks = 0;
      }
    }
    car.phaseElapsedTicks++;
    let crossingFraction = 1;
    if (car.phase === 'out_lap' || car.phase === 'flying_lap' || car.phase === 'in_lap') {
      const distance = multiplier / duration;
      if (previousProgress + distance >= 1) crossingFraction = Math.max(0, Math.min(1, (1 - previousProgress) / distance));
      car.progress += distance;
      car.sector = qualifyingSectorIndex(live.sectors, car.progress) + 1;
    }
    if (car.phase === 'flying_lap' && car.activeRun) {
      car.activeRun.flyingElapsedTicks += crossingFraction;
      car.activeRun.trafficLoss += (1 - multiplier) * crossingFraction / QUALIFYING_TICKS_PER_SECOND;
    }
    const crossed = (car.phase === 'pit_out' || car.phase === 'pit_in')
      ? car.phaseElapsedTicks >= duration
      : car.progress >= 1;
    if (!crossed) continue;
    if (car.phase === 'pit_out') {
      car.phase = 'out_lap';
    } else if (car.phase === 'out_lap') {
      chargeLap(state, car);
      const crossingTick = live.elapsedTicks - 1 + crossingFraction;
      if (crossingTick < live.durationTicks) {
        car.phase = 'flying_lap';
        if (car.activeRun) car.activeRun.flyingStartedTick = crossingTick;
      } else car.phase = 'in_lap';
    } else if (car.phase === 'flying_lap') {
      chargeLap(state, car);
      const run = car.activeRun!;
      car.lastTime = round3(run.flyingElapsedTicks / QUALIFYING_TICKS_PER_SECOND);
      run.trafficLoss = Math.max(run.trafficLoss, round3(Math.max(0, car.lastTime - run.cleanTime)));
      if (run.valid && (car.bestTime === null || car.lastTime < car.bestTime)) car.bestTime = car.lastTime;
      car.phase = 'in_lap';
    } else if (car.phase === 'in_lap') {
      chargeLap(state, car);
      car.phase = 'pit_in';
    } else if (car.phase === 'pit_in') {
      completeRun(car);
      car.phase = car.runCount < car.runAllowance && live.elapsedTicks < live.durationTicks ? 'garage' : 'done';
    }
    car.phaseElapsedTicks = 0;
    car.progress = 0;
    car.sector = 1;
  }
}

function autoRelease(state: GameState, live: LiveQualifyingState, rng: Rng): void {
  for (const car of Object.values(live.cars).sort((a, b) => a.driverId.localeCompare(b.driverId))) {
    if (car.player || car.phase !== 'garage' || car.runCount >= car.runAllowance) continue;
    const scheduled = car.scheduledReleaseTicks[car.runCount];
    if (scheduled === undefined || live.elapsedTicks < scheduled || live.elapsedTicks >= live.durationTicks) continue;
    const team = state.teams[car.teamId];
    const legal = qualifyingTyreSets(state, team, car.driverId, live.kind, live.segmentIndex);
    const preferred = automaticCompound(state, live);
    const set = legal.filter(candidate => candidate.compound === preferred)
      .sort((a, b) => Number(a.state === 'used') - Number(b.state === 'used') || a.laps - b.laps || a.id.localeCompare(b.id))[0]
      ?? takeTyreSet(team, car.driverId, preferred, live.weekendKey, undefined, live.kind === 'sprint_qualifying' && live.segmentIndex < 2 && !live.wet)
      ?? legal[0];
    if (set) beginRun(state, live, car, team, set, rng);
    else car.phase = 'done';
  }
  live.rngState = rng.state;
}

function lastTimeOf(sessions: QualiSession[], id: string): number | null {
  for (let index = sessions.length - 1; index >= 0; index--) {
    const entry = sessions[index].entries.find(value => value.driverId === id);
    if (entry) return entry.time;
  }
  return null;
}

function finalizeQualifying(state: GameState, live: LiveQualifyingState): QualiResult {
  const w = state.weekend!;
  const order = live.finalOrder;
  const grid = applyPenalties(order, live.kind === 'qualifying' ? w.penalties : {});
  const lastSession = live.sessions[live.sessions.length - 1];
  const poleEntry = lastSession.entries.find(entry => entry.driverId === order[0]);
  const result: QualiResult = {
    kind: live.kind,
    weather: live.wet ? 'wet' : 'dry',
    sessions: live.sessions,
    order,
    grid,
    pole: poleEntry?.time ? { driverId: order[0], time: poleEntry.time } : null,
    events: live.events,
  };
  if (result.pole) result.events.unshift({ lap: 0, type: 'info', text: `${live.kind === 'qualifying' ? '杆位' : '冲刺赛杆位'}：${driverName(state, result.pole.driverId)} ${lapTime(result.pole.time)}`, drivers: [result.pole.driverId], key: true });
  for (const [id, penalty] of Object.entries(live.kind === 'qualifying' ? w.penalties : {})) if (penalty > 0 && order.includes(id)) {
    result.events.push({ lap: 0, type: 'info', text: `${driverName(state, id)} 罚退 ${penalty} 位，从 P${grid.indexOf(id) + 1} 发车`, drivers: [id], key: true });
  }
  if (live.kind === 'qualifying') {
    w.qualifying = result;
    if (result.pole && state.standings.drivers[result.pole.driverId]) {
      state.standings.drivers[result.pole.driverId].poles++;
      state.drivers[result.pole.driverId].stats.poles++;
    }
  } else w.sprintQualifying = result;
  const poleTime = result.pole?.time ?? null;
  const lines = playerTeam(state).cars.filter(car => car.driverId).map(car => {
    const id = car.driverId!;
    const position = order.indexOf(id) + 1;
    const gridPosition = grid.indexOf(id) + 1;
    const time = lastTimeOf(result.sessions, id);
    const gap = time !== null && poleTime !== null ? `，距杆位 +${(time - poleTime).toFixed(3)}s` : '';
    const plan = planOf(state, id) ?? DEFAULT_PLAN;
    return `${driverName(state, id)} 排位 P${position}${gridPosition !== position ? `（发车 P${gridPosition}）` : ''}${gap}，采用「${LABELS.approach[plan.qualiApproach]}」方案`;
  });
  addNarration(state, live.kind, `${currentTrack(state).name} ${live.kind === 'qualifying' ? '排位赛' : '冲刺排位赛'}结果`, `${live.wet ? '雨中' : ''}${live.kind === 'qualifying' ? '排位赛' : '冲刺排位赛'}结束，杆位 ${driverName(state, order[0])}。${lines.join('；')}。`);
  w.liveQualifying = null;
  state.season.phase = live.kind === 'qualifying' ? 'race' : 'sprint';
  return result;
}

function settleSegment(state: GameState, live: LiveQualifyingState, rng: Rng): string {
  const { knockouts } = structure(state);
  const prefix = live.kind === 'qualifying' ? 'Q' : 'SQ';
  const name = live.segmentCount === 1 ? prefix : `${prefix}${live.segmentIndex + 1}`;
  const priorOrder = new Map(live.alive.map((driverId, index) => [driverId, index]));
  const times = live.alive.map(driverId => {
    const car = live.cars[driverId];
    return {
      driverId,
      teamId: car?.teamId ?? entryMap(state).get(driverId)!.team.id,
      time: car?.bestTime ?? null,
      eliminated: false,
      note: car?.bestTime === null ? (car?.completedRuns.at(-1)?.note ?? (car?.runCount ? '无有效圈速' : '未出场')) : undefined,
      tyreRuns: car?.completedRuns ?? [],
    };
  }).sort((a, b) => (a.time ?? 9999) - (b.time ?? 9999) || (priorOrder.get(a.driverId)! - priorOrder.get(b.driverId)!));
  const cut = live.segmentIndex < knockouts.length ? knockouts[live.segmentIndex] : 0;
  if (cut > 0) {
    const out = times.slice(times.length - cut);
    out.forEach(entry => { entry.eliminated = true; });
    live.finalOrder.unshift(...out.map(entry => entry.driverId));
    live.alive = times.slice(0, times.length - cut).map(entry => entry.driverId);
    for (const entry of out) if (state.teams[entry.teamId]?.isPlayer) {
      live.events.push({ lap: 0, type: 'info', text: `${driverName(state, entry.driverId)} 止步 ${name}${entry.note ? `（${entry.note}）` : ''}`, drivers: [entry.driverId], key: true });
    }
  } else live.finalOrder.unshift(...times.map(entry => entry.driverId));
  live.sessions.push({ name, entries: times });
  live.segmentIndex++;
  if (live.segmentIndex >= live.segmentCount) {
    const result = finalizeQualifying(state, live);
    return `${live.kind === 'qualifying' ? '排位赛' : '冲刺排位赛'}结束，杆位：${driverName(state, result.order[0])}`;
  }
  prepareSegment(state, live, rng);
  const next = `${prefix}${live.segmentIndex + 1}`;
  return `${name} 结束，${next} 已暂停等待放车`;
}

export function advanceLiveQualifying(
  state: GameState,
  sessionId: string,
  expectedRevision: number,
  ticks: number,
): Outcome {
  const live = sessionGuard(state, sessionId, expectedRevision);
  if (!live) return fail('排位状态已更新，请刷新后重试');
  if (live.paused || live.stage === 'ready') return fail('请先启动排位计时');
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > QUALIFYING_MAX_ADVANCE_TICKS) return fail('排位推进步数无效');
  const rng = Rng.restore(live.rngState);
  let message = '排位计时已推进';
  for (let tick = 0; tick < ticks && state.weekend?.liveQualifying === live; tick++) {
    if (live.elapsedTicks < live.durationTicks) {
      autoRelease(state, live, rng);
      live.elapsedTicks++;
      if (live.elapsedTicks >= live.durationTicks) {
        live.stage = 'finishing';
        for (const car of Object.values(live.cars)) if (car.phase === 'garage') car.phase = 'done';
      }
    } else live.elapsedTicks++;
    moveOneTick(state, live);
    const active = Object.values(live.cars).some(car => !['garage', 'done'].includes(car.phase));
    if (live.stage === 'finishing' && !active) {
      message = settleSegment(state, live, rng);
      break;
    }
  }
  if (state.weekend?.liveQualifying === live) {
    live.rngState = rng.state;
    live.revision++;
  }
  return ok(message);
}
