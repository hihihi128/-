/**
 * 能力评分：车手综合、赛车属性、赛道适配。
 */
import { CAR_ATTRS, TRACK_DEMANDS } from './defaults';
import type { CarAttr, CarState, DriverAttr, DriverState, GameState, PartSpec, Rules, TeamState, TrackDef } from './types';
import { clamp, round1 } from './util';

const OVERALL_WEIGHTS: Record<DriverAttr, number> = {
  pace: 0.28,
  racecraft: 0.2,
  consistency: 0.18,
  tyre: 0.14,
  wet: 0.06,
  feedback: 0.14,
};

type DriverLike = Pick<DriverState, 'attrs'> & Partial<Pick<DriverState, 'morale' | 'fitness' | 'form'>>;

/** 车手综合能力（不含心态） */
export function driverOverall(d: DriverLike): number {
  let s = 0;
  for (const [k, w] of Object.entries(OVERALL_WEIGHTS) as Array<[DriverAttr, number]>) s += d.attrs[k] * w;
  return round1(s);
}

/** 心态/状态/体能带来的临场修正（能力点） */
export function driverConditionMod(d: DriverLike): number {
  const morale = d.morale ?? 60;
  const form = d.form ?? 0;
  const fitness = d.fitness ?? 100;
  let mod = ((morale - 50) / 50) * 1.5 + form * 0.1;
  if (fitness < 70) mod -= (70 - fitness) * 0.06;
  return mod;
}

/** 排位能力（单圈） */
export function qualiSkill(d: DriverLike, wet: boolean): number {
  let base = d.attrs.pace * 0.75 + d.attrs.consistency * 0.25;
  if (wet) base = base * 0.5 + d.attrs.wet * 0.5;
  return base + driverConditionMod(d);
}

/** 正赛能力（长距离） */
export function raceSkill(d: DriverLike, wet: boolean): number {
  let base = d.attrs.pace * 0.4 + d.attrs.racecraft * 0.25 + d.attrs.consistency * 0.2 + d.attrs.tyre * 0.15;
  if (wet) base = base * 0.5 + d.attrs.wet * 0.5;
  return base + driverConditionMod(d);
}

export interface CarRatings {
  downforce: number;
  efficiency: number;
  power: number;
  mechanical: number;
  tyre: number;
  reliability: number;
  /** 通用综合（不针对具体赛道） */
  overall: number;
}

export function findSpec(team: TeamState, partType: string, specId: string): PartSpec | undefined {
  return team.parts[partType]?.specs.find(s => s.id === specId);
}

/** 车上某零件的规格；若数据异常则回退到该类型的第一个规格 */
export function fittedSpec(team: TeamState, car: CarState, partType: string): PartSpec | undefined {
  const id = car.fitted[partType];
  return (id ? findSpec(team, partType, id) : undefined) ?? team.parts[partType]?.specs[0];
}

/** 车队某类零件中性能最好的规格 */
export function bestSpec(team: TeamState, partType: string): PartSpec | undefined {
  const specs = team.parts[partType]?.specs ?? [];
  let best: PartSpec | undefined;
  for (const s of specs) if (!best || s.perf > best.perf) best = s;
  return best;
}

/**
 * 玩家（和 AI 叙事者）能看到的零件性能：未验证的新件按交付时的预估区间中值计算，
 * 不暴露研发时抽到的真实收益。
 */
export function disclosedPerf(spec: PartSpec): number {
  if (spec.verified || !spec.expected) return spec.perf;
  return round1((spec.expected[0] + spec.expected[1]) / 2);
}

/**
 * 赛车属性。
 * - `true`：用真实性能，只供模拟（练习、排位、正赛）使用。
 * - `disclosed`：未验证的新件用预估值，供界面、状态条、提示词和车手的主观感受使用。
 */
export type RatingBasis = 'true' | 'disclosed';

/** 车队某类零件中「玩家已知」的最好性能（未验证的新件按预估值），用于研发预览与收益计算 */
export function bestDisclosedPerf(team: TeamState, partType: string): number | undefined {
  const specs = team.parts[partType]?.specs ?? [];
  return specs.length ? Math.max(...specs.map(disclosedPerf)) : undefined;
}

export function carRatings(team: TeamState, car: CarState, rules: Rules, basis: RatingBasis = 'true'): CarRatings {
  const acc: Record<CarAttr, { s: number; w: number }> = {
    downforce: { s: 0, w: 0 },
    efficiency: { s: 0, w: 0 },
    power: { s: 0, w: 0 },
    mechanical: { s: 0, w: 0 },
    tyre: { s: 0, w: 0 },
  };
  let relSum = 0;
  let relW = 0;
  let relMin = 100;
  for (const [pt, def] of Object.entries(rules.parts)) {
    const spec = fittedSpec(team, car, pt);
    const perf = spec ? (basis === 'disclosed' ? disclosedPerf(spec) : spec.perf) : 50;
    const rel = spec?.rel ?? 70;
    for (const attr of CAR_ATTRS) {
      const w = def.weights[attr] ?? 0;
      if (w > 0) {
        acc[attr].s += perf * w;
        acc[attr].w += w;
      }
    }
    if (def.reliabilityWeight > 0) {
      relSum += rel * def.reliabilityWeight;
      relW += def.reliabilityWeight;
      relMin = Math.min(relMin, rel);
    }
  }
  const val = (a: CarAttr) => (acc[a].w > 0 ? acc[a].s / acc[a].w : 50);
  const r: CarRatings = {
    downforce: round1(val('downforce')),
    efficiency: round1(val('efficiency')),
    power: round1(val('power')),
    mechanical: round1(val('mechanical')),
    tyre: round1(val('tyre')),
    reliability: round1(relW > 0 ? (relSum / relW) * 0.7 + relMin * 0.3 : 80),
    overall: 0,
  };
  r.overall = round1(r.downforce * 0.3 + r.efficiency * 0.2 + r.power * 0.25 + r.mechanical * 0.25);
  return r;
}

/** 赛车在某赛道上的性能分（0~100） */
export function trackScore(r: CarRatings, track: TrackDef): number {
  let s = 0;
  for (const k of TRACK_DEMANDS) s += r[k] * track.weights[k];
  return s;
}

/** 两台车之间的性能差（正数 = a 更强），用于判断升级件分配是否不公 */
export function carGap(team: TeamState, a: CarState, b: CarState, rules: Rules): number {
  return carRatings(team, a, rules).overall - carRatings(team, b, rules).overall;
}

export function carOfDriver(team: TeamState, driverId: string): CarState | undefined {
  return team.cars.find(c => c.driverId === driverId);
}

/** 所有正在比赛的车手 [driver, team, car] */
export function activeEntries(state: GameState): Array<{ driver: DriverState; team: TeamState; car: CarState }> {
  const out: Array<{ driver: DriverState; team: TeamState; car: CarState }> = [];
  for (const tid of state.teamOrder) {
    const team = state.teams[tid];
    for (const car of team.cars) {
      if (!car.driverId) continue;
      const driver = state.drivers[car.driverId];
      if (driver) out.push({ driver, team, car });
    }
  }
  return out;
}

/** 按赛道性能给所有车队排名（取车队里最好的那台车） */
export function teamPaceRanking(
  state: GameState,
  track: TrackDef | null,
  basis: RatingBasis = 'true',
): Array<{ teamId: string; score: number }> {
  const list = state.teamOrder.map(tid => {
    const team = state.teams[tid];
    const scores = team.cars.map(c => {
      const r = carRatings(team, c, state.rules, basis);
      return track ? trackScore(r, track) : r.overall;
    });
    return { teamId: tid, score: round1(scores.length ? Math.max(...scores) : 0) };
  });
  return list.sort((a, b) => b.score - a.score);
}

export function moraleLabel(m: number): string {
  if (m >= 85) return '高昂';
  if (m >= 65) return '良好';
  if (m >= 45) return '一般';
  if (m >= 25) return '低落';
  return '崩溃';
}

export function clampAttr(v: number): number {
  return round1(clamp(v, 1, 100));
}
