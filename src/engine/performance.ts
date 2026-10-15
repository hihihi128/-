/** Shared, deterministic performance model used by qualifying, race and strategy. */
import type { CarRatings } from './ratings';
import type { PaceMode, RacePerformanceContext, Rules, SetupState, TrackDef, TyreDef } from './types';
import { clamp, round1, round3 } from './util';

const paceHeat: Record<PaceMode, number> = { conserve: -5, balanced: 0, push: 7 };

function finite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

export function trackFit(ratings: Pick<CarRatings, 'downforce' | 'efficiency' | 'power' | 'mechanical'> & { tyre?: number }, track: TrackDef): number {
  const attrs = ['downforce', 'efficiency', 'power', 'mechanical'] as const;
  const weighted = attrs.reduce((sum, attr) => sum + ratings[attr] * track.weights[attr], 0);
  const average = attrs.reduce((sum, attr) => sum + ratings[attr], 0) / attrs.length;
  return round1(clamp(50 + (weighted - average) * 2.5, 0, 100));
}

export function practiceEffects(setup: SetupState, rules: Rules, fit = 50): { quali: number; race: number; wearMultiplier: number } {
  const confidence = clamp(finite(setup.confidence, 0), 0, 100) / 100;
  const knowledge = clamp(finite(setup.tyreKnowledge, 0), 0, 100) / 100;
  const trackKnowledge = clamp(finite(setup.trackKnowledge, 0), 0, 100) / 100;
  const fitAdjustment = ((fit - 50) / 50) * rules.performance.trackFitMax;
  // Knowledge compensates only a poor car/track match; it must not dilute a good fit.
  const adaptation = 1 + (fitAdjustment < 0 ? fitAdjustment * (1 - trackKnowledge * .5) : fitAdjustment);
  return {
    quali: round3(Math.min(rules.performance.qualiSetupMax, rules.performance.qualiSetupMax * confidence * adaptation) + clamp(finite(setup.qualiBonus, 0), 0, rules.performance.qualiBonusMax)),
    race: round3(Math.min(rules.performance.raceSetupMax, rules.performance.raceSetupMax * confidence * adaptation)),
    wearMultiplier: round3(1 - rules.performance.practiceWearKnowledgeMax * knowledge),
  };
}

export function buildPerformanceContext(input: {
  driverTyre: number;
  carTyre: number;
  setup: SetupState;
  ratings: CarRatings;
  track: TrackDef;
}): RacePerformanceContext {
  return {
    driverTyre: clamp(finite(input.driverTyre, 50), 0, 100),
    carTyre: clamp(finite(input.carTyre, 50), 0, 100),
    setup: { ...input.setup, confidence: clamp(finite(input.setup.confidence, 0), 0, 100), tyreKnowledge: clamp(finite(input.setup.tyreKnowledge, 0), 0, 100), thermalKnowledge: clamp(finite(input.setup.thermalKnowledge, 0), 0, 100), trackKnowledge: clamp(finite(input.setup.trackKnowledge, 0), 0, 100), qualiBonus: clamp(finite(input.setup.qualiBonus, 0), 0, .2) },
    trackFit: trackFit(input.ratings, input.track),
    trackScore: input.ratings.overall,
    surfaceTemperature: clamp(finite(input.track.surfaceTemperature, 32), 10, 65),
    thermalDemand: clamp(finite(input.track.thermalDemand, input.track.tyreStress), 0, 100),
    tyreStress: clamp(finite(input.track.tyreStress, 50), 0, 100),
  };
}

export interface TyreStepConditions {
  paceMode: PaceMode;
  wetness?: number;
  neutral?: boolean;
}

export interface TyreStepResult {
  temperature: number;
  wearAge: number;
  wearMultiplier: number;
  state: 'cold' | 'optimal' | 'hot';
  lapPenalty: number;
}

export function stepTyre(
  context: RacePerformanceContext,
  tyre: TyreDef,
  previous: { temperature?: number; wearAge?: number },
  conditions: TyreStepConditions,
  rules: Rules,
): TyreStepResult {
  const [low, high] = tyre.temperatureWindow ?? (tyre.wet ? [58, 78] : [80, 105]);
  const temperature = clamp(finite(previous.temperature, low - 18), 20, 160);
  const wetness = clamp(finite(conditions.wetness, 0), 0, 1);
  const thermalKnowledge = clamp(finite(context.setup.thermalKnowledge, 0), 0, 100) / 100;
  const target = clamp(context.surfaceTemperature + 43 + context.thermalDemand * .22 + paceHeat[conditions.paceMode] - wetness * 24 - (conditions.neutral ? 20 : 0) - thermalKnowledge * 3, 35, 135);
  const rate = clamp(finite(tyre.warmupRate, tyre.wet ? .4 : .32) * (1 + thermalKnowledge * .18), .05, 1);
  const next = clamp(temperature + rate * (target - temperature), 20, 160);
  const state = next < low ? 'cold' : next > high ? 'hot' : 'optimal';
  const distance = state === 'cold' ? low - next : state === 'hot' ? next - high : 0;
  const penalty = round3(Math.min(rules.performance.temperatureLapMax, distance * (state === 'hot' ? .045 : .035)));
  const overheat = state === 'hot' ? Math.min(rules.performance.overheatWearMax, distance / 50) : 0;
  const fitPenalty = Math.max(0, 50 - context.trackFit) / 50 * rules.performance.trackFitMax;
  const driverWear = 1.15 - context.driverTyre / 100 * .3;
  const carWear = 1.15 - context.carTyre / 100 * .3;
  const paceWear = conditions.paceMode === 'push' ? 1.25 : conditions.paceMode === 'conserve' ? .82 : 1;
  const trackWear = .6 + context.tyreStress / 100 * .8;
  const wearMultiplier = round3(trackWear * (1 + overheat + fitPenalty) * practiceEffects(context.setup, rules, context.trackFit).wearMultiplier * driverWear * carWear * paceWear);
  return { temperature: round1(next), wearAge: round3(Math.max(0, finite(previous.wearAge, 0)) + wearMultiplier), wearMultiplier, state, lapPenalty: penalty };
}
