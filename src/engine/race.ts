/**
 * 逐圈比赛模拟（正赛 / 冲刺赛）。
 *
 * 每圈：计算每台车的圈速（赛车 × 车手 × 调校 × 轮胎衰减 × 油量 × 驾驶模式 × 随机）→
 * 事故/故障判定 → 超车判定（2026 超车模式与 Boost 电能、赛道超车难度、缠斗能力、车队指令）→ 进站 →
 * 安全车/虚拟安全车。最终产出成绩表、关键事件、车手走势。
 */
import { DEFAULT_PLAN } from './defaults';
import { strategyDisobedienceChance, teammateRelationship, willDisobeyStrategy } from './driverBehavior';
import { driverName } from './log';
import { activeEntries, carRatings, fittedSpec, raceSkill, trackScore } from './ratings';
import { Rng } from './rng';
import { raceEngineerFor, staffAbility, strategyDecisionSkill } from './staff';
import { redBullCrashMultiplier, specialFailureChance } from './teamSpecials';
import { applyAudiStartDrop, applyFerrariStartGain, astonVibrationActive } from './nextTeamSpecials';
import { createForecast, createWeatherTrajectory, nextWetness, surfaceFor } from './raceWeather';
import { validOrders, validRaceChoice } from './raceDecisions';
import { actualStationaryTime } from './pitstop';
import { PU_COMBUSTION_PARTS, PU_ELECTRICAL_PARTS, PU_PART_TYPES } from './powerunit';
import { ensureDriverWeekendTyres, takeTyreSet, useTyreSet, weekendTyreKey } from './tyres';
import {
  degFactor,
  predictedTyreLife,
  optimizeStints,
  PACE_MODE_TIME,
  planLabel,
  strategyOptions,
  tyreLapDelta,
  validatePlan,
  type StrategyOption,
} from './strategy';
import type {
  CarState,
  ClassificationEntry,
  Compound,
  DriverPlan,
  DriverState,
  GameState,
  RaceEvent,
  RaceResult,
  TeamState,
  TrackDef,
  LiveRaceCar,
  LiveRaceState,
  RaceDecisionWindow,
  EnergyMode,
  PowerUnitPartType,
} from './types';
import { clamp, gapText, round3 } from './util';
import { currentTrack, planOf } from './weekend';
import { effectiveSetup } from './supernatural';
import { buildPerformanceContext, practiceEffects, stepTyre } from './performance';

interface SimCar {
  driver: DriverState;
  team: TeamState;
  car: CarState;
  plan: DriverPlan;
  isPlayer: boolean;
  score: number;
  skill: number;
  carTyre: number;
  setupBonus: number;
  knowledge: number;
  factor: number;
  compounds: Compound[];
  stints: number[];
  stintIndex: number;
  tyre: Compound;
  tyreAge: number;
  used: Set<Compound>;
  pits: number;
  cum: number;
  laps: number;
  status: 'running' | 'dnf';
  reason: string;
  bestLap: number;
  damage: number;
  partial: number;
  repairPending: boolean;
  pFail: number;
  pCrash: number;
  grid: number;
  lapTime: number;
  newCum: number;
  pittedThisLap: boolean;
  crashedOut: boolean;
  /** 超车模式电能收益系数（能量回收系统性能 / 75） */
  ersFactor: number;
}

export interface RaceExtras {
  /** 本场因事故需要扣除的零件 [teamId, slot] */
  crashes: Array<{ teamId: string; slot: number; driverId: string; dnf: boolean }>;
}

/** Severe multi-car and wet incidents are more likely to require a full stoppage. */
export function redFlagProbability(severity: 'minor' | 'wing' | 'dnf', wetness: number, involvedCars: number, scChance: number): number {
  if (severity !== 'dnf') return 0;
  return clamp(0.06 + scChance * 0.16 + wetness * 0.2 + Math.max(0, involvedCars - 1) * 0.12, 0, 0.55);
}

const MIN_GAP = 0.25;

function chooseCompounds(
  state: GameState,
  sim: Pick<SimCar, 'team' | 'plan' | 'isPlayer'>,
  options: StrategyOption[],
  wet: boolean,
  sprint: boolean,
  rng: Rng,
): Compound[] {
  const rules = state.rules;
  if (wet) return options[0]?.compounds ?? [rules.wetCompound];
  if (sprint) {
    const t = sim.plan.sprintTyre;
    if (sim.isPlayer && t !== 'auto' && rules.tyres[t] && !rules.tyres[t].wet) return [t];
    return options[0]?.compounds ?? [rules.dryCompounds[1] ?? rules.dryCompounds[0]];
  }
  if (sim.isPlayer && sim.plan.tyrePlan !== 'auto' && !validatePlan(rules, sim.plan.tyrePlan, false)) {
    return [...sim.plan.tyrePlan];
  }
  // AI/自动：策略师越强越可能选到最优解
  const skill = sim.team.staff.strategist.skill;
  if (!sim.isPlayer && options.length > 1 && !rng.chance(0.45 + skill / 200)) return options[1].compounds;
  return options[0]?.compounds ?? [rules.dryCompounds[1], rules.dryCompounds[2] ?? rules.dryCompounds[0]];
}

/** 超车模式电能收益系数：MGU-K 与储能系统越强，追近时多释放的电能越有用 */
function ersFactor(team: TeamState, car: CarState, rules: GameState['rules']): number {
  const values = ['mgu_k', 'energy_store'].map(type => fittedSpec(team, car, type)?.perf).filter((x): x is number => x !== undefined);
  if (!values.length) return 1;
  const perf = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.min(1.4, Math.max(0.6, perf / 75));
}

function puWear(car: CarState, type: PowerUnitPartType, specId: string | undefined): number {
  const pooled = specId ? car.puWearPool?.[type]?.[specId] : undefined;
  if (pooled !== undefined) return clamp(pooled, 0, 85);
  const stored = car.puWear?.[type];
  return stored && stored.specId === specId ? clamp(stored.wear, 0, 85) : 0;
}

function groupHealth(health: Partial<Record<PowerUnitPartType, number>>, parts: readonly PowerUnitPartType[]): number {
  const values = parts.map(type => health[type] ?? 100);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function minGroupHealth(health: Partial<Record<PowerUnitPartType, number>> | undefined, parts: readonly PowerUnitPartType[]): number {
  return Math.min(...parts.map(type => health?.[type] ?? 100));
}

function puStatus(temperature: number): NonNullable<LiveRaceCar['puStatus']> {
  if (temperature >= 113) return 'critical';
  if (temperature >= 106) return 'protect';
  if (temperature >= 98) return 'hot';
  return 'normal';
}

/** 每场的机械故障概率（rel=85 约 4%，rel=70 约 10%） */
function raceFailProb(rel: number): number {
  return 0.49 * Math.pow(Math.max(0.01, 1 - rel / 100), 1.32);
}

export function simulateRaceLegacy(state: GameState, rng: Rng, kind: 'race' | 'sprint'): { result: RaceResult; extras: RaceExtras } {
  const rules = state.rules;
  const w = state.weekend!;
  const track: TrackDef = currentTrack(state);
  const wet = (kind === 'race' ? w.weather.race : w.weather.sprint) === 'wet';
  const sprint = kind === 'sprint';
  const totalLaps = sprint ? Math.max(3, Math.round(track.laps * rules.sprintLapsFactor)) : track.laps;
  const quali = sprint ? w.sprintQualifying : w.qualifying;
  const entries = activeEntries(state);
  const gridOrder: string[] = quali?.grid?.filter(id => entries.some(e => e.driver.id === id)) ?? [];
  // 没有排位成绩（或有新车手）时按赛车性能补齐
  for (const e of [...entries].sort(
    (a, b) => trackScore(carRatings(b.team, b.car, rules), track) - trackScore(carRatings(a.team, a.car, rules), track),
  )) {
    if (!gridOrder.includes(e.driver.id)) gridOrder.push(e.driver.id);
  }

  const events: RaceEvent[] = [];
  const pushEvent = (lap: number, type: RaceEvent['type'], text: string, drivers: string[], key: boolean) => {
    if (events.length < 70 || type === 'finish') events.push({ lap, type, text, drivers, key });
  };
  const isKey = (...cars: SimCar[]) => cars.some(c => c.isPlayer);

  const cars: SimCar[] = gridOrder.map((id, gi) => {
    const e = entries.find(x => x.driver.id === id)!;
    const ratings = carRatings(e.team, e.car, rules);
    const plan = e.team.isPlayer ? planOf(state, id) : { ...DEFAULT_PLAN };
    const setup = effectiveSetup(state, id, w.setup[id] ?? { confidence: 40, tyreKnowledge: 30, thermalKnowledge: 30, trackKnowledge: 30, qualiBonus: 0 });
    const performanceContext = buildPerformanceContext({ driverTyre: e.driver.attrs.tyre, carTyre: ratings.tyre, setup, ratings, track });
    const ctx = { driverTyre: e.driver.attrs.tyre, carTyre: ratings.tyre, paceMode: plan.paceMode, knowledge: setup.tyreKnowledge, performanceContext };
    const factor = degFactor(track, ctx);
    const options = strategyOptions(rules, track, totalLaps, ctx, { wet, sprint });
    const sim: SimCar = {
      driver: e.driver,
      team: e.team,
      car: e.car,
      plan,
      isPlayer: e.team.isPlayer,
      score: trackScore(ratings, track),
      skill: raceSkill(e.driver, wet),
      carTyre: ratings.tyre,
      setupBonus: (setup.confidence / 100) * 0.3,
      ersFactor: ersFactor(e.team, e.car, rules),
      knowledge: setup.tyreKnowledge,
      factor,
      compounds: [],
      stints: [],
      stintIndex: 0,
      tyre: rules.dryCompounds[0],
      tyreAge: 0,
      used: new Set(),
      pits: 0,
      cum: gi * 0.25,
      laps: 0,
      status: 'running',
      reason: '',
      bestLap: Infinity,
      damage: 0,
      partial: 0,
      repairPending: false,
      pFail: 0,
      pCrash: 0,
      grid: gi + 1,
      lapTime: 0,
      newCum: 0,
      pittedThisLap: false,
      crashedOut: false,
    };
    sim.compounds = chooseCompounds(state, sim, options, wet, sprint, rng);
    sim.stints = optimizeStints(rules, track, sim.compounds, totalLaps, factor, { context: performanceContext, paceMode: plan.paceMode });
    // 进站时机偏好：提前（Undercut）/ 推迟（Overcut）
    const shift = plan.pitTiming === 'early' ? -2 : plan.pitTiming === 'late' ? 2 : 0;
    if (shift && sim.stints.length > 1) {
      for (let i = 0; i < sim.stints.length - 1; i++) {
        const moved = clamp(sim.stints[i] + shift, 3, sim.stints[i] + sim.stints[i + 1] - 3);
        sim.stints[i + 1] -= moved - sim.stints[i];
        sim.stints[i] = moved;
      }
    }
    sim.tyre = sim.compounds[0];
    sim.used.add(sim.tyre);
    const modeRisk = plan.paceMode === 'push' ? 1.4 : plan.paceMode === 'conserve' ? 0.7 : 1;
    sim.pFail = (raceFailProb(ratings.reliability) * modeRisk) / track.laps;
    const crashRace = (0.02 + ((100 - e.driver.attrs.consistency) / 100) * 0.06) * (wet ? 2.5 : 1) * (plan.paceMode === 'push' ? 1.4 : 1);
    sim.pCrash = crashRace / track.laps;
    return sim;
  });

  const extras: RaceExtras = { crashes: [] };
  const lapChart: Record<string, number[]> = {};
  for (const c of cars) if (c.isPlayer) lapChart[c.driver.id] = [];
  let fastest: RaceResult['fastestLap'] = null;
  let scLeft = 0;
  let vscLeft = 0;
  let safetyCars = 0;
  const orderOutcomes: RaceResult['orderOutcomes'] = [];
  const orderCooldown = new Map<string, number>();
  const orders = w.teamOrders;

  const running = () => cars.filter(c => c.status === 'running');
  const deploy = (lap: number, crash: boolean) => {
    if (scLeft > 0 || vscLeft > 0) return;
    if (crash && rng.chance(track.scChance)) {
      scLeft = rng.int(3, 5);
      safetyCars += 1;
      pushEvent(lap, 'sc', '安全车出动！', [], true);
    } else if (rng.chance(crash ? 0.85 : 0.45)) {
      vscLeft = 2;
      pushEvent(lap, 'vsc', '虚拟安全车（VSC）', [], true);
    }
  };

  for (let lap = 1; lap <= totalLaps; lap++) {
    const scActive = scLeft > 0;
    const vscActive = vscLeft > 0;
    const field = running().sort((a, b) => a.cum - b.cum);

    // 1) 圈速
    for (const c of field) {
      c.pittedThisLap = false;
      const base =
        track.baseLap * (wet ? 1.12 : 1) +
        (100 - c.score) * rules.secPerCarPoint +
        (100 - c.skill) * rules.secPerDriverPoint -
        c.setupBonus;
      const tyre = tyreLapDelta(rules.tyres[c.tyre], c.tyreAge + 1, c.factor);
      const fuel = (totalLaps - lap) * 0.03;
      const sigma = (0.12 + (100 - c.driver.attrs.consistency) * 0.004) * (wet ? 1.5 : 1);
      let t = base + tyre + fuel + PACE_MODE_TIME[c.plan.paceMode] + c.damage + c.partial + rng.normal(0, sigma);
      if (lap === 1) t += 2.5 + rng.normal(0, 0.35) - (c.driver.attrs.racecraft - 75) * 0.008;
      if (scActive) t = track.baseLap * 1.35 + rng.normal(0, 0.05);
      else if (vscActive) t = (base + tyre) * 1.25 + rng.normal(0, 0.05);
      c.lapTime = t;
    }

    // 2) 故障与事故（安全车期间不判定）
    if (!scActive && !vscActive) {
      for (const c of field) {
        if (rng.chance(c.pFail)) {
          if (rng.chance(0.35) && c.partial === 0) {
            c.partial = rng.range(0.6, 1.2);
            pushEvent(lap, 'damage', `${driverName(state, c.driver.id)} 赛车出现故障，动力下降`, [c.driver.id], isKey(c));
          } else {
            c.status = 'dnf';
            c.reason = rng.pick(['内燃机故障', '能量回收系统故障', '变速箱故障', '液压故障', '刹车过热', '冷却系统故障']);
            pushEvent(lap, 'dnf', `${driverName(state, c.driver.id)} 因${c.reason}退赛`, [c.driver.id], true);
            deploy(lap, false);
          }
        } else if (rng.chance(c.pCrash * (lap === 1 ? 4 : 1))) {
          extras.crashes.push({ teamId: c.team.id, slot: c.car.slot, driverId: c.driver.id, dnf: false });
          if (rng.chance(0.4)) {
            c.damage = 0.9;
            c.repairPending = true;
            c.lapTime += rng.range(2, 6);
            pushEvent(lap, 'error', `${driverName(state, c.driver.id)} 失误触碰护墙，前翼受损需要进站`, [c.driver.id], isKey(c));
          } else {
            c.status = 'dnf';
            c.reason = wet ? '雨中失控撞车' : '失误撞车';
            c.crashedOut = true;
            extras.crashes[extras.crashes.length - 1].dnf = true;
            pushEvent(lap, 'dnf', `${driverName(state, c.driver.id)} ${c.reason}，退赛！`, [c.driver.id], true);
            deploy(lap, true);
          }
        }
      }
    }

    // 3) 位置与超车
    const order = field.filter(c => c.status === 'running');
    for (const c of order) c.newCum = c.cum + c.lapTime;
    if (!scActive && !vscActive && lap > 1) {
      for (let i = 1; i < order.length; i++) {
        const B = order[i];
        const A = order[i - 1];
        if (A.status !== 'running' || B.status !== 'running') continue;
        const gapStart = B.cum - A.cum;
        const wouldCatch = B.newCum < A.newCum + MIN_GAP;
        if (!wouldCatch) continue;
        if (gapStart > 1.5) continue; // 不在同一段赛道（如对手刚进站），自然换位
        const teammates = A.team.id === B.team.id;
        // 车队指令：保持位置
        if (teammates && A.isPlayer && orders.mode === 'hold') {
          B.newCum = A.newCum + MIN_GAP + 0.4;
          continue;
        }
        // 2026：DRS 取消。落后不足 overtakeModeGap 秒的车可开启超车模式（额外电能），
        // 收益随能量回收系统的性能浮动；进攻模式代表主动按下 Boost 按钮释放电能。
        const overtakeMode = !wet && gapStart < rules.overtakeModeGap ? rules.overtakeModeBonus * B.ersFactor : 0;
        const boost = (B.plan.paceMode === 'push' ? rules.boostAttack : 0) - (A.plan.paceMode === 'push' ? rules.boostDefence : 0);
        const adv = A.lapTime - B.lapTime + overtakeMode + boost + (B.driver.attrs.racecraft - A.driver.attrs.racecraft) * 0.006;
        const threshold = 0.25 + ((100 - track.overtaking) / 100) * 1.3;
        const p = 1 / (1 + Math.exp(-4 * (adv - threshold)));
        if (rng.chance(p)) {
          // 碰撞风险
          const minCraft = Math.min(A.driver.attrs.racecraft, B.driver.attrs.racecraft);
          const pCol = 0.006 * (1 + Math.max(0, 75 - minCraft) / 25) * (wet ? 2 : 1);
          if (rng.chance(pCol)) {
            const victim = rng.chance(0.5) ? A : B;
            victim.status = 'dnf';
            victim.reason = `与 ${driverName(state, (victim === A ? B : A).driver.id)} 碰撞`;
            victim.crashedOut = true;
            extras.crashes.push({ teamId: victim.team.id, slot: victim.car.slot, driverId: victim.driver.id, dnf: true });
            pushEvent(lap, 'dnf', `${driverName(state, B.driver.id)} 与 ${driverName(state, A.driver.id)} 争位时发生碰撞，${driverName(state, victim.driver.id)} 退赛！`, [A.driver.id, B.driver.id], true);
            deploy(lap, true);
            continue;
          }
          B.newCum = Math.min(B.newCum, A.newCum - 0.1 - rng.range(0, 0.3));
          order[i - 1] = B;
          order[i] = A;
          if (isKey(A, B) || i <= 3) {
            pushEvent(lap, 'overtake', `${driverName(state, B.driver.id)} 超越 ${driverName(state, A.driver.id)}，升至 P${i}`, [B.driver.id, A.driver.id], isKey(A, B) || i <= 3);
          }
        } else {
          B.newCum = A.newCum + MIN_GAP + rng.range(0, 0.35);
        }
      }
      // 车队指令：偏向某位车手（让车）
      if (orders.mode === 'favor' && orders.favorDriverId) {
        for (let i = 1; i < order.length; i++) {
          const fav = order[i];
          const mate = order[i - 1];
          if (fav.driver.id !== orders.favorDriverId || mate.team.id !== fav.team.id || !fav.isPlayer) continue;
          const key = `${mate.driver.id}>${fav.driver.id}`;
          if ((orderCooldown.get(key) ?? 0) > lap) continue;
          if (fav.newCum - mate.newCum > 2.5 || totalLaps - lap < 2) continue;
          orderCooldown.set(key, lap + 8);
          const comply = clamp(0.95 - mate.driver.ego / 250 + (mate.driver.trust - 50) / 200, 0.3, 0.98);
          const complied = rng.chance(comply);
          orderOutcomes.push({ lap, yielded: mate.driver.id, favored: fav.driver.id, complied });
          if (complied) {
            const t = mate.newCum;
            mate.newCum = fav.newCum + 0.3;
            fav.newCum = Math.min(fav.newCum, t);
            order[i - 1] = fav;
            order[i] = mate;
            pushEvent(lap, 'order', `车队指令：${driverName(state, mate.driver.id)} 让出位置给 ${driverName(state, fav.driver.id)}`, [mate.driver.id, fav.driver.id], true);
          } else {
            pushEvent(lap, 'order', `${driverName(state, mate.driver.id)} 拒绝执行车队指令，不肯让车给 ${driverName(state, fav.driver.id)}！`, [mate.driver.id, fav.driver.id], true);
          }
        }
      }
    }

    // 4) 进站
    for (const c of order) {
      if (c.status !== 'running') continue;
      c.tyreAge += 1;
      const lapsLeft = totalLaps - lap;
      const planned = c.stintIndex < c.compounds.length - 1;
      const target = c.stints[c.stintIndex] ?? totalLaps;
      const cliff = rules.tyres[c.tyre].cliff;
      let reason = '';
      if (lapsLeft > 0) {
        if (c.repairPending) reason = 'repair';
        else if (planned && c.tyreAge >= target) reason = 'plan';
        else if (planned && (scActive || vscActive) && c.plan.scReaction && c.tyreAge >= target * 0.5) reason = 'sc';
        else if (!planned && lapsLeft > 6 && c.tyreAge > cliff * 1.35 + 4) reason = 'extra';
      }
      if (!reason) continue;
      const lossBase = scActive ? track.pitLoss * 0.5 : vscActive ? track.pitLoss * 0.7 : track.pitLoss;
      const stop = actualStationaryTime(c.team, () => rng.next(), reason === 'repair');
      let stationary = stop.actual;
      const slow = stop.slow;
      if (reason === 'repair') {
        c.repairPending = false;
        c.damage = 0;
      }
      if (reason === 'plan' || reason === 'sc' || (reason === 'repair' && planned && c.tyreAge >= target * 0.5)) {
        c.stintIndex += 1;
        c.tyre = c.compounds[c.stintIndex];
      } else if (reason === 'extra') {
        // 计划外进站：换上能撑到终点的配方
        const pick = wet ? rules.wetCompound : lapsLeft > 18 ? rules.dryCompounds[rules.dryCompounds.length - 1] : rules.dryCompounds[0];
        c.compounds.push(pick);
        c.stints.push(lapsLeft);
        c.stintIndex = c.compounds.length - 1;
        c.tyre = pick;
      }
      c.used.add(c.tyre);
      c.tyreAge = 0;
      c.pits += 1;
      c.newCum += lossBase + stationary;
      c.pittedThisLap = true;
      const label = reason === 'repair' ? '进站更换前翼' : reason === 'sc' ? '趁安全车进站' : reason === 'extra' ? '计划外进站' : '进站';
      if (c.isPlayer || slow) {
        pushEvent(
          lap,
          slow ? 'slow_stop' : 'pit',
          `${driverName(state, c.driver.id)} ${label}，换上${rules.tyres[c.tyre].name}（预计 ${stop.predicted.toFixed(1)}s，实际 ${stationary.toFixed(1)}s${slow ? '，进站失误！' : ''}）`,
          [c.driver.id],
          c.isPlayer,
        );
      }
    }

    // 5) 落定本圈
    for (const c of order) {
      if (c.status !== 'running') continue;
      const actual = c.newCum - c.cum;
      c.cum = c.newCum;
      c.laps = lap;
      if (!scActive && !vscActive && lap > 1 && !c.pittedThisLap && actual < c.bestLap) c.bestLap = actual;
      if (!scActive && !vscActive && lap > 1 && !c.pittedThisLap && (!fastest || actual < fastest.time)) {
        fastest = { driverId: c.driver.id, time: round3(actual), lap };
      }
    }
    // 安全车结束：压缩差距
    if (scActive) {
      scLeft -= 1;
      if (scLeft === 0) {
        const r = running().sort((a, b) => a.cum - b.cum);
        r.forEach((c, i) => {
          if (i > 0) c.cum = r[0].cum + i * 0.7;
        });
        pushEvent(lap, 'sc_end', '安全车回站，比赛重新开始', [], true);
      }
    } else if (vscActive) {
      vscLeft -= 1;
      if (vscLeft === 0) pushEvent(lap, 'sc_end', 'VSC 结束', [], false);
    }
    // 走势
    const pos = running().sort((a, b) => a.cum - b.cum);
    for (const id of Object.keys(lapChart)) {
      const idx = pos.findIndex(c => c.driver.id === id);
      lapChart[id].push(idx >= 0 ? idx + 1 : 0);
    }
    if (lap === 1) {
      for (const c of pos) {
        const p = pos.indexOf(c) + 1;
        if (c.isPlayer && p !== c.grid) {
          pushEvent(1, 'start', `${driverName(state, c.driver.id)} 起步 ${p < c.grid ? `抢下 ${c.grid - p} 个位置` : `丢掉 ${p - c.grid} 个位置`}（P${c.grid}→P${p}）`, [c.driver.id], true);
        }
      }
    }
  }

  // 违规：干地正赛未满足配方数量 +10 秒
  if (!wet && !sprint) {
    for (const c of running()) {
      if (c.used.size < rules.mandatoryCompounds) {
        c.cum += 10;
        pushEvent(totalLaps, 'info', `${driverName(state, c.driver.id)} 未满足轮胎配方规定，罚时 10 秒`, [c.driver.id], true);
      }
    }
  }

  // 成绩
  const finishers = running().sort((a, b) => a.cum - b.cum);
  const dnfs = cars.filter(c => c.status === 'dnf').sort((a, b) => b.laps - a.laps || a.cum - b.cum);
  const points = sprint ? rules.pointsSprint : rules.pointsRace;
  const leader = finishers[0];
  const classification: ClassificationEntry[] = [];
  finishers.forEach((c, i) => {
    const gap = c.cum - (leader?.cum ?? c.cum);
    const lapped = gap > track.baseLap ? Math.floor(gap / track.baseLap) : 0;
    classification.push({
      driverId: c.driver.id,
      teamId: c.team.id,
      pos: i + 1,
      grid: c.grid,
      status: 'finished',
      laps: lapped ? totalLaps - lapped : totalLaps,
      time: round3(c.cum),
      gap: i === 0 ? '冠军' : lapped ? `+${lapped} 圈` : gapText(gap),
      pits: c.pits,
      bestLap: Number.isFinite(c.bestLap) ? round3(c.bestLap) : 0,
      points: points[i] ?? 0,
      reason: '',
      tyres: [...c.compounds.slice(0, c.stintIndex + 1)],
    });
  });
  for (const c of dnfs) {
    classification.push({
      driverId: c.driver.id,
      teamId: c.team.id,
      pos: null,
      grid: c.grid,
      status: 'dnf',
      laps: c.laps,
      time: round3(c.cum),
      gap: 'DNF',
      pits: c.pits,
      bestLap: Number.isFinite(c.bestLap) ? round3(c.bestLap) : 0,
      points: 0,
      reason: c.reason,
      tyres: [...c.compounds.slice(0, c.stintIndex + 1)],
    });
  }
  // 最快圈加分
  const fl = fastest as RaceResult['fastestLap'];
  if (!sprint && rules.fastestLapPoint > 0 && fl) {
    const entry = classification.find(c => c.driverId === fl.driverId);
    if (entry && entry.pos !== null && entry.pos <= rules.fastestLapTopN) entry.points += rules.fastestLapPoint;
  }
  if (fl) pushEvent(fl.lap, 'fastest', `最快圈：${driverName(state, fl.driverId)}（第 ${fl.lap} 圈）`, [fl.driverId], false);
  if (leader) {
    pushEvent(totalLaps, 'finish', `${driverName(state, leader.driver.id)} 赢得${sprint ? '冲刺赛' : '正赛'}！`, [leader.driver.id], true);
  }
  for (const c of finishers) {
    if (c.isPlayer) {
      const e = classification.find(x => x.driverId === c.driver.id)!;
      pushEvent(totalLaps, 'finish', `${driverName(state, c.driver.id)} 第 ${e.pos} 名完赛（发车 P${c.grid}，${planLabel(rules, e.tyres)}）`, [c.driver.id], true);
    }
  }

  const result: RaceResult = {
    kind,
    weather: wet ? 'wet' : 'dry',
    laps: totalLaps,
    classification,
    events,
    fastestLap: fl,
    lapChart,
    safetyCars,
    orderOutcomes,
  };
  return { result, extras };
}

// ───────────────────── Resumable simulation ─────────────────────
// These helpers intentionally use plain records only; no runtime object is persisted.

function liveEvent(session: LiveRaceState, lap: number, type: RaceEvent['type'], text: string, drivers: string[], key: boolean): string {
  const id = `${session.id}:e${session.events.length + 1}`;
  // Cap background chatter, never race-control/key/finish narration.
  if (session.events.length < 70 || key || type === 'finish') session.events.push({ id, lap, type, text, drivers, key });
  return id;
}

function liveCars(session: LiveRaceState): LiveRaceCar[] {
  return Object.values(session.cars);
}

function deployRedFlag(session: LiveRaceState, lap: number, rng: Rng, probability: number): boolean {
  if (session.redFlag?.active || session.totalLaps - lap < 2 || !rng.chance(probability)) return false;
  session.scLeft = 0;
  session.vscLeft = 0;
  session.redFlags += 1;
  const restart = session.surface === 'wet' || session.wetness >= 0.45 ? 'rolling' : 'standing';
  session.redFlag = { active: true, triggerLap: lap, restart, restartPending: false };
  liveEvent(session, lap, 'red_flag', `赛会出示红旗，比赛暂停；稍后将以${restart === 'standing' ? '静态' : '滚动'}方式重启`, [], true);
  return true;
}

function compressRedFlagField(session: LiveRaceState): void {
  const running = liveCars(session).filter(car => car.status === 'running').sort((a, b) => a.cumulativeTime - b.cumulativeTime);
  const leaderTime = running[0]?.cumulativeTime ?? 0;
  running.forEach((car, index) => { car.cumulativeTime = leaderTime + index * 0.25; });
}

function freeRedFlagTyreChange(state: GameState, session: LiveRaceState, car: LiveRaceCar, compound: Compound): void {
  const nextStint = car.stintIndex + 1;
  const remainingLaps = Math.max(1, session.totalLaps - session.completedLaps);
  const remainingCompounds = [compound, ...car.plannedCompounds.slice(nextStint + 1)];
  const tyreLife = predictedTyreLife(state.rules.tyres[compound], car.tyreFactor, { context: car.performanceContext, paceMode: car.plan.paceMode, rules: state.rules });
  if (!state.rules.tyres[compound]?.wet && remainingLaps > tyreLife && remainingCompounds.length === 1) {
    remainingCompounds.push(state.rules.dryCompounds.find(candidate => candidate !== compound) ?? compound);
  }
  car.plannedCompounds.splice(nextStint, car.plannedCompounds.length - nextStint, ...remainingCompounds);
  // Replanning needs to stay constant-time enough for a live safety-car tick;
  // tyre temperature remains in the actual per-lap physics below.
  car.stints.splice(nextStint, car.stints.length - nextStint, ...optimizeStints(state.rules, currentTrack(state), remainingCompounds, remainingLaps, car.tyreFactor, { context: car.performanceContext, paceMode: car.plan.paceMode }));
  car.stintIndex = nextStint;
  car.tyre = compound;
  const replacement = takeTyreSet(state.teams[car.teamId], car.driverId, compound, weekendTyreKey(state), car.tyreSetId);
  car.tyreSetId = replacement?.id;
  car.tyreAge = replacement?.laps ?? 0;
  car.tyreWearAge = replacement?.wearAge ?? replacement?.laps ?? 0;
  car.tyreTemperature = (state.rules.tyres[compound]?.temperatureWindow?.[0] ?? 80) - 18;
  car.usedCompounds.push(compound);
  car.pendingPit = null;
  car.pendingCompound = null;
  liveEvent(session, session.lap, 'pit', `${car.driverId} 在红旗暂停期间免费换上${state.rules.tyres[compound]?.name ?? compound}`, [car.driverId], car.player);
}

function freeRedFlagWingRepair(session: LiveRaceState, car: LiveRaceCar): void {
  if (!car.repairPending) return;
  car.damage = 0;
  car.repairPending = false;
  const damage = [...session.damageLedger].reverse().find(record => record.driverId === car.driverId && record.affectedPartTypes.includes('front_wing') && !record.repairedInRace);
  if (damage) damage.repairedInRace = true;
  liveEvent(session, session.lap, 'damage', `${car.driverId} 在红旗暂停期间免费更换前翼`, [car.driverId], car.player);
}

function playerCars(session: LiveRaceState): LiveRaceCar[] {
  return liveCars(session).filter(c => c.player && c.status === 'running');
}

function playerControlledCars(session: LiveRaceState): LiveRaceCar[] {
  return playerCars(session).filter(c => c.plan.strategySource !== 'engineer' && c.plan.strategySource !== 'perfect');
}

function expectedLivePositions(state: GameState): Record<string, number> {
  const track = currentTrack(state);
  const out: Record<string, number> = {};
  activeEntries(state)
    .map(e => ({ id: e.driver.id, score: trackScore(carRatings(e.team, e.car, state.rules), track) + raceSkill(e.driver, false) }))
    .sort((a, b) => b.score - a.score)
    .forEach((entry, i) => { out[entry.id] = i + 1; });
  return out;
}

/** Starts a serializable session and stops at the grid choice. */
export function createRaceSession(
  state: GameState,
  rng: Rng,
  kind: 'race' | 'sprint',
  expectedPositions = expectedLivePositions(state),
  aiPlans: Record<string, Partial<DriverPlan>> = {},
): LiveRaceState {
  const suppliedAiPlans = aiPlans ?? {};
  const w = state.weekend!;
  const track = currentTrack(state);
  const rules = state.rules;
  const totalLaps = kind === 'sprint' ? Math.max(3, Math.round(track.laps * rules.sprintLapsFactor)) : track.laps;
  const execution = new Rng((rng.next() * 0x100000000) >>> 0);
  const randomWeatherSeed = (rng.next() * 0x100000000) >>> 0;
  const weatherRng = new Rng(kind === 'race' && w.raceWeatherSeed !== undefined ? w.raceWeatherSeed : randomWeatherSeed);
  const forecastRng = new Rng((rng.next() * 0x100000000) >>> 0);
  const quali = kind === 'sprint' ? w.sprintQualifying : w.qualifying;
  const entries = activeEntries(state);
  const grid = [...(quali?.grid ?? [])].filter(id => entries.some(e => e.driver.id === id));
  for (const entry of [...entries].sort((a, b) => trackScore(carRatings(b.team, b.car, rules), track) - trackScore(carRatings(a.team, a.car, rules), track))) {
    if (!grid.includes(entry.driver.id)) grid.push(entry.driver.id);
  }
  const startsWet = (kind === 'race' ? w.weather.race : w.weather.sprint) === 'wet';
  const rainProbability = w.supernaturalRainBias ? clamp(track.rainChance + w.supernaturalRainBias, 0.05, 0.95) : track.rainChance;
  const trajectory = createWeatherTrajectory(totalLaps, startsWet, rainProbability, weatherRng);
  const sessionId = `race-${state.season.number}-${state.season.roundIndex}-${kind}-${state.seq++}`;
  const cars: Record<string, LiveRaceCar> = {};
  const lapChart: Record<string, number[]> = {};
  const disobedient: string[] = [];
  const playerRelationship = teammateRelationship(state, state.meta.playerTeamId);
  for (const [index, id] of grid.entries()) {
    const entry = entries.find(e => e.driver.id === id)!;
    const ratings = carRatings(entry.team, entry.car, rules);
    let plan: DriverPlan;
    if (entry.team.isPlayer) {
      plan = { ...planOf(state, id) };
    } else {
      const setup = effectiveSetup(state, id, w.setup[id] ?? { confidence: 40, tyreKnowledge: 30, thermalKnowledge: 30, trackKnowledge: 30, qualiBonus: 0 });
      const performanceContext = buildPerformanceContext({ driverTyre: entry.driver.attrs.tyre, carTyre: ratings.tyre, setup, ratings, track });
      const baseContext = { driverTyre: entry.driver.attrs.tyre, carTyre: ratings.tyre, paceMode: 'balanced' as const, knowledge: setup.tyreKnowledge, performanceContext };
      const options = strategyOptions(rules, track, totalLaps, baseContext, { wet: false, sprint: kind === 'sprint' });
      const decision = strategyDecisionSkill(entry.team, entry.car.slot);
      const localIndex = decision >= 88 ? 0 : decision >= 74 ? Math.min(1, options.length - 1) : Math.min(2, options.length - 1);
      const gridPosition = index + 1;
      const local: DriverPlan = {
        ...DEFAULT_PLAN,
        strategySource: 'engineer',
        tyrePlan: kind === 'race' ? [...(options[localIndex]?.compounds ?? options[0]?.compounds ?? rules.dryCompounds.slice(0, 2))] : 'auto',
        sprintTyre: kind === 'sprint' ? options[localIndex]?.compounds[0] ?? rules.dryCompounds[1] ?? rules.dryCompounds[0] : 'auto',
        paceMode: gridPosition > Math.ceil(grid.length * 0.65) && entry.driver.attrs.racecraft >= 75 ? 'push' : entry.driver.attrs.consistency < 68 ? 'conserve' : 'balanced',
        pitTiming: decision >= 84 ? 'early' : decision < 65 ? 'late' : 'standard',
        scReaction: decision >= 68,
      };
      const proposed = suppliedAiPlans[id];
      const validTyres = Array.isArray(proposed?.tyrePlan) && !validatePlan(rules, proposed.tyrePlan, false);
      const validPace = proposed?.paceMode === 'conserve' || proposed?.paceMode === 'balanced' || proposed?.paceMode === 'push';
      const validTiming = proposed?.pitTiming === 'early' || proposed?.pitTiming === 'standard' || proposed?.pitTiming === 'late';
      const validReaction = typeof proposed?.scReaction === 'boolean';
      plan = kind === 'race' && validTyres && validPace && validTiming && validReaction
        ? { ...local, tyrePlan: [...proposed.tyrePlan as Compound[]], paceMode: proposed.paceMode!, pitTiming: proposed.pitTiming!, scReaction: proposed.scReaction! }
        : local;
    }
    const instructed = entry.team.isPlayer && (plan.tyrePlan !== 'auto' || plan.paceMode !== 'balanced' || plan.pitTiming !== 'standard');
    if (instructed && willDisobeyStrategy(entry.driver, playerRelationship, `${sessionId}:pre-race:${id}`)) {
      plan = { ...plan, paceMode: entry.driver.ego >= 50 ? 'push' : 'conserve', pitTiming: 'late', scReaction: false };
      disobedient.push(id);
    }
    const setup = effectiveSetup(state, id, w.setup[id] ?? { confidence: 40, tyreKnowledge: 30, thermalKnowledge: 30, trackKnowledge: 30, qualiBonus: 0 });
    const wet = trajectory[0] > 0.18;
    const compounds = wet
      ? [wetCompoundFor(rules, .55)]
      : kind === 'sprint'
        ? [plan.sprintTyre !== 'auto' && rules.tyres[plan.sprintTyre] ? plan.sprintTyre : rules.dryCompounds[1] ?? rules.dryCompounds[0]]
        : plan.tyrePlan !== 'auto' && !validatePlan(rules, plan.tyrePlan, false)
          ? [...plan.tyrePlan]
          : [rules.dryCompounds[1] ?? rules.dryCompounds[0], rules.dryCompounds[0]];
    const performanceContext = buildPerformanceContext({ driverTyre: entry.driver.attrs.tyre, carTyre: ratings.tyre, setup, ratings, track });
    const factor = degFactor(track, { driverTyre: entry.driver.attrs.tyre, carTyre: ratings.tyre, paceMode: plan.paceMode, knowledge: setup.tyreKnowledge, performanceContext });
    const puSpecs = Object.fromEntries(PU_PART_TYPES.map(type => [type, fittedSpec(entry.team, entry.car, type)])) as Partial<Record<PowerUnitPartType, ReturnType<typeof fittedSpec>>>;
    const componentHealth = Object.fromEntries(PU_PART_TYPES.map(type => {
      const spec = puSpecs[type];
      return [type, 100 - puWear(entry.car, type, spec?.id)];
    })) as NonNullable<LiveRaceCar['puComponentHealth']>;
    const componentReliability = Object.fromEntries(PU_PART_TYPES.map(type => [type, puSpecs[type]?.rel ?? ratings.reliability])) as NonNullable<LiveRaceCar['puComponentReliability']>;
    ensureDriverWeekendTyres(state, entry.team, id);
    const startingSet = takeTyreSet(entry.team, id, compounds[0], weekendTyreKey(state));
    cars[id] = {
      driverId: id, teamId: entry.team.id, slot: entry.car.slot, player: entry.team.isPlayer, grid: index + 1,
      score: trackScore(ratings, track), skill: raceSkill(entry.driver, wet), consistency: entry.driver.attrs.consistency,
      racecraft: entry.driver.attrs.racecraft, trust: entry.driver.trust, ego: entry.driver.ego, reliability: ratings.reliability, wetSkill: entry.driver.attrs.wet,
      tyreFactor: factor, setupBonus: practiceEffects(setup, rules, performanceContext.trackFit).race,
      raceEngineerReaction: staffAbility(raceEngineerFor(entry.team, entry.car.slot), 'reaction'),
      raceEngineerWeather: staffAbility(raceEngineerFor(entry.team, entry.car.slot), 'weather'),
      plan, tyre: compounds[0], tyreAge: startingSet?.laps ?? 0, tyreTemperature: (rules.tyres[compounds[0]]?.temperatureWindow?.[0] ?? 80) - 18, tyreWearAge: startingSet?.wearAge ?? startingSet?.laps ?? 0, performanceContext, tyreSetId: startingSet?.id, usedCompounds: [compounds[0]], plannedCompounds: compounds,
      stints: optimizeStints(rules, track, compounds, totalLaps, factor, { context: performanceContext, paceMode: plan.paceMode }), stintIndex: 0, pits: 0, pitStops: [], cumulativeTime: index * 0.25, completedLaps: 0, status: 'running', reason: '', bestLap: null,
      damage: 0, partial: 0, repairPending: false, energy: 65, energyMode: plan.energyMode ?? 'balanced',
      iceHealth: groupHealth(componentHealth, PU_COMBUSTION_PARTS), electricalHealth: groupHealth(componentHealth, PU_ELECTRICAL_PARTS),
      puComponentHealth: componentHealth, puComponentReliability: componentReliability,
      puTemperature: 78, puStatus: 'normal', ersPerformance: ersFactor(entry.team, entry.car, rules),
      iceReliability: groupHealth(componentReliability, PU_COMBUSTION_PARTS), electricalReliability: groupHealth(componentReliability, PU_ELECTRICAL_PARTS),
      pendingPit: null, pendingCompound: null, stayOutUntilLap: 0,
      engineerLightRainAssessed: false, engineerWetAssessed: false, engineerWeatherSpell: 0, engineerTyreOverride: null, engineerTyreOverrideUntilLap: 0,
      engineerWeatherTarget: null, engineerWeatherEligibleLap: 0, lastWeatherPitLap: -99,
      neutralStopTaken: false,
    };
    if (entry.team.isPlayer) lapChart[id] = [];
  }
  const session: LiveRaceState = {
    version: 1, physicsVersion: 2, id: sessionId, kind, roundIndex: state.season.roundIndex,
    totalLaps, completedLaps: 0, lap: 1, stage: 'grid', revision: 1, rngState: execution.state, weatherRngState: weatherRng.state,
    forecastRngState: forecastRng.state, strategistSkill: staffAbility(state.teams[state.meta.playerTeamId].staff.strategist, 'weather'), expectedPositions, cars, order: grid, weatherTrajectory: trajectory, weatherHistory: [],
    rain: trajectory[0] ?? 0, wetness: startsWet ? 0.55 : 0, surface: startsWet ? 'wet' : 'dry',
    forecast: createForecast(trajectory, 0, staffAbility(state.teams[state.meta.playerTeamId].staff.strategist, 'weather'), forecastRng),
    scLeft: 0, vscLeft: 0, safetyCars: 0, redFlags: 0, redFlag: null, fastestLap: null, events: [], lapChart, orderOutcomes: [], orderCooldown: {},
    teamOrders: { ...w.teamOrders }, pendingDecision: null, damageLedger: [], specialIncidents: [], norrisTeammateRollDone: false,
  };
  if (kind === 'race') {
    for (const type of ['mclaren_pu', 'mercedes_pu'] as const) {
      const teamId = type === 'mclaren_pu' ? 'mclaren' : 'mercedes';
      const candidates = Object.values(cars).filter(car => car.teamId === teamId);
      const chance = specialFailureChance(state, type);
      if (chance > 0 && candidates.length && execution.chance(chance)) {
        const target = candidates[execution.int(0, candidates.length - 1)];
        session.specialIncidents!.push({ type, driverId: target.driverId, lap: execution.int(2, Math.max(2, totalLaps - 2)), handled: false });
      }
    }
    applyAudiStartDrop(state, session, execution);
    applyFerrariStartGain(state, session, execution);
    session.rngState = execution.state;
  }
  for (const driverId of disobedient) liveEvent(session, 0, 'order', `${driverId} 拒绝执行赛前策略，决定按自己的节奏比赛`, [driverId], true);
  session.weatherRngState = weatherRng.state;
  session.forecastRngState = forecastRng.state;
  const controlled = playerControlledCars(session);
  session.pendingDecision = controlled.length ? { id: `${session.id}:w1`, lap: 0, stage: 'grid', reasons: ['grid'], affectedDriverIds: controlled.map(c => c.driverId), eligibleDriverIds: controlled.map(c => c.driverId), observedEventIds: [] } : null;
  return session;
}

function createWindow(session: LiveRaceState, reasons: RaceDecisionWindow['reasons'], affected: string[], events: string[]): void {
  if (session.pendingDecision) return;
  const eligible = playerControlledCars(session).map(c => c.driverId);
  // When both player cars retire, never create an unresolvable decision window.
  if (!eligible.length) return;
  session.pendingDecision = {
    id: `${session.id}:w${session.revision + session.completedLaps + 1}`, lap: session.lap, stage: 'before_pit', reasons: [...new Set(reasons)],
    affectedDriverIds: [...new Set(affected)], eligibleDriverIds: eligible, observedEventIds: events,
  };
  session.stage = 'before_pit';
}

export function wetCompoundFor(rules: GameState['rules'], wetness: number): Compound {
  return wetness >= .82 ? rules.fullWetCompound : rules.wetCompound;
}

export function tyreWeatherPenalty(rules: GameState['rules'], compound: Compound, wetness: number): number {
  if (compound === rules.fullWetCompound) return Math.max(0, .62 - wetness) * 6;
  if (compound === rules.wetCompound) return Math.max(0, .34 - wetness) * 7 + Math.max(0, wetness - .72) * 6;
  if (rules.tyres[compound]?.wet) return Math.max(0, .4 - wetness) * 4;
  return Math.max(0, wetness - .2) * 8;
}

function tyreMismatch(rules: GameState['rules'], car: LiveRaceCar, wetness: number): number {
  return tyreWeatherPenalty(rules, car.tyre, wetness);
}

function weatherTyreCost(rules: GameState['rules'], compound: Compound, wetness: number): number {
  return (rules.tyres[compound]?.pace ?? 0) + tyreWeatherPenalty(rules, compound, wetness);
}

function weatherTyreChangeWorthwhile(rules: GameState['rules'], current: Compound, target: Compound, wetness: number): boolean {
  if (target === current || (!rules.tyres[current]?.wet && !rules.tyres[target]?.wet)) return false;
  // Keep a small hysteresis band so short showers do not cause tyre ping-pong,
  // while still allowing the full-wet → intermediate crossover after water
  // begins to drain.
  return weatherTyreCost(rules, target, wetness) + .2 < weatherTyreCost(rules, current, wetness);
}

/**
 * Live weather calls use the simulated race engineer, not a fresh LLM request
 * every lap. Better engineers react sooner, while each car keeps a stable,
 * deterministic variation. Ferrari deliberately retains its instant calls.
 */
export function aiWeatherReactionDelay(state: GameState, session: LiveRaceState, car: LiveRaceCar, target: Compound): number {
  if (car.player || car.plan.strategySource !== 'engineer' || car.teamId === 'ferrari') return 0;
  const team = state.teams[car.teamId];
  const strategistWeather = team ? staffAbility(team.staff.strategist, 'weather') : 70;
  const skill = (car.raceEngineerWeather + car.raceEngineerReaction + strategistWeather) / 3;
  const advantage = weatherTyreCost(state.rules, car.tyre, session.wetness) - weatherTyreCost(state.rules, target, session.wetness);
  const base = skill >= 85 ? 0 : 1;
  const urgent = advantage >= 2.4 ? 1 : 0;
  const variation = engineerDecisionRoll(session, car, `weather-delay:${target}:${Math.round(session.wetness * 20)}`, .45) ? 1 : 0;
  return clamp(base - urgent + variation, 0, 2);
}

function aiWeatherStopReady(state: GameState, session: LiveRaceState, car: LiveRaceCar, target: Compound): boolean {
  const immediate = car.tyreAge >= 2 && weatherTyreChangeWorthwhile(state.rules, car.tyre, target, session.wetness);
  if (car.player || car.plan.strategySource !== 'engineer' || car.teamId === 'ferrari') return immediate;
  const currentWet = !!state.rules.tyres[car.tyre]?.wet;
  const targetWet = !!state.rules.tyres[target]?.wet;
  const advantage = weatherTyreCost(state.rules, car.tyre, session.wetness) - weatherTyreCost(state.rules, target, session.wetness);
  const minimumGain = currentWet === targetWet ? .9 : .55;
  const cooledDown = session.lap - (car.lastWeatherPitLap ?? -99) >= 4;
  const worthwhile = car.tyreAge >= 2
    && cooledDown
    && advantage >= minimumGain
    && immediate;
  if (!worthwhile) {
    car.engineerWeatherTarget = null;
    car.engineerWeatherEligibleLap = 0;
    return false;
  }
  if (car.engineerWeatherTarget !== target) {
    car.engineerWeatherTarget = target;
    car.engineerWeatherEligibleLap = session.lap + aiWeatherReactionDelay(state, session, car, target);
  }
  return session.lap >= (car.engineerWeatherEligibleLap ?? session.lap);
}

function replacementCompound(state: GameState, session: LiveRaceState, car: LiveRaceCar): Compound {
  if (car.pendingCompound) return car.pendingCompound;
  if (car.engineerTyreOverride && session.lap <= (car.engineerTyreOverrideUntilLap ?? 0)) return car.engineerTyreOverride;
  if (session.wetness >= .22) return wetCompoundFor(state.rules, session.wetness);
  // A wet-start plan contains W only. On a drying track choose a real dry tyre
  // instead of pitting repeatedly onto the same mismatched compound.
  const planned = car.plannedCompounds.slice(car.stintIndex + 1).find(compound => !state.rules.tyres[compound]?.wet);
  return planned ?? state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0] ?? car.tyre;
}

export function engineerDecisionRoll(session: Pick<LiveRaceState, 'id'> & Partial<Pick<LiveRaceState, 'weatherRngState'>>, car: Pick<LiveRaceCar, 'driverId'>, key: string, probability: number): boolean {
  let hash = 2166136261;
  for (const char of `${session.id}:${session.weatherRngState ?? 0}:${car.driverId}:${key}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return new Rng(hash >>> 0).chance(probability);
}

export function engineerWeatherRisk(weather: number, reaction: number, risk: number, wetness: number): { probability: number; preference: 'soft' | 'medium' | 'intermediate'; holdLaps: number } | null {
  const error = clamp((105 - weather) * 0.006 + (70 - reaction) * 0.002 + (risk - 70) * 0.0015, 0.03, 0.65);
  if (wetness >= .03 && wetness <= .2 && risk >= 82) return { probability: clamp(error + .2, .08, .75), preference: 'intermediate', holdLaps: 3 };
  if (wetness < .3) return null;
  return { probability: error, preference: risk >= 78 ? 'soft' : 'medium', holdLaps: reaction >= 82 ? 1 : 2 };
}

function applyEngineerWeatherDecision(state: GameState, session: LiveRaceState, car: LiveRaceCar): boolean {
  if (car.plan.strategySource !== 'engineer') return false;
  if (session.wetness < .02) {
    if (car.engineerLightRainAssessed || car.engineerWetAssessed) car.engineerWeatherSpell = (car.engineerWeatherSpell ?? 0) + 1;
    car.engineerLightRainAssessed = false;
    car.engineerWetAssessed = false;
    car.engineerTyreOverride = null;
    car.engineerTyreOverrideUntilLap = 0;
  }
  const team = state.teams[car.teamId];
  const strategistRisk = team ? staffAbility(team.staff.strategist, 'risk') : 70;
  const risk = engineerWeatherRisk(car.raceEngineerWeather, car.raceEngineerReaction, strategistRisk, session.wetness);
  if (risk?.preference === 'intermediate' && !car.engineerLightRainAssessed) {
    car.engineerLightRainAssessed = true;
    if (engineerDecisionRoll(session, car, `light-rain:${car.engineerWeatherSpell ?? 0}`, risk.probability)) {
      car.engineerTyreOverride = state.rules.wetCompound;
      car.engineerTyreOverrideUntilLap = session.lap + risk.holdLaps;
      const call = car.teamId === 'ferrari' ? '要求' : '建议';
      liveEvent(session, session.lap, 'pit', `${car.driverId} 的工程师对小雨反应过度，${call}提前换半雨胎`, [car.driverId], car.player);
      return true;
    }
  }
  if (session.wetness > .2) car.engineerLightRainAssessed = true;
  if (!car.engineerWetAssessed && session.wetness >= .3) {
    car.engineerWetAssessed = true;
    if (risk && risk.preference !== 'intermediate' && engineerDecisionRoll(session, car, `wet-dry-tyre:${car.engineerWeatherSpell ?? 0}`, risk.probability)) {
      const dry = risk.preference === 'soft' ? state.rules.dryCompounds[0] : state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0];
      if (dry) {
        car.engineerTyreOverride = dry;
        car.engineerTyreOverrideUntilLap = session.lap + risk.holdLaps;
        const call = car.teamId === 'ferrari' ? '要求' : '建议';
        liveEvent(session, session.lap, 'pit', `${car.driverId} 的工程师误判湿地，${call}换上${state.rules.tyres[dry]?.name ?? dry}`, [car.driverId], car.player);
        return true;
      }
    }
  }
  return false;
}

function pitTriggerLap(car: LiveRaceCar): number {
  const base = car.stints[car.stintIndex] ?? Number.MAX_SAFE_INTEGER;
  return Math.max(2, Math.round(base * (car.plan.pitTiming === 'early' ? .88 : car.plan.pitTiming === 'late' ? 1.12 : 1)));
}

function executePit(state: GameState, session: LiveRaceState, car: LiveRaceCar, rng: Rng, force = false): void {
  if (car.status !== 'running' || session.completedLaps >= session.totalLaps) return;
  const track = currentTrack(state);
  const planned = car.stintIndex < car.plannedCompounds.length - 1;
  const engineerOverride = applyEngineerWeatherDecision(state, session, car);
  const targetCompound = replacementCompound(state, session, car);
  const differentCompound = targetCompound !== car.tyre;
  const weatherReady = aiWeatherStopReady(state, session, car, targetCompound);
  const weatherStop = differentCompound && (weatherReady || (car.teamId === 'ferrari' && engineerOverride));
  const plannedStop = !weatherStop && planned && car.tyreAge >= pitTriggerLap(car);
  const stayOut = car.pendingPit === 'stay_out' && session.lap <= car.stayOutUntilLap;
  const neutralActive = session.scLeft > 0 || session.vscLeft > 0;
  if (!neutralActive) car.neutralStopTaken = false;
  const neutralOpportunity = car.plan.scReaction && neutralActive && !car.neutralStopTaken && planned
    && car.tyreAge >= Math.max(2, Math.round(pitTriggerLap(car) * .5)) && targetCompound !== car.tyre;
  const plannedAdvance = plannedStop || neutralOpportunity;
  const shouldPit = force || car.pendingPit === 'box' || (!stayOut && (car.repairPending || weatherStop || neutralOpportunity || plannedStop));
  if (!shouldPit) return;
  const neutral = session.scLeft > 0 ? 0.5 : session.vscLeft > 0 ? 0.7 : 1;
  const repair = car.repairPending;
  const stop = actualStationaryTime(state.teams[car.teamId], () => rng.next(), repair);
  const stationary = stop.actual;
  if (car.repairPending) { car.damage = 0; car.repairPending = false; const damage = [...session.damageLedger].reverse().find(d => d.driverId === car.driverId && !d.repairedInRace); if (damage) damage.repairedInRace = true; }
  if (car.pendingPit === 'box' || plannedAdvance || weatherStop) {
    if (plannedAdvance) car.stintIndex += 1;
    // A decision can choose a compound, but it takes effect only after this car
    // has actually entered the pits. AI changes respond to the public surface.
    car.tyre = targetCompound;
    if (weatherStop && !state.rules.tyres[targetCompound]?.wet) {
      const matchingDryStint = car.plannedCompounds.slice(car.stintIndex + 1).findIndex(compound => compound === targetCompound);
      if (matchingDryStint >= 0) car.stintIndex += matchingDryStint + 1;
    }
    const replacement = takeTyreSet(state.teams[car.teamId], car.driverId, car.tyre, weekendTyreKey(state), car.tyreSetId);
    car.tyreSetId = replacement?.id;
    car.tyreAge = replacement?.laps ?? 0;
    car.tyreWearAge = replacement?.wearAge ?? replacement?.laps ?? 0;
    car.tyreTemperature = (state.rules.tyres[car.tyre]?.temperatureWindow?.[0] ?? 80) - 18;
  }
  car.usedCompounds.push(car.tyre); car.pits += 1; car.pitStops ??= []; car.pitStops.push({ lap: session.lap, predictedStationary: stop.predicted, actualStationary: stationary, slow: stop.slow, repair }); car.cumulativeTime += track.pitLoss * neutral + stationary;
  car.engineerWeatherTarget = null;
  car.engineerWeatherEligibleLap = 0;
  if (weatherStop) car.lastWeatherPitLap = session.lap;
  if (neutralActive) car.neutralStopTaken = true;
  liveEvent(session, session.lap, stop.slow ? 'slow_stop' : 'pit', `${car.driverId} 进站，换上${state.rules.tyres[car.tyre]?.name ?? car.tyre}（预计 ${stop.predicted.toFixed(1)}s，实际 ${stationary.toFixed(1)}s${stop.slow ? '，失误' : ''}）`, [car.driverId], car.player);
  car.pendingPit = null;
  car.pendingCompound = null;
}

/** Advances exactly through the serializable loop, stopping before a player pit stage when needed. */
export function advanceRaceSession(state: GameState, session: LiveRaceState, until: 'next_lap' | 'next_decision' = 'next_decision'): void {
  if (session.pendingDecision || session.stage === 'finished') return;
  const rng = Rng.restore(session.rngState);
  const forecastRng = Rng.restore(session.forecastRngState);
  const track = currentTrack(state);
  const rules = state.rules;
  while (session.completedLaps < session.totalLaps) {
    const lap = session.completedLaps + 1;
    session.lap = lap;
    const previousWetness = session.wetness;
    const previousSurface = session.surface;
    session.rain = session.weatherTrajectory[lap - 1] ?? 0;
    session.wetness = nextWetness(session.wetness, session.rain);
    session.surface = surfaceFor(session.wetness, previousSurface);
    session.weatherHistory.push(session.rain);
    session.forecast = createForecast(session.weatherTrajectory, session.completedLaps, session.strategistSkill, forecastRng);
    const scActive = session.scLeft > 0, vscActive = session.vscLeft > 0;
    const restartType = session.redFlag?.restartPending ? session.redFlag.restart : null;
    // Consume the pending restart once at lap entry. A decision later in this
    // lap cannot make the standing-start launch penalty happen twice.
    if (restartType) session.redFlag = null;
    const field = liveCars(session).filter(c => c.status === 'running').sort((a, b) => a.cumulativeTime - b.cumulativeTime);
    const incidentIds: string[] = [];
    for (const car of field) {
      const wet = session.wetness > 0.3;
      const base = track.baseLap * (1 + session.wetness * 0.12) + (100 - car.score) * rules.secPerCarPoint + (100 - (wet ? (car.skill + car.wetSkill) / 2 : car.skill)) * rules.secPerDriverPoint - car.setupBonus;
      const oldPuStatus = car.puStatus ?? 'normal';
      const ersPerformance = car.ersPerformance ?? 1;
      const cooling = scActive || vscActive ? 5 : session.wetness > .3 ? 2.8 : 1.5;
      const heatGain = car.energyMode === 'deploy' ? 5.2 : car.energyMode === 'harvest' ? -2.8 : .4;
      car.puTemperature = clamp((car.puTemperature ?? 78) + heatGain + (car.plan.paceMode === 'push' ? 1.2 : car.plan.paceMode === 'conserve' ? -.8 : 0) - cooling, 55, 122);
      car.puStatus = puStatus(car.puTemperature);
      const heatLimit = car.puStatus === 'critical' ? .38 : car.puStatus === 'protect' ? .62 : car.puStatus === 'hot' ? .86 : 1;
      const healthLimit = clamp(minGroupHealth(car.puComponentHealth, PU_ELECTRICAL_PARTS) / 70, .45, 1);
      const recovery = (car.energyMode === 'harvest' ? 7.5 : 2) * ersPerformance * healthLimit * (session.wetness > .3 ? .85 : 1);
      const energyDelta = car.energyMode === 'deploy' ? -11 : recovery;
      car.energy = Math.max(0, Math.min(100, car.energy + energyDelta));
      const deployStrength = ersPerformance * healthLimit * heatLimit * clamp(car.energy / 30, .25, 1);
      const energyTime = car.energyMode === 'harvest' ? .22 + .08 / Math.max(.6, ersPerformance) : car.energyMode === 'deploy' && car.energy > 0 ? -.3 * deployStrength : 0;
      car.puComponentHealth ??= {};
      car.puComponentReliability ??= {};
      for (const type of PU_PART_TYPES) {
        const electrical = PU_ELECTRICAL_PARTS.includes(type);
        const rel = car.puComponentReliability[type] ?? car.reliability;
        const baseWear = electrical ? .014 : .012;
        const stress = electrical ? (car.energyMode === 'deploy' ? .018 : 0) : (car.plan.paceMode === 'push' ? .012 : 0);
        const heat = Math.max(0, car.puTemperature - 102) * (electrical ? .004 : .003);
        const rate = type === 'exhaust' ? .7 : type === 'control_electronics' ? .8 : type === 'turbocharger' ? 1.1 : 1;
        car.puComponentHealth[type] = clamp((car.puComponentHealth[type] ?? 100) - (baseWear + Math.max(0, 88 - rel) * (electrical ? .0014 : .0012) + stress + heat) * rate, 0, 100);
      }
      car.iceHealth = groupHealth(car.puComponentHealth, PU_COMBUSTION_PARTS);
      car.electricalHealth = groupHealth(car.puComponentHealth, PU_ELECTRICAL_PARTS);
      if ((car.puStatus === 'protect' || car.puStatus === 'critical') && oldPuStatus !== 'protect' && oldPuStatus !== 'critical') {
        incidentIds.push(liveEvent(session, lap, 'damage', `${car.driverId} 的动力单元温度过高，进入保护模式`, [car.driverId], car.player));
      } else if (car.puStatus === 'normal' && oldPuStatus !== 'normal') {
        liveEvent(session, lap, 'damage', `${car.driverId} 的动力单元温度恢复正常`, [car.driverId], car.player);
      }
      const v2 = session.physicsVersion === 2 && !!car.performanceContext;
      const tyreStep = v2
        ? stepTyre(car.performanceContext!, rules.tyres[car.tyre], { temperature: car.tyreTemperature, wearAge: car.tyreWearAge }, { paceMode: car.plan.paceMode, wetness: session.wetness, neutral: scActive || vscActive }, rules)
        : null;
      const paceWear = car.plan.paceMode === 'push' ? 1.15 : car.plan.paceMode === 'conserve' ? .88 : 1;
      // Fuel burn preserves the legacy early-race weight penalty; ERS deployment
      // remains useful for pace and overtaking but becomes weaker when depleted.
      const fuel = (session.totalLaps - lap) * .03;
      let lapTime = base + fuel + (tyreStep ? tyreLapDelta(rules.tyres[car.tyre], tyreStep.wearAge, 1) + tyreStep.lapPenalty : tyreLapDelta(rules.tyres[car.tyre], car.tyreAge + 1, car.tyreFactor) * paceWear) + tyreMismatch(rules, car, session.wetness) + PACE_MODE_TIME[car.plan.paceMode] + car.damage + car.partial + energyTime + rng.normal(0, (0.12 + (100 - car.consistency) * .004) * (1 + session.wetness * .5));
      if (lap === 1) lapTime += 2.5 + rng.normal(0, .35);
      else if (restartType === 'standing') lapTime += 2.1 + rng.normal(0, .3) - (car.racecraft - 75) * .006;
      if (scActive) lapTime = track.baseLap * 1.35 + rng.normal(0, .05);
      else if (vscActive) lapTime = base * 1.25 + rng.normal(0, .05);
      car.cumulativeTime += lapTime; car.completedLaps = lap; car.tyreAge += 1;
      if (tyreStep) { car.tyreTemperature = tyreStep.temperature; car.tyreWearAge = tyreStep.wearAge; }
      const tyreSet = state.teams[car.teamId]?.tyreInventory?.[car.driverId]?.find(set => set.id === car.tyreSetId);
      useTyreSet(tyreSet, 1, tyreStep?.wearMultiplier ?? 1);
      if (!scActive && !vscActive && lap > 1 && car.bestLap === null || (!scActive && !vscActive && lap > 1 && lapTime < (car.bestLap ?? Infinity))) car.bestLap = lapTime;
      const astonVibrationRetirement = !scActive && !vscActive && !session.redFlag?.active
        && car.teamId === 'aston_martin' && astonVibrationActive(state)
        && lap % state.rules.astonMartin.vibrationInterval === 0
        && rng.chance(state.rules.astonMartin.vibrationRetireChance);
      if (astonVibrationRetirement) {
        car.status = 'dnf';
        car.reason = '危险振动达到手部损伤阈值，车队强制退赛';
        incidentIds.push(liveEvent(session, lap, 'dnf', `${car.driverId} 的赛车振动达到危险阈值，车队为防止永久性手部损伤强制其退赛`, [car.driverId], true));
        continue;
      }
      if (!scActive && !vscActive && !session.redFlag?.active) {
        const paceRisk = car.plan.paceMode === 'push' ? 1.4 : car.plan.paceMode === 'conserve' ? .8 : 1;
        const energyRisk = car.energyMode === 'deploy' && car.energy < 15 ? 1.35 : car.energyMode === 'deploy' ? 1.12 : 1;
        const weakestPuHealth = Math.min(...PU_PART_TYPES.map(type => car.puComponentHealth?.[type] ?? 100));
        const puRisk = 1 + Math.max(0, 55 - weakestPuHealth) / 35 + (car.puStatus === 'critical' ? 1.4 : car.puStatus === 'protect' ? .45 : 0);
        const pFail = raceFailProb(car.reliability) / session.totalLaps * paceRisk * energyRisk * puRisk;
        const pCrash = (.02 + (100 - car.consistency) / 100 * .06) * (1 + session.wetness) / session.totalLaps * paceRisk * energyRisk * redBullCrashMultiplier(state, car.teamId);
        const special = session.specialIncidents?.find(incident => !incident.handled && incident.driverId === car.driverId && incident.lap <= lap);
        if (special) {
          special.handled = true;
          if (special.type === 'mclaren_pu') {
            const crashChance = clamp(.68 - car.consistency * .005 - car.racecraft * .002, .12, .55);
            if (rng.chance(crashChance)) {
              car.status = 'dnf';
              car.reason = '动力单元异常放电后失控撞车';
              const incidentId = `${session.id}:i${session.damageLedger.length + 1}`;
              session.damageLedger.push({ id: `${incidentId}:damage`, incidentId, driverId: car.driverId, teamId: car.teamId, slot: car.slot, cause: 'single_car', severity: 'dnf', affectedPartTypes: ['front_wing'], repairedInRace: false });
              incidentIds.push(liveEvent(session, lap, 'dnf', `${car.driverId} 遭遇动力单元异常放电并失控撞车`, [car.driverId], true));
            } else {
              car.partial = Math.max(car.partial, 1.1);
              incidentIds.push(liveEvent(session, lap, 'damage', `${car.driverId} 遭遇动力单元异常放电，但成功救车`, [car.driverId], true));
            }
          } else if (rng.chance(.45)) {
            car.status = 'dnf';
            car.reason = '动力单元可靠性故障';
            incidentIds.push(liveEvent(session, lap, 'dnf', `${car.driverId} 因动力单元可靠性故障退赛`, [car.driverId], true));
          } else {
            car.partial = Math.max(car.partial, .9);
            incidentIds.push(liveEvent(session, lap, 'damage', `${car.driverId} 的动力单元进入保护模式`, [car.driverId], true));
          }
        } else if (rng.chance(pFail)) {
          const failureScore = (type: PowerUnitPartType) => (car.puComponentHealth?.[type] ?? 100) - (100 - (car.puComponentReliability?.[type] ?? car.reliability)) * .5;
          const failedType = [...PU_PART_TYPES].sort((a, b) => failureScore(a) - failureScore(b))[0];
          const failedName = rules.parts[failedType]?.name ?? failedType;
          if (rng.chance(.35) && car.partial === 0) { car.partial = rng.range(.6, 1.2); incidentIds.push(liveEvent(session, lap, 'damage', `${car.driverId} 的${failedName}进入保护模式`, [car.driverId], car.player)); }
          else { car.status = 'dnf'; car.reason = `${failedName}故障`; incidentIds.push(liveEvent(session, lap, 'dnf', `${car.driverId} 因${car.reason}退赛`, [car.driverId], true)); }
        } else if (rng.chance(pCrash * (lap === 1 ? 4 : 1))) {
          const dnf = rng.chance(.45);
          const incidentId = `${session.id}:i${session.damageLedger.length + 1}`;
          if (dnf) { car.status = 'dnf'; car.reason = wet ? '雨中失控撞车' : '失误撞车'; }
          else { car.damage = .9; car.repairPending = true; }
          const newWing = dnf || !session.damageLedger.some(d => d.driverId === car.driverId && d.affectedPartTypes.includes('front_wing') && !d.repairedInRace);
          session.damageLedger.push({ id: `${incidentId}:damage`, incidentId, driverId: car.driverId, teamId: car.teamId, slot: car.slot, cause: 'single_car', severity: dnf ? 'dnf' : newWing ? 'wing' : 'minor', affectedPartTypes: newWing ? ['front_wing'] : [], repairedInRace: false });
          incidentIds.push(liveEvent(session, lap, dnf ? 'dnf' : 'error', `${car.driverId}${dnf ? ' 撞车退赛' : ' 前翼受损'}`, [car.driverId], true));
          // A stopped DNF nearly always needs race control; a recoverable wing
          // incident only sometimes produces a short VSC/SC interruption.
          if (dnf || rng.chance(.38)) {
            if (dnf && deployRedFlag(session, lap, rng, redFlagProbability('dnf', session.wetness, 1, track.scChance))) incidentIds.push(session.events[session.events.length - 1].id);
            else if (dnf && rng.chance(track.scChance)) { session.scLeft = rng.int(3, 5); session.safetyCars++; incidentIds.push(liveEvent(session, lap, 'sc', '安全车出动！', [], true)); }
            else { session.vscLeft = rng.int(1, 2); incidentIds.push(liveEvent(session, lap, 'vsc', '虚拟安全车（VSC）', [], true)); }
          }
        }
      }
    }
    // Every car has now received this lap's time. Compressing earlier would
    // leave cars later in the loop roughly one lap behind the leaders.
    if (session.redFlag?.active && session.redFlag.triggerLap === lap) compressRedFlagField(session);
    // 2026 overtake mode is available only while dry enough and under green flag.
    // It is driven by the configured public gap/bonus rather than hidden weather truth.
    const passers = liveCars(session).filter(c => c.status === 'running').sort((a, b) => a.cumulativeTime - b.cumulativeTime);
    if (!scActive && !vscActive && !session.redFlag?.active && session.wetness < .3) for (let i = 1; i < passers.length; i++) {
      const ahead = passers[i - 1], behind = passers[i];
      const gap = behind.cumulativeTime - ahead.cumulativeTime;
      const heldTeammates = session.teamOrders.mode === 'hold' && ahead.player && behind.player && ahead.teamId === behind.teamId;
      const deployQuality = (behind.ersPerformance ?? 1) * clamp((behind.electricalHealth ?? 100) / 70, .45, 1) * ((behind.puStatus === 'protect' || behind.puStatus === 'critical') ? .55 : behind.puStatus === 'hot' ? .85 : 1);
      const ersAdvantage = behind.energyMode === 'deploy' && behind.energy > 5 ? .025 * deployQuality : behind.energyMode === 'harvest' ? -.01 : 0;
      const probability = Math.max(0, rules.overtakeModeBonus) * .03 + ersAdvantage + (behind.racecraft - ahead.racecraft) * .0015 + (behind.score - ahead.score) * .0008;
      if (heldTeammates || gap > rules.overtakeModeGap || !rng.chance(clamp(probability, .005, .22))) continue;
      if (behind.energyMode === 'deploy') behind.energy = Math.max(0, behind.energy - 5);
      behind.cumulativeTime = ahead.cumulativeTime - .1 - rng.range(0, .3);
      liveEvent(session, lap, 'overtake', `${behind.driverId} 超越 ${ahead.driverId}`, [behind.driverId, ahead.driverId], ahead.player || behind.player);
    }
    // Close racing can now end in a time loss, repairable wing damage, or a DNF;
    // the structured ledger prevents a repaired/destroyed wing being charged twice.
    const combatants = liveCars(session).filter(c => c.status === 'running').sort((a, b) => a.cumulativeTime - b.cumulativeTime);
    for (let i = 1; i < combatants.length; i++) {
      const ahead = combatants[i - 1], behind = combatants[i];
      const norrisTeammateFight = !!state.mclaren && ahead.teamId === 'mclaren' && behind.teamId === 'mclaren' && (ahead.driverId === 'norris' || behind.driverId === 'norris');
      const norrisOpportunity = norrisTeammateFight && behind.cumulativeTime - ahead.cumulativeTime <= 1.2 && !scActive && !vscActive && !session.redFlag?.active && !session.norrisTeammateRollDone;
      const collisionChance = norrisOpportunity ? .05 : .006 * (1 + session.wetness);
      if (norrisOpportunity) session.norrisTeammateRollDone = true;
      if (behind.cumulativeTime - ahead.cumulativeTime > 1.2 || scActive || vscActive || session.redFlag?.active || !rng.chance(collisionChance)) continue;
      const victim = rng.chance(.5) ? ahead : behind;
      const incidentId = `${session.id}:i${session.damageLedger.length + 1}`;
      const roll = rng.next();
      if (roll < .18) { victim.status = 'dnf'; victim.reason = `与 ${victim === ahead ? behind.driverId : ahead.driverId} 碰撞`; }
      else if (roll < .68) { victim.damage = Math.max(victim.damage, .85); victim.repairPending = true; }
      else victim.cumulativeTime += 2.5;
      const existingWing = session.damageLedger.some(d => d.driverId === victim.driverId && d.affectedPartTypes.includes('front_wing') && !d.repairedInRace);
      const severity = roll < .18 ? 'dnf' : roll < .68 && !existingWing ? 'wing' : 'minor';
      session.damageLedger.push({ id: `${incidentId}:damage`, incidentId, driverId: victim.driverId, teamId: victim.teamId, slot: victim.slot, cause: 'collision', severity, affectedPartTypes: severity === 'minor' ? [] : ['front_wing'], repairedInRace: false });
      incidentIds.push(liveEvent(session, lap, severity === 'dnf' ? 'dnf' : 'error', `${behind.driverId} 与 ${ahead.driverId} 争位发生碰撞`, [ahead.driverId, behind.driverId], ahead.player || behind.player));
      if (severity === 'dnf' ? rng.chance(track.scChance) : severity === 'wing' && rng.chance(.28)) {
        if (severity === 'dnf' && deployRedFlag(session, lap, rng, redFlagProbability('dnf', session.wetness, 2, track.scChance))) {
          compressRedFlagField(session);
          incidentIds.push(session.events[session.events.length - 1].id);
        }
        else if (severity === 'dnf' && rng.chance(track.scChance)) { session.scLeft = rng.int(3, 5); session.safetyCars++; incidentIds.push(liveEvent(session, lap, 'sc', '安全车出动！', [], true)); }
        else { session.vscLeft = rng.int(1, 2); incidentIds.push(liveEvent(session, lap, 'vsc', '虚拟安全车（VSC）', [], true)); }
      }
      break;
    }
    session.order = liveCars(session).filter(c => c.status === 'running').sort((a, b) => a.cumulativeTime - b.cumulativeTime).map(c => c.driverId);
    // Execute an order only for a realistic, close on-track reversal: the favored
    // car must be immediately behind its teammate and both must still be racing.
    if (!session.redFlag?.active && session.teamOrders.mode === 'favor' && session.teamOrders.favorDriverId && lap < session.totalLaps - 1) {
      const favored = session.cars[session.teamOrders.favorDriverId];
      const favoredPos = favored ? session.order.indexOf(favored.driverId) : -1;
      const mate = favoredPos > 0 ? session.cars[session.order[favoredPos - 1]] : undefined;
      const key = mate && favored ? `${mate.driverId}>${favored.driverId}` : '';
      const close = mate && favored && mate.player && mate.teamId === favored.teamId && mate.status === 'running' && favored.status === 'running' && favored.cumulativeTime - mate.cumulativeTime < 2.2;
      if (close && mate && favored && (session.orderCooldown[key] ?? 0) <= lap) {
        const driver = state.drivers[mate.driverId];
        const relationship = teammateRelationship(state, mate.teamId);
        const compliance = driver ? 1 - strategyDisobedienceChance(driver, relationship) : .98;
        const complied = rng.chance(compliance);
        session.orderCooldown[key] = lap + 8;
        session.orderOutcomes.push({ lap, yielded: mate.driverId, favored: favored.driverId, complied });
        if (complied) { const t = mate.cumulativeTime; mate.cumulativeTime = favored.cumulativeTime + .3; favored.cumulativeTime = t; session.order = liveCars(session).filter(c => c.status === 'running').sort((a, b) => a.cumulativeTime - b.cumulativeTime).map(c => c.driverId); }
        liveEvent(session, lap, 'order', complied ? `车队指令：${mate.driverId} 让出位置给 ${favored.driverId}` : `${mate.driverId} 拒绝执行车队指令`, [mate.driverId, favored.driverId], true);
      }
    }
    for (const car of Object.values(session.cars).filter(c => c.player)) { const pos = session.order.indexOf(car.driverId); session.lapChart[car.driverId]?.push(pos < 0 ? 0 : pos + 1); }
    const fastestCar = liveCars(session).filter(c => c.bestLap !== null).sort((a, b) => (a.bestLap ?? Infinity) - (b.bestLap ?? Infinity))[0];
    if (fastestCar && fastestCar.bestLap !== null) session.fastestLap = { driverId: fastestCar.driverId, time: round3(fastestCar.bestLap), lap };
    const plannedPlayer = playerControlledCars(session).filter(c => {
      const target = replacementCompound(state, session, c);
      const weatherChange = weatherTyreChangeWorthwhile(rules, c.tyre, target, session.wetness);
      return c.repairPending || (c.stayOutUntilLap < lap && (c.stintIndex < c.plannedCompounds.length - 1 && c.tyreAge >= pitTriggerLap(c) || weatherChange));
    });
    const reasons: RaceDecisionWindow['reasons'] = [];
    if (plannedPlayer.length) reasons.push('pit_opportunity');
    const weatherChanged = Math.abs(session.wetness - previousWetness) > .18 || session.surface !== previousSurface;
    if (weatherChanged && playerControlledCars(session).some(c => c.stayOutUntilLap < lap)) reasons.push('weather_change');
    if (incidentIds.length) reasons.push('incident');
    if (session.scLeft > 0 && !scActive) reasons.push('sc');
    if (session.vscLeft > 0 && !vscActive) reasons.push('vsc');
    if (session.redFlag?.active) reasons.push('red_flag');
    session.completedLaps = lap;
    // The control lap was consumed even if we pause at this checkpoint.
    // Count it down before creating a window so a save/restore cannot extend SC/VSC.
    if (scActive && --session.scLeft === 0) liveEvent(session, lap, 'sc_end', '安全车回站，比赛重新开始', [], true);
    else if (vscActive && --session.vscLeft === 0) liveEvent(session, lap, 'sc_end', 'VSC 结束', [], false);
    if (reasons.length && lap < session.totalLaps && playerControlledCars(session).length) {
      createWindow(session, reasons, session.redFlag?.active ? playerControlledCars(session).map(c => c.driverId) : plannedPlayer.map(c => c.driverId), incidentIds);
      break;
    }
    if (session.redFlag?.active) {
      for (const car of liveCars(session).filter(car => car.status === 'running')) {
        freeRedFlagTyreChange(state, session, car, replacementCompound(state, session, car));
        freeRedFlagWingRepair(session, car);
      }
      session.redFlag.active = false;
      session.redFlag.restartPending = true;
      liveEvent(session, lap, 'restart', `${session.redFlag.restart === 'standing' ? '静态' : '滚动'}重启程序开始`, [], true);
    }
    for (const car of liveCars(session)) executePit(state, session, car, rng);
    if (until === 'next_lap') break;
  }
  session.rngState = rng.state; session.forecastRngState = forecastRng.state;
  if (session.completedLaps >= session.totalLaps && !session.pendingDecision) session.stage = 'finished';
}

/** Applies a validated window decision. Driver-behavior rolls use a separate deterministic stream. */
export function applyRaceDecision(state: GameState, session: LiveRaceState, windowId: string, drivers: Array<{ driverId: string; pit: 'auto' | 'stay_out' | 'box'; compound?: Compound; repairWing?: boolean; paceMode?: EnergyMode | 'conserve' | 'balanced' | 'push'; energyMode?: EnergyMode; pitTiming?: 'early' | 'standard' | 'late' }>, orders?: import('./types').TeamOrders): boolean {
  const window = session.pendingDecision;
  if (!window || window.id !== windowId) return false;
  const playerIds = playerCars(session).map(c => c.driverId);
  const eligible = new Set(window.eligibleDriverIds);
  const seen = new Set<string>();
  for (const choice of drivers) {
    const car = session.cars[choice.driverId];
    if (!car || !car.player || car.status !== 'running' || !eligible.has(choice.driverId) || seen.has(choice.driverId) || !validRaceChoice(choice, state.rules.tyres)) return false;
    // A tyre is meaningful only for a valid box instruction; avoid cosmetic
    // immediate compound swaps from UI drafts or malformed controller calls.
    if ((choice.pit === 'box') !== (choice.compound !== undefined)) return false;
    seen.add(choice.driverId);
  }
  if (!validOrders(orders, playerIds)) return false;
  const relationship = teammateRelationship(state, state.meta.playerTeamId);
  const ignored = new Set<string>();
  for (const choice of drivers) {
    const driver = state.drivers[choice.driverId];
    const car = session.cars[choice.driverId];
    const isInstruction = choice.pit !== 'auto' || !!choice.repairWing || (choice.paceMode !== undefined && choice.paceMode !== car.plan.paceMode) || (choice.energyMode !== undefined && choice.energyMode !== car.energyMode) || (choice.pitTiming !== undefined && choice.pitTiming !== car.plan.pitTiming);
    if (!window.reasons.includes('red_flag') && driver && isInstruction && willDisobeyStrategy(driver, relationship, `${session.id}:${window.id}:${driver.id}`)) ignored.add(choice.driverId);
  }
  for (const choice of drivers) {
    const car = session.cars[choice.driverId];
    if (ignored.has(choice.driverId)) {
      car.pendingPit = 'auto';
      car.pendingCompound = null;
      liveEvent(session, session.lap, 'order', `${car.driverId} 拒绝临场策略指令，继续按自己的判断比赛`, [car.driverId], true);
      continue;
    }
    car.pendingPit = choice.pit;
    if (choice.pit === 'stay_out') {
      const firstAcknowledgement = car.stayOutUntilLap < session.lap;
      car.stayOutUntilLap = session.lap + 3;
      if (firstAcknowledgement) liveEvent(session, session.lap, 'info', `${car.driverId} 确认留在赛道上`, [car.driverId], true);
    } else car.stayOutUntilLap = 0;
    if (choice.pit === 'box' && choice.compound) {
      car.pendingCompound = choice.compound;
      if (!window.reasons.includes('red_flag')) car.plannedCompounds[car.stintIndex + 1] = choice.compound;
    }
    if (choice.repairWing && car.repairPending && !window.reasons.includes('red_flag')) car.pendingPit = 'box';
    if (choice.paceMode && ['conserve', 'balanced', 'push'].includes(choice.paceMode)) car.plan.paceMode = choice.paceMode as import('./types').PaceMode;
    if (choice.energyMode) car.energyMode = choice.energyMode;
    if (choice.pitTiming) car.plan.pitTiming = choice.pitTiming;
  }
  if (orders) session.teamOrders = { ...orders };
  session.pendingDecision = null;
  if (window.stage === 'grid') session.stage = 'ready';
  else if (window.reasons.includes('red_flag') && session.redFlag?.active) {
    for (const choice of drivers) {
      const car = session.cars[choice.driverId];
      if (choice.pit === 'box' && choice.compound) freeRedFlagTyreChange(state, session, car, choice.compound);
      if (choice.repairWing) freeRedFlagWingRepair(session, car);
    }
    const interactive = new Set(playerControlledCars(session).map(car => car.driverId));
    for (const car of liveCars(session).filter(car => car.status === 'running' && !interactive.has(car.driverId))) {
      freeRedFlagTyreChange(state, session, car, replacementCompound(state, session, car));
      freeRedFlagWingRepair(session, car);
    }
    session.redFlag.active = false;
    session.redFlag.restartPending = true;
    liveEvent(session, session.lap, 'restart', `${session.redFlag.restart === 'standing' ? '静态' : '滚动'}重启程序开始`, [], true);
    session.stage = 'ready';
  } else {
    const rng = Rng.restore(session.rngState);
    for (const car of liveCars(session)) executePit(state, session, car, rng);
    session.rngState = rng.state;
    session.stage = 'ready';
  }
  session.revision++;
  return true;
}

export function finishRaceSession(state: GameState, session: LiveRaceState): { result: RaceResult; extras: RaceExtras } | null {
  if (session.stage !== 'finished') return null;
  const running = liveCars(session).filter(c => c.status === 'running');
  if (session.kind === 'race' && session.weatherHistory.every(v => v < .25)) {
    for (const car of running) if (new Set(car.usedCompounds.filter(c => !state.rules.tyres[c]?.wet)).size < state.rules.mandatoryCompounds) car.cumulativeTime += 10;
  }
  const ordered = [...running].sort((a, b) => a.cumulativeTime - b.cumulativeTime);
  const dnfs = liveCars(session).filter(c => c.status === 'dnf').sort((a, b) => b.completedLaps - a.completedLaps);
  const points = session.kind === 'sprint' ? state.rules.pointsSprint : state.rules.pointsRace;
  const leader = ordered[0];
  const classification: ClassificationEntry[] = [...ordered, ...dnfs].map((car, index) => {
    const finished = car.status === 'running';
    const gap = finished ? car.cumulativeTime - (leader?.cumulativeTime ?? car.cumulativeTime) : 0;
    return { driverId: car.driverId, teamId: car.teamId, pos: finished ? index + 1 : null, grid: car.grid, status: finished ? 'finished' : 'dnf', laps: finished ? session.totalLaps : car.completedLaps, time: round3(car.cumulativeTime), gap: finished ? (index === 0 ? '冠军' : gapText(gap)) : 'DNF', pits: car.pits, bestLap: car.bestLap === null ? 0 : round3(car.bestLap), points: finished ? points[index] ?? 0 : 0, reason: car.reason, tyres: car.usedCompounds, pitStops: car.pitStops ?? [] };
  });
  if (session.fastestLap && session.kind === 'race' && state.rules.fastestLapPoint > 0) { const e = classification.find(c => c.driverId === session.fastestLap!.driverId); if (e?.pos && e.pos <= state.rules.fastestLapTopN) e.points += state.rules.fastestLapPoint; }
  const wetLaps = session.weatherHistory.filter(v => v > .25).length;
  const summary = wetLaps === 0 ? 'dry' : wetLaps === session.weatherHistory.length ? 'wet' : 'mixed';
  if (leader && !session.events.some(event => event.type === 'finish')) liveEvent(session, session.totalLaps, 'finish', `${leader.driverId} 赢得${session.kind === 'sprint' ? '冲刺赛' : '正赛'}！`, [leader.driverId], true);
  return { result: { kind: session.kind, weather: wetLaps ? 'wet' : 'dry', weatherSummary: summary, laps: session.totalLaps, classification, events: session.events.map(({ id: _id, ...event }) => event), fastestLap: session.fastestLap, lapChart: session.lapChart, safetyCars: session.safetyCars, redFlags: session.redFlags, orderOutcomes: session.orderOutcomes }, extras: { crashes: session.damageLedger.filter(d => d.affectedPartTypes.length > 0).map(d => ({ teamId: d.teamId, slot: d.slot, driverId: d.driverId, dnf: d.severity === 'dnf' })) } };
}

/** Backward-compatible automatic path: it drives exactly the same resumable simulation. */
export function simulateRace(state: GameState, rng: Rng, kind: 'race' | 'sprint'): { result: RaceResult; extras: RaceExtras } {
  const session = createRaceSession(state, rng, kind);
  while (session.stage !== 'finished') {
    if (session.pendingDecision) {
      applyRaceDecision(state, session, session.pendingDecision.id, session.pendingDecision.eligibleDriverIds.map(driverId => ({ driverId, pit: 'auto' as const })));
    } else advanceRaceSession(state, session, 'next_decision');
  }
  return finishRaceSession(state, session)!;
}
