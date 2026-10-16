import type { RaceForecast } from './types';
import type { Rng } from './rng';
import { clamp, round3 } from './util';

/** Generate a correlated hidden rain-intensity path (0 dry, 1 heavy). */
export function createWeatherTrajectory(totalLaps: number, startsWet: boolean, rainChance: number, rng: Rng): number[] {
  const path: number[] = [];
  let level = startsWet ? 0.62 : rng.chance(rainChance * 0.2) ? 0.25 : 0;
  let direction = 0;
  for (let lap = 0; lap < totalLaps; lap++) {
    // Persistent state: weather changes have inertia rather than independent coin flips.
    if (rng.chance(0.12 + rainChance * 0.12)) direction = rng.pick([-0.32, -0.16, 0, 0.16, 0.32]);
    level = clamp(level + direction + rng.normal(0, 0.055), 0, 1);
    if (level < 0.06) level = 0;
    path.push(round3(level));
  }
  return path;
}

/**
 * 赛前公开降雨窗口。它参考隐藏轨迹，但加入漏报、误报和到达时间误差，
 * 因此不会把真实天气轨迹直接暴露给玩家。
 */
export function createPreRaceRainWindow(
  trajectory: number[],
  rainChance: number,
  strategistSkill: number,
  rng: Rng,
): [number, number] | null {
  const actual = trajectory.findIndex(value => value > 0.16);
  const uncertainty = Math.max(2, Math.round(7 - strategistSkill / 20));
  const missesActual = actual >= 0 && rng.chance(Math.max(0.08, 0.28 - strategistSkill / 500));
  const falsePositive = actual < 0 && rng.chance(0.08 + rainChance * 0.45);
  if ((actual < 0 && !falsePositive) || missesActual) return null;
  const noisyCenter = actual >= 0
    ? actual + 1 + Math.round(rng.normal(0, uncertainty))
    : rng.int(1, Math.max(1, trajectory.length));
  const center = Math.max(1, Math.min(trajectory.length, noisyCenter));
  const halfWidth = Math.max(2, uncertainty);
  return [
    Math.max(1, Math.min(trajectory.length, center - halfWidth)),
    Math.max(1, Math.min(trajectory.length, center + halfWidth)),
  ];
}

export function nextWetness(previous: number, rain: number): number {
  // Rain accumulation, drainage, evaporation and racing line drying are intentionally gradual.
  return clamp(previous + rain * 0.23 - (rain > 0.08 ? 0.015 : 0.075), 0, 1);
}

export function surfaceFor(wetness: number, previous: 'dry' | 'damp' | 'wet'): 'dry' | 'damp' | 'wet' {
  if (previous === 'wet') return wetness < 0.48 ? (wetness < 0.22 ? 'dry' : 'damp') : 'wet';
  if (previous === 'dry') return wetness > 0.31 ? (wetness > 0.62 ? 'wet' : 'damp') : 'dry';
  return wetness > 0.62 ? 'wet' : wetness < 0.18 ? 'dry' : 'damp';
}

/** Noisy five-lap public forecast. It deliberately never exports exact future rain. */
export function createForecast(
  trajectory: number[],
  completedLaps: number,
  strategistSkill: number,
  rng: Rng,
  sourceIndex = completedLaps,
): RaceForecast {
  const fallback = trajectory.at(-1) ?? 0;
  const sample = Array.from({ length: 5 }, (_, offset) => trajectory[sourceIndex + offset] ?? fallback);
  const actualProbability = sample.length ? sample.filter(v => v > 0.16).length / sample.length : 0;
  const uncertainty = Math.max(0.09, 0.32 - strategistSkill / 500);
  const probability = clamp(actualProbability + rng.normal(0, uncertainty), 0, 1);
  const wetIndices = sample.map((v, i) => (v > 0.16 ? i + 1 : -1)).filter(i => i > 0);
  // Forecasts can both miss a shower and call one that never arrives. The latter
  // is useful uncertainty, not access to the hidden trajectory.
  const missesActual = wetIndices.length > 0 && rng.chance(uncertainty * .55);
  const falsePositive = wetIndices.length === 0 && rng.chance(uncertainty * .4);
  const noisyArrival = !missesActual && wetIndices.length
    ? Math.max(1, Math.min(5, wetIndices[0] + Math.round(rng.normal(0, 1.2))))
    : falsePositive ? rng.int(1, 5) : null;
  const low = clamp((sample.length ? Math.min(...sample) : 0) + rng.normal(0, uncertainty / 2), 0, 1);
  const high = clamp((sample.length ? Math.max(...sample) : 0) + rng.normal(0, uncertainty / 2), low, 1);
  return {
    issuedLap: completedLaps,
    horizonLaps: 5,
    rainProbability: round3(probability),
    intensityRange: [round3(low), round3(high)],
    arrivalLaps: noisyArrival === null ? null : [Math.max(1, noisyArrival - 1), Math.min(5, noisyArrival + 1)],
    confidence: round3(clamp(0.45 + strategistSkill / 200, 0.45, 0.9)),
  };
}
