/**
 * 轮胎与进站策略：衰减模型、候选策略、自动选择。
 * 比赛模拟与策略预测共用同一套衰减公式，保证「预测」与「实际」口径一致。
 */
import { stepTyre } from './performance';
import type { Compound, PaceMode, RacePerformanceContext, Rules, TrackDef, TyreDef } from './types';
import { round1 } from './util';

export interface DegContext {
  driverTyre: number;
  carTyre: number;
  paceMode: PaceMode;
  /** 练习赛积累的轮胎数据 0~100 */
  knowledge: number;
  /** Frozen shared model input. Omit only for legacy callers. */
  performanceContext?: RacePerformanceContext;
}

export const PACE_MODE_DEG: Record<PaceMode, number> = { conserve: 0.82, balanced: 1, push: 1.25 };
/** 驾驶模式对圈速的影响（秒） */
export const PACE_MODE_TIME: Record<PaceMode, number> = { conserve: 0.28, balanced: 0, push: -0.18 };

export function degFactor(track: TrackDef, ctx: DegContext): number {
  const stress = 0.6 + (track.tyreStress / 100) * 0.8;
  const driver = 1.15 - (ctx.driverTyre / 100) * 0.3;
  const car = 1.15 - (ctx.carTyre / 100) * 0.3;
  const knowledge = 1 - (ctx.knowledge / 100) * 0.08;
  return stress * driver * car * PACE_MODE_DEG[ctx.paceMode] * knowledge;
}

export function effectiveCliff(tyre: TyreDef, factor: number): number {
  return tyre.cliff / Math.pow(Math.max(0.3, factor), 0.8);
}

/** Estimate usable laps with the same thermal/wear stepping as the live race. */
export function predictedTyreLife(tyre: TyreDef, factor: number, model?: { context?: RacePerformanceContext; rules: Rules; paceMode: PaceMode }): number {
  if (!model?.context) return effectiveCliff(tyre, factor);
  const cliff = effectiveCliff(tyre, 1);
  let previous: { temperature?: number; wearAge?: number } = { temperature: (tyre.temperatureWindow?.[0] ?? (tyre.wet ? 58 : 80)) - 18, wearAge: 0 };
  for (let lap = 1; lap <= 200; lap++) {
    previous = stepTyre(model.context, tyre, previous, { paceMode: model.paceMode }, model.rules);
    if ((previous.wearAge ?? 0) >= cliff) return lap;
  }
  return 200;
}

/** 胎龄为 age（第 age 圈）时相对新中性胎的圈速损失（秒），含配方本身快慢 */
export function tyreLapDelta(tyre: TyreDef, age: number, factor: number): number {
  const cliff = effectiveCliff(tyre, factor);
  const over = age > cliff ? (age - cliff) * (age - cliff) * 0.05 : 0;
  return tyre.pace + tyre.deg * age * factor + over;
}

/** 一段 laps 圈的轮胎总损失 */
export function stintLoss(tyre: TyreDef, laps: number, factor: number, model?: { context?: RacePerformanceContext; rules: Rules; paceMode: PaceMode }): number {
  let s = 0;
  let previous: { temperature?: number; wearAge?: number } = {};
  for (let a = 1; a <= laps; a++) {
    if (model?.context) {
      const step = stepTyre(model.context, tyre, previous, { paceMode: model.paceMode }, model.rules);
      previous = step;
      s += tyreLapDelta(tyre, step.wearAge, 1) + step.lapPenalty;
    } else s += tyreLapDelta(tyre, a, factor);
  }
  return s + PACE_MODE_TIME[model?.paceMode ?? 'balanced'] * laps;
}

export interface StrategyOption {
  id: string;
  label: string;
  compounds: Compound[];
  stints: number[];
  stops: number;
  /** 预测的轮胎+进站总耗时（秒，越小越好） */
  cost: number;
  /** 相对最优策略的差距（秒） */
  delta: number;
  summaries?: Array<{ startLap: number; endLap: number; endLoss: number; temperatureRange: [number, number]; outsideWindowLaps: number; cliffMargin: number }>;
}

interface StrategyModel {
  context?: RacePerformanceContext;
  paceMode: PaceMode;
  lossCache?: Map<string, number>;
}

const MIN_STINT = 3;

/** 给定配方序列，求最优分段圈数（比例分配 + 局部搜索） */
export function optimizeStints(rules: Rules, track: TrackDef, compounds: Compound[], totalLaps: number, factor: number, model?: StrategyModel): number[] {
  const n = compounds.length;
  if (n === 1) return [totalLaps];
  if (totalLaps < n * MIN_STINT) return compounds.map((_, i) => (i === 0 ? totalLaps - (n - 1) * 1 : 1));
  const lifes = compounds.map(c => effectiveCliff(rules.tyres[c], factor));
  const lifeSum = lifes.reduce((a, b) => a + b, 0);
  const stints = lifes.map(l => Math.max(MIN_STINT, Math.round((l / lifeSum) * totalLaps)));
  // 修正总圈数
  let diff = totalLaps - stints.reduce((a, b) => a + b, 0);
  let i = 0;
  while (diff !== 0 && i < 1000) {
    const k = i % n;
    if (diff > 0) {
      stints[k] += 1;
      diff -= 1;
    } else if (stints[k] > MIN_STINT) {
      stints[k] -= 1;
      diff += 1;
    }
    i++;
  }
  const lossCache = model?.lossCache ?? new Map<string, number>();
  const loss = (compound: Compound, laps: number) => {
    const key = `${compound}:${laps}`;
    const cached = lossCache.get(key);
    if (cached !== undefined) return cached;
  const value = stintLoss(rules.tyres[compound], laps, factor, { context: model?.context, paceMode: model?.paceMode ?? 'balanced', rules });
    lossCache.set(key, value);
    return value;
  };
  const cost = (s: number[]) => s.reduce((acc, laps, idx) => acc + loss(compounds[idx], laps), 0);
  let best = cost(stints);
  let improved = true;
  let guard = 0;
  while (improved && guard < 400) {
    improved = false;
    guard++;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (a === b || stints[a] <= MIN_STINT) continue;
        stints[a] -= 1;
        stints[b] += 1;
        const c = cost(stints);
        if (c < best - 1e-9) {
          best = c;
          improved = true;
        } else {
          stints[a] += 1;
          stints[b] -= 1;
        }
      }
    }
  }
  return stints;
}

function sequences(pool: Compound[], len: number): Compound[][] {
  if (len === 0) return [[]];
  const out: Compound[][] = [];
  for (const head of pool) for (const tail of sequences(pool, len - 1)) out.push([head, ...tail]);
  return out;
}

export function planLabel(rules: Rules, compounds: Compound[]): string {
  const stops = compounds.length - 1;
  const seq = compounds.map(c => rules.tyres[c]?.short ?? c).join('-');
  return stops === 0 ? `不进站（${seq}）` : `${stops} 停（${seq}）`;
}

/**
 * 生成候选策略。wet = 雨战；sprint = 冲刺赛（不强制进站）。
 * 返回按耗时排序的列表（每种进站次数最多保留 2 个）。
 */
export function strategyOptions(
  rules: Rules,
  track: TrackDef,
  laps: number,
  ctx: DegContext,
  opts: { wet: boolean; sprint: boolean; isAvailable?: (compounds: Compound[]) => boolean },
): StrategyOption[] {
  const factor = degFactor(track, ctx);
  const model: StrategyModel = { context: ctx.performanceContext, paceMode: ctx.paceMode, lossCache: new Map() };
  const pitCost = track.pitLoss + 2.6;
  const candidates: Array<{ compounds: Compound[]; stints: number[]; cost: number }> = [];
  const evaluate = (compounds: Compound[]) => {
    const stints = optimizeStints(rules, track, compounds, laps, factor, model);
    const loss = stints.reduce((acc, l, i) => {
      const key = `${compounds[i]}:${l}`;
      const cached = model?.lossCache?.get(key);
      if (cached !== undefined) return acc + cached;
      const value = stintLoss(rules.tyres[compounds[i]], l, factor, { context: model.context, paceMode: model.paceMode, rules });
      model?.lossCache?.set(key, value);
      return acc + value;
    }, 0);
    candidates.push({ compounds, stints, cost: loss + (compounds.length - 1) * pitCost });
  };
  if (opts.wet) {
    const w = rules.wetCompound;
    evaluate([w]);
    if (laps > 12) evaluate([w, w]);
  } else if (opts.sprint) {
    for (const c of rules.dryCompounds) evaluate([c]);
  } else {
    const maxStops = laps >= 40 ? 3 : laps >= 20 ? 2 : 1;
    for (let len = 2; len <= maxStops + 1; len++) {
      for (const seq of sequences(rules.dryCompounds, len)) {
        if (new Set(seq).size < rules.mandatoryCompounds) continue;
        evaluate(seq);
      }
    }
  }
  const availableCandidates = opts.isAvailable ? candidates.filter(candidate => opts.isAvailable!(candidate.compounds)) : candidates;
  availableCandidates.sort((a, b) => a.cost - b.cost);
  const bestCost = availableCandidates[0]?.cost ?? 0;
  const perStops = new Map<number, number>();
  const out: StrategyOption[] = [];
  for (const c of availableCandidates) {
    const stops = c.compounds.length - 1;
    const n = perStops.get(stops) ?? 0;
    if (n >= 2) continue;
    perStops.set(stops, n + 1);
    let nextLap = 1;
    const summaries = c.stints.map((stint, index) => {
      const tyre = rules.tyres[c.compounds[index]];
      const low = tyre.temperatureWindow?.[0] ?? (tyre.wet ? 58 : 80);
      let temperature = low - 18;
      let wearAge = 0;
      let min = temperature, max = temperature, outside = 0;
      for (let lap = 0; lap < stint; lap++) {
        if (model.context) {
          const step = stepTyre(model.context, tyre, { temperature, wearAge }, { paceMode: model.paceMode }, rules);
          temperature = step.temperature; wearAge = step.wearAge; if (step.state !== 'optimal') outside++;
        } else wearAge++;
        min = Math.min(min, temperature); max = Math.max(max, temperature);
      }
      const summary = { startLap: nextLap, endLap: nextLap + stint - 1, endLoss: round1(tyreLapDelta(tyre, wearAge || stint, model.context ? 1 : factor) + PACE_MODE_TIME[model.paceMode]), temperatureRange: [round1(min), round1(max)] as [number, number], outsideWindowLaps: outside, cliffMargin: round1(effectiveCliff(tyre, model.context ? 1 : factor) - wearAge) };
      nextLap += stint;
      return summary;
    });
    out.push({
      id: c.compounds.join('-'),
      label: planLabel(rules, c.compounds),
      compounds: c.compounds,
      stints: c.stints,
      stops,
      cost: round1(c.cost),
      delta: round1(c.cost - bestCost),
      summaries,
    });
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** 校验玩家输入的策略是否合法（干地需满足配方数量） */
export function validatePlan(rules: Rules, compounds: Compound[], wet: boolean): string | null {
  if (!compounds.length) return '策略至少需要一段';
  if (compounds.length > 5) return '最多 4 次进站';
  for (const c of compounds) if (!rules.tyres[c]) return `未知配方「${c}」`;
  if (!wet && new Set(compounds).size < rules.mandatoryCompounds) {
    return `干地正赛至少需要使用 ${rules.mandatoryCompounds} 种不同配方`;
  }
  return null;
}
