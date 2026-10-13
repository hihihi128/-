/**
 * 比赛周末：周末初始化、练习赛、排位赛（含冲刺排位）。
 */
import { DEFAULT_PLAN, LABELS } from './defaults';
import { addNarration, driverName, playerTeam } from './log';
import { activeEntries, carRatings, fittedSpec, qualiSkill, trackScore } from './ratings';
import { createPreRaceRainWindow, createWeatherTrajectory } from './raceWeather';
import { Rng } from './rng';
import { raceEngineerFor, staffAbility } from './staff';
import type {
  DriverPlan,
  DriverState,
  GameState,
  PracticeProgram,
  PracticeResult,
  QualiApproach,
  QualiResult,
  QualiSession,
  RaceEvent,
  SetupState,
  TeamState,
  TrackDef,
  Weather,
  WeekendState,
} from './types';
import { clamp, deepClone, lapTime, round1, round3 } from './util';

export function currentRound(state: GameState) {
  return state.calendar[state.season.roundIndex];
}

export function currentTrack(state: GameState): TrackDef {
  const round = currentRound(state);
  const t = round ? state.tracks[round.trackId] : undefined;
  if (!t) throw new Error('当前赛历没有有效赛道');
  return t;
}

function baseSetup(team: TeamState, slot: number): SetupState {
  const engineer = raceEngineerFor(team, slot);
  return {
    confidence: round1(25 + team.facilities.simulator * 5 + staffAbility(engineer, 'setup') * 0.1),
    tyreKnowledge: round1(20 + staffAbility(team.staff.strategist, 'strategy') * 0.1),
    qualiBonus: 0,
  };
}

/** 进入比赛周末：天气预报、调校初值、沿用上一站的策略偏好 */
export function createWeekend(state: GameState, rng: Rng): WeekendState {
  const round = currentRound(state);
  const track = currentTrack(state);
  const prev = state.weekend;
  const forecastQ = clamp(track.rainChance + rng.normal(0, 0.08), 0, 1);
  const forecastR = clamp(track.rainChance + rng.normal(0, 0.08), 0, 1);
  const roll = (p: number): Weather => (rng.chance(p) ? 'wet' : 'dry');
  // 保持原有天气抽取顺序，避免相同种子因新增预报而改变整个周末天气。
  const practiceWeather = roll(track.rainChance);
  const sprintQualifyingWeather = roll(forecastQ);
  const sprintWeather = roll(forecastR);
  const qualifyingWeather = roll(forecastQ);
  const raceWeather = roll(forecastR);
  const raceWeatherSeed = rng.int(0, 0xffffffff);
  const hiddenRaceTrajectory = createWeatherTrajectory(track.laps, raceWeather === 'wet', track.rainChance, new Rng(raceWeatherSeed));
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
    setup: {},
    plans: {},
    teamOrders: prev?.teamOrders ? deepClone(prev.teamOrders) : { mode: 'free', favorDriverId: null },
    penalties: {},
    parcFerme: false,
    practice: null,
    sprintQualifying: null,
    sprint: null,
    qualifying: null,
    race: null,
    liveRace: null,
  };
  // 保留上一站积累的罚退（例如 AI 叙事产生的罚退）
  const pending = state.flags.pendingPenalties;
  if (typeof pending === 'string' && pending) {
    try {
      Object.assign(weekend.penalties, JSON.parse(pending));
    } catch {
      /* 忽略损坏的数据 */
    }
    delete state.flags.pendingPenalties;
  }
  for (const { driver, team, car } of activeEntries(state)) {
    weekend.setup[driver.id] = baseSetup(team, car.slot);
    const old = prev?.plans[driver.id];
    weekend.plans[driver.id] = old ? { ...deepClone(old), tyrePlan: 'auto', sprintTyre: 'auto' } : deepClone(DEFAULT_PLAN);
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

const PROGRAM: Record<PracticeProgram, { setup: number; tyre: number; quali: number }> = {
  setup: { setup: 1, tyre: 0.35, quali: 0 },
  longrun: { setup: 0.4, tyre: 1, quali: 0 },
  quali_sim: { setup: 0.6, tyre: 0.2, quali: 0.08 },
  parts: { setup: 0.35, tyre: 0.3, quali: 0 },
};

export function runPractice(state: GameState, rng: Rng): PracticeResult {
  const w = state.weekend!;
  const track = currentTrack(state);
  const round = currentRound(state);
  const rules = state.rules;
  const wet = w.weather.practice === 'wet';
  const sessionMul = round?.sprint ? 0.6 : 1;
  const result: PracticeResult = { timesheet: [], gains: {}, events: [] };

  for (const { driver, team, car } of activeEntries(state)) {
    const plan = team.isPlayer ? planOf(state, driver.id) : { ...DEFAULT_PLAN };
    const program = PROGRAM[plan.practiceProgram] ? plan.practiceProgram : 'setup';
    const f = PROGRAM[program];
    const setup = setupOf(state, driver.id, team, car.slot);
    const engineer = raceEngineerFor(team, car.slot);
    const base =
      (18 + driver.attrs.feedback * 0.18 + staffAbility(engineer, 'setup') * 0.07 + staffAbility(engineer, 'communication') * 0.03 + team.facilities.simulator * 3) * rng.range(0.85, 1.15);
    const setupGain = base * f.setup * sessionMul * (wet ? 0.7 : 1);
    const tyreGain = base * f.tyre * sessionMul * (wet ? 0.5 : 1);
    setup.confidence = round1(clamp(setup.confidence + setupGain, 0, 100));
    setup.tyreKnowledge = round1(clamp(setup.tyreKnowledge + tyreGain, 0, 100));
    setup.qualiBonus = round3(f.quali * (0.6 + driver.attrs.feedback / 250));

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
    result.gains[driver.id] = { setup: round1(setupGain), tyre: round1(tyreGain), program, verified };

    const score = trackScore(carRatings(team, car, rules), track);
    const time =
      track.baseLap * (wet ? 1.12 : 1) +
      (100 - score) * rules.secPerCarPoint +
      (100 - qualiSkill(driver, wet)) * rules.secPerDriverPoint +
      rng.range(0.2, 1.4) + // 油量与项目差异（谍照永远不准）
      rng.normal(0, 0.25);
    result.timesheet.push({ driverId: driver.id, teamId: team.id, time: round3(time), laps: rng.int(18, 34) });
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
  addNarration(state, 'practice', `${track.name} 练习赛结束`, `${wet ? '雨中进行的' : ''}练习赛结束。${lines.join('；')}。`);
  w.practice = result;
  return result;
}

// ───────────────────────────── 排位 ─────────────────────────────

const APPROACH: Record<QualiApproach, { mean: number; err: number }> = {
  safe: { mean: 0.06, err: 0.6 },
  standard: { mean: 0, err: 1 },
  aggressive: { mean: -0.08, err: 1.8 },
};

function qualiLap(
  state: GameState,
  driver: DriverState,
  team: TeamState,
  score: number,
  track: TrackDef,
  wet: boolean,
  sessionIndex: number,
  rng: Rng,
): { time: number | null; note?: string } {
  const rules = state.rules;
  const plan = team.isPlayer ? planOf(state, driver.id) : DEFAULT_PLAN;
  const approach = APPROACH[plan.qualiApproach] ?? APPROACH.standard;
  const setup = setupOf(state, driver.id, team, team.cars.find(car => car.driverId === driver.id)?.slot ?? 1);
  const errChance = 0.035 * approach.err * (1 + (100 - driver.attrs.consistency) / 100) * (wet ? 2 : 1);
  if (rng.chance(errChance)) return { time: null, note: wet ? '雨中失误' : '圈速被取消/失误' };
  const sigma = (0.08 + (100 - driver.attrs.consistency) * 0.0025) * (wet ? 1.6 : 1);
  const t =
    (track.baseLap - 1.2) * (wet ? 1.12 : 1) +
    (100 - score) * rules.secPerCarPoint +
    (100 - qualiSkill(driver, wet)) * rules.secPerDriverPoint -
    (setup.confidence / 100) * 0.3 -
    setup.qualiBonus +
    approach.mean -
    sessionIndex * 0.12 +
    rng.normal(0, sigma);
  return { time: round3(t) };
}

export function runQualifying(state: GameState, rng: Rng, kind: 'qualifying' | 'sprint_qualifying'): QualiResult {
  const w = state.weekend!;
  const track = currentTrack(state);
  const wet = (kind === 'qualifying' ? w.weather.qualifying : w.weather.sprintQualifying) === 'wet';
  const entries = activeEntries(state).map(e => ({
    ...e,
    score: trackScore(carRatings(e.team, e.car, state.rules), track),
  }));
  const n = entries.length;
  const prefix = kind === 'qualifying' ? 'Q' : 'SQ';
  const sessions: QualiSession[] = [];
  const events: RaceEvent[] = [];
  let alive = entries.map(e => e.driver.id);
  const finalOrder: string[] = [];
  // 三节淘汰：最后一节保留 qualiFinalists 台车，其余平均分到前两节淘汰（2026 年 22 台车 → 6/6/10）
  const eliminated = n - state.rules.qualiFinalists;
  const knockouts = eliminated >= 2 ? [Math.ceil(eliminated / 2), Math.floor(eliminated / 2)] : [];
  const sessionCount = knockouts.length + 1;

  for (let s = 0; s < sessionCount; s++) {
    const runs = sessionCount === 1 ? 3 : 2;
    const times = alive.map(id => {
      const e = entries.find(x => x.driver.id === id)!;
      let best: number | null = null;
      let note: string | undefined;
      for (let r = 0; r < runs; r++) {
        const lap = qualiLap(state, e.driver, e.team, e.score, track, wet, s, rng);
        if (lap.time === null) note = lap.note;
        else if (best === null || lap.time < best) best = lap.time;
      }
      return { driverId: id, teamId: e.team.id, time: best, eliminated: false, note: best === null ? note : undefined };
    });
    times.sort((a, b) => (a.time ?? 9999) - (b.time ?? 9999));
    const cut = s < knockouts.length ? knockouts[s] : 0;
    const name = sessionCount === 1 ? prefix : `${prefix}${s + 1}`;
    if (cut > 0) {
      const out = times.slice(times.length - cut);
      out.forEach(t => (t.eliminated = true));
      // 被淘汰者按本节成绩倒序进入最终排位
      finalOrder.unshift(...out.map(t => t.driverId));
      alive = times.slice(0, times.length - cut).map(t => t.driverId);
      for (const t of out) {
        const isPlayer = state.teams[t.teamId]?.isPlayer;
        if (isPlayer) {
          events.push({ lap: 0, type: 'info', text: `${driverName(state, t.driverId)} 止步 ${name}${t.note ? `（${t.note}）` : ''}`, drivers: [t.driverId], key: true });
        }
      }
    } else {
      finalOrder.unshift(...times.map(t => t.driverId));
    }
    sessions.push({ name, entries: times });
  }

  const order = finalOrder;
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
  w.parcFerme = true;

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
  return result;
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
