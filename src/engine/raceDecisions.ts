import type { Compound, EnergyMode, PaceMode, PitTiming, TeamOrders } from './types';

export const PACE_MODES: PaceMode[] = ['conserve', 'balanced', 'push'];
export const ENERGY_MODES: EnergyMode[] = ['harvest', 'balanced', 'deploy'];
export const PIT_TIMINGS: PitTiming[] = ['early', 'standard', 'late'];
export const PIT_CHOICES = ['auto', 'stay_out', 'box'] as const;

export function validCompound(compound: unknown, tyres: Record<string, unknown>): compound is Compound {
  return typeof compound === 'string' && !!tyres[compound];
}

export function validOrders(orders: TeamOrders | undefined, playerIds: readonly string[]): boolean {
  if (!orders) return true;
  if (!['free', 'hold', 'favor'].includes(orders.mode)) return false;
  return orders.mode !== 'favor' || (!!orders.favorDriverId && playerIds.includes(orders.favorDriverId));
}

export function validRaceChoice(choice: { pit: unknown; compound?: unknown; paceMode?: unknown; energyMode?: unknown; pitTiming?: unknown }, tyres: Record<string, unknown>): boolean {
  if (!PIT_CHOICES.includes(choice.pit as typeof PIT_CHOICES[number])) return false;
  if (choice.compound !== undefined && !validCompound(choice.compound, tyres)) return false;
  if (choice.paceMode !== undefined && !PACE_MODES.includes(choice.paceMode as PaceMode)) return false;
  if (choice.energyMode !== undefined && !ENERGY_MODES.includes(choice.energyMode as EnergyMode)) return false;
  return choice.pitTiming === undefined || PIT_TIMINGS.includes(choice.pitTiming as PitTiming);
}
