/**
 * 比赛周末：周末初始化、练习赛、排位赛（含冲刺排位）。
 */
import { DEFAULT_PLAN, LABELS } from './defaults';
import { addNarration, driverName, playerTeam } from './log';
import { activeEntries, carRatings, fittedSpec, qualiSkill, trackScore } from './ratings';
import { createPreRaceRainWindow, createWeatherTrajectory } from './raceWeather';
import { Rng } from './rng';
import { raceEngineerFor, staffAbility } from './staff';
import { effectiveSetup } from './supernatural';
import { practiceEffects, trackFit } from './performance';
import { addPowerUnitWear } from './powerunit';
import { driverTyreSets, ensureDriverWeekendTyres, provisionWeekendTyres, returnEligibleTyreSets, takeTyreSet, tyreSetById, useTyreSet, weekendTyreKey } from './tyres';
import type {
  DriverPlan,
  DriverState,
  GameState,
  PracticeProgram,
  PracticeSetupFocus,
  PracticeResult,
  LiveQualifyingState,
  QualiApproach,
  QualiResult,
  QualiSession,
  Compound,
  SetupState,
  TeamState,
  TrackDef,
  Weather,
  WeekendState,
} from './types';
import { clamp, deepClone, lapTime, round1, round3 } from './util';
import { qualifyingDurationTicks, qualifyingRunAllowance, resolvedQualifyingSectors } from './qualifyingRules';

export function currentRound(state: GameState) {
  return state.calendar[state.season.roundIndex];
}

export function currentTrack(state: GameState): TrackDef {
  const round = currentRound(state);
  const t = round ? state.tracks[round.trackId] : undefined;
  if (!t) throw new Error('当前赛历没有有效赛道');
  return t;
}

/** 冲刺周末只有一节练习赛，普通周末在排位前进行三节。 */
export function practiceSessionCount(state: GameState): number {
  return currentRound(state)?.sprint ? 1 : 3;
}

/** Tolerate an unmigrated legacy weekend while callers load and advance it. */
export function completedPracticeSessions(weekend: WeekendState): PracticeResult[] {
  return Array.isArray(weekend.practiceSessions) ? weekend.practiceSessions : weekend.practice ? [weekend.practice] : [];
}

function baseSetup(team: TeamState, slot: number): SetupState {
  const engineer = raceEngineerFor(team, slot);
  return {
    confidence: round1(25 + team.facilities.simulator * 5 + staffAbility(engineer, 'setup') * 0.1),
    tyreKnowledge: round1(20 + staffAbility(team.staff.strategist, 'strategy') * 0.1),
    thermalKnowledge: round1(18 + staffAbility(engineer, 'communication') * 0.08),
    trackKnowledge: round1(18 + team.facilities.simulator * 4),
    qualiBonus: 0,
  };
}

/** 进入比赛周末：天气预报、调校初值、沿用上一站的策略偏好 */
export function createWeekend(state: GameState, rng: Rng): WeekendState {
  const round = currentRound(state);
  const track = currentTrack(state);
  const prev = state.weekend;
  const pending = state.supernatural.pendingWeather;
  const rainBias = pending && pending.year === state.season.year && pending.roundIndex === state.season.roundIndex ? pending.rainBias : 0;
  // The zero path retains the exact former random draw sequence and values.
  const rainProbability = rainBias ? clamp(track.rainChance + rainBias, 0.05, 0.95) : track.rainChance;
  state.supernatural.pendingWeather = null;
  const forecastQ = clamp(rainProbability + rng.normal(0, 0.08), 0, 1);
  const forecastR = clamp(rainProbability + rng.normal(0, 0.08), 0, 1);
  const roll = (p: number): Weather => (rng.chance(p) ? 'wet' : 'dry');
  // 保持原有天气抽取顺序，避免相同种子因新增预报而改变整个周末天气。
  const practiceWeather = roll(rainProbability);
  const sprintQualifyingWeather = roll(forecastQ);
  const sprintWeather = roll(forecastR);
  const qualifyingWeather = roll(forecastQ);
  const raceWeather = roll(forecastR);
  const raceWeatherSeed = rng.int(0, 0xffffffff);
  const hiddenRaceTrajectory = createWeatherTrajectory(track.laps, raceWeather === 'wet', rainProbability, new Rng(raceWeatherSeed));
  const forecastNoise = new Rng(rng.int(0, 0xffffffff));
  const raceRainWindow = createPreRaceRainWindow(hiddenRaceTrajectory, forecastR, staffAbility(state.teams[state.meta.playerTeamId].staff.strategist, 'weather'), forecastNoise);
  const weekend: WeekendState = {
    roundIndex: state.season.roundIndex,
    weather: {
      practice: practiceWeather,
      sprintQualifying: sprintQualifyingWeather,
      sprint: sprintWeather,
      qualifying: qualifyingWeather,
      race: raceWeather,
    },
    forecast: { qualifying: round3(forecastQ), race: round3(forecastR), raceRainWindow },
    raceWeatherSeed,
    ...(rainBias ? { supernaturalRainBias: rainBias } : {}),
    setup: {},
    practiceBaseline: {},
    plans: {},
    teamOrders: prev?.teamOrders ? deepClone(prev.teamOrders) : { mode: 'free', favorDriverId: null },
    penalties: {},
    parcFerme: false,
    practiceSessions: [],
    practice: null,
    practiceReturn: null,
    sprintQualifying: null,
    sprint: null,
    qualifying: null,
    race: null,
    liveRace: null,
  };
  provisionWeekendTyres(state);
  // 保留上一站积累的罚退（例如 AI 叙事产生的罚退）
  const pendingPenalties = state.flags.pendingPenalties;
  if (typeof pendingPenalties === 'string' && pendingPenalties) {
    try {
      Object.assign(weekend.penalties, JSON.parse(pendingPenalties));
    } catch {
      /* 忽略损坏的数据 */
    }
    delete state.flags.pendingPenalties;
  }
  for (const { driver, team, car } of activeEntries(state)) {
    ensureDriverWeekendTyres(state, team, driver.id);
    weekend.setup[driver.id] = baseSetup(team, car.slot);
    (weekend.practiceBaseline ??= {})[driver.id] = deepClone(weekend.setup[driver.id]);
    const old = prev?.plans[driver.id];
    if (old) {
      const inherited = { ...deepClone(old), tyrePlan: 'auto' as const, sprintTyre: 'auto' as const };
      delete inherited.strategyReview;
      delete inherited.raceTyreSetPlan;
      weekend.plans[driver.id] = inherited;
    } else weekend.plans[driver.id] = deepClone(DEFAULT_PLAN);
  }
  if (!round?.sprint) {
    weekend.weather.sprint = 'dry';
    weekend.weather.sprintQualifying = 'dry';
  }
  return weekend;
}

export function planOf(state: GameState, driverId: string): DriverPlan {
  return state.weekend?.plans[driverId] ?? deepClone(DEFAULT_PLAN);
}

function setupOf(state: GameState, driverId: string, team: TeamState, slot: number): SetupState {
  const w = state.weekend!;
  if (!w.setup[driverId]) w.setup[driverId] = baseSetup(team, slot);
  return w.setup[driverId];
}

const PROGRAM: Record<PracticeProgram, { setup: number; tyre: number; thermal: number; track: number; quali: number }> = {
  setup: { setup: 1, tyre: 0.35, thermal: .3, track: .9, quali: 0 },
  longrun: { setup: 0.4, tyre: 1, thermal: 1, track: .35, quali: 0 },
  quali_sim: { setup: 0.6, tyre: 0.2, thermal: .2, track: .85, quali: 0.08 },
  parts: { setup: 0.35, tyre: 0.3, thermal: .25, track: .3, quali: 0 },
};

const SETUP_FOCUS: Record<PracticeSetupFocus, { setup: number; tyre: number; thermal: number; track: number; quali: number }> = {
  balanced: { setup: 1, tyre: 1, thermal: 1, track: 1, quali: 1 },
  aero_balance: { setup: 1.25, tyre: .85, thermal: .85, track: 1.05, quali: 1.12 },
  mechanical: { setup: 1.2, tyre: 1.08, thermal: .95, track: .9, quali: 1 },
  ride_height: { setup: 1.15, tyre: .9, thermal: .9, track: 1.18, quali: 1.06 },
  tyre_prep: { setup: .82, tyre: 1.25, thermal: 1.3, track: .9, quali: .95 },
};

function aiPracticeProgram(setup: SetupState): PracticeProgram {
  const rows: Array<[PracticeProgram, number]> = [
    ['longrun', 100 - ((setup.tyreKnowledge + (setup.thermalKnowledge ?? 0)) / 2)],
    ['setup', 100 - ((setup.confidence + (setup.trackKnowledge ?? 0)) / 2)],
    ['quali_sim', 100 - Math.min(100, setup.qualiBonus / .2 * 100)],
    ['parts', 0],
  ];
  return rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export function runPractice(state: GameState, rng: Rng): PracticeResult {
  const w = state.weekend!;
  const track = currentTrack(state);
  const round = currentRound(state);
  const rules = state.rules;
  const wet = w.weather.practice === 'wet';
  // Three normal-weekend sessions should offer more preparation than one
  // sprint-weekend session without tripling the former total setup gain.
  const sessionMul = round?.sprint ? 0.6 : 0.4;
  const session = completedPracticeSessions(w).length + 1;
  const result: PracticeResult = { timesheet: [], gains: {}, events: [] };

  for (const { driver, team, car } of activeEntries(state)) {
    const setup = setupOf(state, driver.id, team, car.slot);
    const plan = team.isPlayer ? planOf(state, driver.id) : { ...DEFAULT_PLAN };
    const program = team.isPlayer && PROGRAM[plan.practiceProgram] ? plan.practiceProgram : aiPracticeProgram(setup);
    const f = PROGRAM[program];
    const focus = SETUP_FOCUS[plan.practiceSetupFocus ?? 'balanced'];
    const engineer = raceEngineerFor(team, car.slot);
    const base =
      (18 + driver.attrs.feedback * 0.18 + staffAbility(engineer, 'setup') * 0.07 + staffAbility(engineer, 'communication') * 0.03 + team.facilities.simulator * 3) * rng.range(0.85, 1.15);
    const setupGain = base * f.setup * focus.setup * sessionMul * (wet ? 0.7 : 1);
    const tyreGain = base * f.tyre * focus.tyre * sessionMul * (wet ? 0.5 : 1);
    const thermalGain = base * f.thermal * focus.thermal * sessionMul * (wet ? .6 : 1);
    const trackGain = base * f.track * focus.track * sessionMul * (wet ? .75 : 1);
    const qualiGain = f.quali * focus.quali * (0.6 + driver.attrs.feedback / 250);
    const before = { confidence: setup.confidence, tyre: setup.tyreKnowledge, thermal: setup.thermalKnowledge ?? 0, track: setup.trackKnowledge ?? 0, quali: setup.qualiBonus };
    setup.confidence = round1(clamp(setup.confidence + setupGain, 0, 100));
    setup.tyreKnowledge = round1(clamp(setup.tyreKnowledge + tyreGain, 0, 100));
    setup.thermalKnowledge = round1(clamp((setup.thermalKnowledge ?? 0) + thermalGain, 0, 100));
    setup.trackKnowledge = round1(clamp((setup.trackKnowledge ?? 0) + trackGain, 0, 100));
    setup.qualiBonus = round3(clamp(setup.qualiBonus + qualiGain, 0, rules.performance.qualiBonusMax));

    const verified: string[] = [];
    if (program === 'parts') {
      for (const pt of Object.keys(rules.parts)) {
        const spec = fittedSpec(team, car, pt);
        if (spec && !spec.verified) {
          spec.verified = true;
          verified.push(`${rules.parts[pt].name} v${spec.version}`);
        }
      }
    }
    result.gains[driver.id] = { setup: round1(setup.confidence - before.confidence), tyre: round1(setup.tyreKnowledge - before.tyre), thermal: round1(setup.thermalKnowledge - before.thermal), track: round1(setup.trackKnowledge - before.track), quali: round3(setup.qualiBonus - before.quali), program, verified };

    const score = trackScore(carRatings(team, car, rules), track);
    const time =
      track.baseLap * (wet ? 1.12 : 1) +
      (100 - score) * rules.secPerCarPoint +
      (100 - qualiSkill(driver, wet)) * rules.secPerDriverPoint +
      rng.range(0.2, 1.4) + // 油量与项目差异（谍照永远不准）
      rng.normal(0, 0.25);
    const laps = rng.int(18, 34);
    const practiceCompounds = wet ? [rules.wetCompound, rules.fullWetCompound] : rules.dryCompounds;
    const requested = plan.practiceTyre;
    const compound = requested && requested !== 'auto' && practiceCompounds.includes(requested)
      ? requested
      : practiceCompounds[(session - 1) % practiceCompounds.length];
    const tyreSet = takeTyreSet(team, driver.id, compound, weekendTyreKey(state));
    const tyreStartedNew = tyreSet?.state === 'new';
    useTyreSet(tyreSet, laps);
    addPowerUnitWear(car, laps * .012);
    result.timesheet.push({ driverId: driver.id, teamId: team.id, time: round3(time), laps, compound, tyreSetId: tyreSet?.id, tyreStartedNew });
  }
  result.timesheet.sort((a, b) => a.time - b.time);
  const top = result.timesheet[0];
  if (top) {
    result.events.push({
      lap: 0,
      type: 'info',
      text: `练习赛最快：${driverName(state, top.driverId)} ${lapTime(top.time)}${wet ? '（雨地）' : ''}`,
      drivers: [top.driverId],
      key: true,
    });
  }
  // 玩家车队摘要
  const pt = playerTeam(state);
  const lines: string[] = [];
  for (const car of pt.cars) {
    if (!car.driverId) continue;
    const g = result.gains[car.driverId];
    const pos = result.timesheet.findIndex(e => e.driverId === car.driverId) + 1;
    const s = w.setup[car.driverId];
    lines.push(
      `${driverName(state, car.driverId)}：项目「${LABELS.program[g.program]}」，练习赛 P${pos}，调校信心 ${s.confidence}（+${g.setup}），轮胎数据 ${s.tyreKnowledge}（+${g.tyre}）${g.verified.length ? `，验证了 ${g.verified.join('、')}` : ''}`,
    );
  }
  addNarration(state, 'practice', `${track.name} 第 ${session} 节练习赛结束`, `${wet ? '雨中进行的' : ''}第 ${session} 节练习赛结束。${lines.join('；')}。`);
  w.practiceSessions = [...completedPracticeSessions(w), result];
  w.practice = result;
  const playerDrivers = playerTeam(state).cars.map(car => car.driverId).filter((id): id is string => !!id);
  const player = playerTeam(state);
  const eligibleSetIds = Object.fromEntries(playerDrivers.map(driverId => [driverId, returnEligibleTyreSets(state, player, driverId).map(set => set.id)]));
  const required = playerDrivers.length ? Math.min(Math.max(0, rules.practiceReturnSets), ...playerDrivers.map(driverId => eligibleSetIds[driverId].length)) : 0;
  w.practiceReturn = playerDrivers.length && required ? { session, required, driverIds: playerDrivers, eligibleSetIds } : null;
  return result;
}

// ───────────────────────────── 排位 ─────────────────────────────

const APPROACH: Record<QualiApproach, { mean: number; err: number }> = {
  safe: { mean: 0.06, err: 0.6 },
  standard: { mean: 0, err: 1 },
  aggressive: { mean: -0.08, err: 1.8 },
};

export function qualiLap(
  state: GameState,
  driver: DriverState,
  team: TeamState,
  score: number,
  track: TrackDef,
  wet: boolean,
  compound: Compound,
  sessionIndex: number,
  rng: Rng,
  tyreLaps = 0,
): { time: number | null; note?: string } {
  const rules = state.rules;
  const plan = team.isPlayer ? planOf(state, driver.id) : DEFAULT_PLAN;
  const approach = APPROACH[plan.qualiApproach] ?? APPROACH.standard;
  const setup = effectiveSetup(state, driver.id, setupOf(state, driver.id, team, team.cars.find(car => car.driverId === driver.id)?.slot ?? 1));
  const errChance = 0.035 * approach.err * (1 + (100 - driver.attrs.consistency) / 100) * (wet ? 2 : 1);
  if (rng.chance(errChance)) return { time: null, note: wet ? '雨中失误' : '圈速被取消/失误' };
  const sigma = (0.08 + (100 - driver.attrs.consistency) * 0.0025) * (wet ? 1.6 : 1);
  const t =
    (track.baseLap - 1.2) * (wet ? 1.12 : 1) +
    (100 - score) * rules.secPerCarPoint +
    (100 - qualiSkill(driver, wet)) * rules.secPerDriverPoint -
    practiceEffects(setup, rules, trackFit(carRatings(team, team.cars.find(car => car.driverId === driver.id)!, rules), track)).quali +
    approach.mean -
    sessionIndex * 0.12 +
    (rules.tyres[compound]?.pace ?? 0) +
    tyreLaps * .018 +
    rng.normal(0, sigma);
  return { time: round3(t) };
}

export function runQualifying(state: GameState, rng: Rng, kind: 'qualifying' | 'sprint_qualifying'): QualiResult {
  let result: QualiResult | null = null;
  while (!result) {
    const step = advanceQualifyingSegment(state, rng, kind);
    if (!step.ok) throw new Error(step.message);
    result = step.result;
  }
  return result;
}

export interface QualifyingStepResult {
  ok: boolean;
  message: string;
  result: QualiResult | null;
}

export function qualifyingTyreSets(state: GameState, team: TeamState, driverId: string, kind: 'qualifying' | 'sprint_qualifying', segmentIndex: number) {
  const key = weekendTyreKey(state);
  const wet = (kind === 'qualifying' ? state.weekend?.weather.qualifying : state.weekend?.weather.sprintQualifying) === 'wet';
  return driverTyreSets(team, driverId, key).filter(set => {
    if (set.returned) return false;
    const tyre = state.rules.tyres[set.compound];
    if (!tyre || tyre.wet !== wet) return false;
    if (kind === 'sprint_qualifying' && segmentIndex < 2 && !wet) {
      return set.compound === (state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0]) && set.state === 'new';
    }
    return true;
  });
}

/** Run only the current Q/SQ segment. The caller can save between segments. */
export function advanceQualifyingSegment(
  state: GameState,
  rng: Rng,
  kind: 'qualifying' | 'sprint_qualifying',
  tyreSetIds?: Record<string, string[]>,
): QualifyingStepResult {
  const w = state.weekend!;
  const track = currentTrack(state);
  const wet = (kind === 'qualifying' ? w.weather.qualifying : w.weather.sprintQualifying) === 'wet';
  const entries = activeEntries(state).map(e => ({
    ...e,
    score: trackScore(carRatings(e.team, e.car, state.rules), track),
  }));
  const entryByDriver = new Map(entries.map(entry => [entry.driver.id, entry]));
  const n = entries.length;
  const prefix = kind === 'qualifying' ? 'Q' : 'SQ';
  // 三节淘汰：最后一节保留 qualiFinalists 台车，其余平均分到前两节淘汰（2026 年 22 台车 → 6/6/10）
  const eliminated = n - state.rules.qualiFinalists;
  const knockouts = eliminated >= 2 ? [Math.ceil(eliminated / 2), Math.floor(eliminated / 2)] : [];
  const sessionCount = knockouts.length + 1;
  if (w.liveQualifying?.controlMode === 'manual') return { ok: false, message: '实时排位已经开始，请使用实时控制台', result: null };
  const progress: LiveQualifyingState = w.liveQualifying?.kind === kind
    ? w.liveQualifying
    : {
        version: 2,
        id: `qualifying:${weekendTyreKey(state)}:${kind}`,
        revision: 0,
        physicsVersion: 1,
        weekendKey: weekendTyreKey(state),
        controlMode: 'automatic',
        rngState: rng.state,
        kind,
        segmentIndex: 0,
        segmentCount: sessionCount,
        alive: entries.map(e => e.driver.id),
        finalOrder: [],
        sessions: [],
        events: [],
        stage: 'ready',
        paused: true,
        speed: 1,
        elapsedTicks: 0,
        durationTicks: qualifyingDurationTicks(kind, 0),
        wet,
        runAllowance: qualifyingRunAllowance(kind, sessionCount),
        sectors: resolvedQualifyingSectors(track),
        cars: {},
      };
  if (progress.segmentIndex >= progress.segmentCount) return { ok: false, message: '排位赛分段已经完成', result: null };
  const s = progress.segmentIndex;
  const runs = kind === 'sprint_qualifying' ? 1 : sessionCount === 1 ? 3 : 2;

  // Validate every manual player choice before consuming RNG or tyre life.
  if (tyreSetIds) for (const id of progress.alive) {
    const e = entryByDriver.get(id)!;
    if (!e.team.isPlayer) continue;
    const legal = qualifyingTyreSets(state, e.team, id, kind, s);
    const selected = tyreSetIds[id] ?? [];
    if (!legal.length) continue; // No legal set means this driver is allowed to record no time.
    if (selected.length !== runs) return { ok: false, message: `${driverName(state, id)} 必须为本分段的 ${runs} 次出场分别选择轮胎组`, result: null };
    for (const setId of selected) if (!legal.some(set => set.id === setId)) {
      return { ok: false, message: `${driverName(state, id)} 选择了不可用或不符合本分段规则的轮胎组`, result: null };
    }
  }

  const times = progress.alive.map(id => {
      const e = entryByDriver.get(id)!;
      let best: number | null = null;
      let note: string | undefined;
      const tyreRuns: NonNullable<QualiSession['entries'][number]['tyreRuns']> = [];
      for (let r = 0; r < runs; r++) {
        const automaticCompound = wet
          ? state.rules.wetCompound
          : kind === 'sprint_qualifying' && s < 2
            ? state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0]
            : state.rules.dryCompounds[0];
        const selectedId = e.team.isPlayer ? tyreSetIds?.[id]?.[r] : undefined;
        const selected = selectedId ? tyreSetById(e.team, id, weekendTyreKey(state), selectedId) : null;
        const set = selected ?? takeTyreSet(e.team, id, automaticCompound, weekendTyreKey(state), undefined, kind === 'sprint_qualifying' && s < 2 && !wet);
        if (!set) { note = '无可用轮胎'; continue; }
        const compound = set.compound;
        const startedNew = set.state === 'new';
        const lapsBefore = set.laps;
        const lap = qualiLap(state, e.driver, e.team, e.score, track, wet, compound, s, rng, lapsBefore);
        const lapsAdded = 3;
        useTyreSet(set, lapsAdded);
        addPowerUnitWear(e.car, lapsAdded * .02);
        tyreRuns.push({ compound, setId: set.id, startedNew, lapsBefore, lapsAdded, time: lap.time });
        if (lap.time === null) note = lap.note;
        else if (best === null || lap.time < best) best = lap.time;
      }
      return { driverId: id, teamId: e.team.id, time: best, eliminated: false, note: best === null ? note : undefined, tyreRuns };
  });
  times.sort((a, b) => (a.time ?? 9999) - (b.time ?? 9999));
  const cut = s < knockouts.length ? knockouts[s] : 0;
  const name = sessionCount === 1 ? prefix : `${prefix}${s + 1}`;
  if (cut > 0) {
    const out = times.slice(times.length - cut);
    out.forEach(t => (t.eliminated = true));
    progress.finalOrder.unshift(...out.map(t => t.driverId));
    progress.alive = times.slice(0, times.length - cut).map(t => t.driverId);
    for (const t of out) {
      if (state.teams[t.teamId]?.isPlayer) {
        progress.events.push({ lap: 0, type: 'info', text: `${driverName(state, t.driverId)} 止步 ${name}${t.note ? `（${t.note}）` : ''}`, drivers: [t.driverId], key: true });
      }
    }
  } else {
    progress.finalOrder.unshift(...times.map(t => t.driverId));
  }
  progress.sessions.push({ name, entries: times });
  progress.segmentIndex += 1;
  w.liveQualifying = progress;
  w.parcFerme = true;

  if (progress.segmentIndex < progress.segmentCount) {
    const nextName = sessionCount === 1 ? prefix : `${prefix}${progress.segmentIndex + 1}`;
    return { ok: true, message: `${name} 结束，请为 ${nextName} 选择轮胎组`, result: null };
  }

  const sessions = progress.sessions;
  const events = progress.events;
  const order = progress.finalOrder;
  // 罚退
  const grid = applyPenalties(order, kind === 'qualifying' ? w.penalties : {});
  const lastSession = sessions[sessions.length - 1];
  const poleEntry = lastSession.entries.find(e => e.driverId === order[0]);
  const result: QualiResult = {
    kind,
    weather: wet ? 'wet' : 'dry',
    sessions,
    order,
    grid,
    pole: poleEntry?.time ? { driverId: order[0], time: poleEntry.time } : null,
    events,
  };
  if (result.pole) {
    events.unshift({
      lap: 0,
      type: 'info',
      text: `${kind === 'qualifying' ? '杆位' : '冲刺赛杆位'}：${driverName(state, result.pole.driverId)} ${lapTime(result.pole.time)}`,
      drivers: [result.pole.driverId],
      key: true,
    });
  }
  for (const [id, pen] of Object.entries(kind === 'qualifying' ? w.penalties : {})) {
    if (pen > 0 && order.includes(id)) {
      events.push({ lap: 0, type: 'info', text: `${driverName(state, id)} 罚退 ${pen} 位，从 P${grid.indexOf(id) + 1} 发车`, drivers: [id], key: true });
    }
  }
  if (kind === 'qualifying') {
    w.qualifying = result;
    if (result.pole && state.standings.drivers[result.pole.driverId]) {
      state.standings.drivers[result.pole.driverId].poles += 1;
      state.drivers[result.pole.driverId].stats.poles += 1;
    }
  } else {
    w.sprintQualifying = result;
  }
  w.liveQualifying = null;

  // 叙事
  const pt = playerTeam(state);
  const poleTime = result.pole?.time ?? null;
  const lines = pt.cars
    .filter(c => c.driverId)
    .map(c => {
      const id = c.driverId!;
      const pos = order.indexOf(id) + 1;
      const gpos = grid.indexOf(id) + 1;
      const t = lastTimeOf(sessions, id);
      const gap = t !== null && poleTime !== null ? `，距杆位 +${(t - poleTime).toFixed(3)}s` : '';
      const plan = planOf(state, id);
      return `${driverName(state, id)} 排位 P${pos}${gpos !== pos ? `（发车 P${gpos}）` : ''}${gap}，采用「${LABELS.approach[plan.qualiApproach]}」方案`;
    });
  addNarration(
    state,
    kind,
    `${track.name} ${kind === 'qualifying' ? '排位赛' : '冲刺排位赛'}结果`,
    `${wet ? '雨中' : ''}${kind === 'qualifying' ? '排位赛' : '冲刺排位赛'}结束，杆位 ${driverName(state, order[0])}。${lines.join('；')}。`,
  );
  return { ok: true, message: `${kind === 'qualifying' ? '排位赛' : '冲刺排位赛'}结束，杆位：${driverName(state, order[0])}`, result };
}

function lastTimeOf(sessions: QualiSession[], id: string): number | null {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const e = sessions[i].entries.find(x => x.driverId === id);
    if (e) return e.time;
  }
  return null;
}

/**
 * 给车手追加发车罚退：排位赛前加到本站，否则留到下一站。
 * cap：该车手在这一站累计罚退的上限。返回实际增加的位数与是否本站生效。
 */
export function addGridPenalty(state: GameState, driverId: string, grid: number, cap: number): { added: number; thisRound: boolean } {
  const beforeQuali = !!state.weekend && ['practice', 'sprint_qualifying', 'sprint', 'qualifying'].includes(state.season.phase);
  let pending: Record<string, number> = {};
  if (beforeQuali) pending = state.weekend!.penalties;
  else {
    try {
      pending = JSON.parse(String(state.flags.pendingPenalties || '{}'));
    } catch {
      pending = {};
    }
  }
  const prev = pending[driverId] ?? 0;
  pending[driverId] = Math.max(prev, Math.min(cap, prev + Math.max(0, Math.round(grid))));
  const added = pending[driverId] - prev;
  if (!beforeQuali) state.flags.pendingPenalties = JSON.stringify(pending);
  // pre_race 阶段还没有进入周末：罚退先存起来，但生效的仍是即将开始的这一站
  return { added, thisRound: beforeQuali || state.season.phase === 'pre_race' };
}

/**
 * 按罚退格数后移：先取出被罚的车手，其余车手依次前移补位，
 * 再把被罚车手放到「原位置 + 罚退格数」。目标位置相同时，排位成绩好的排在前面。
 */
export function applyPenalties(order: string[], penalties: Record<string, number>): string[] {
  const penalized = order
    .map((id, index) => ({ id, index, target: index + Math.max(0, Math.round(penalties[id] ?? 0)) }))
    .filter(e => e.target > e.index)
    .sort((a, b) => a.target - b.target || a.index - b.index);
  const moved = new Set(penalized.map(e => e.id));
  const grid = order.filter(id => !moved.has(id));
  let prev = -1;
  for (const e of penalized) {
    const at = Math.min(Math.max(e.target, prev + 1), grid.length);
    grid.splice(at, 0, e.id);
    prev = at;
  }
  return grid;
}
