import type { PitCrewFocus, TeamState } from './types';
import { clamp, round1 } from './util';

function focus(team: TeamState, key: PitCrewFocus): number {
  return clamp(team.pitCrewTraining?.[key] ?? team.staff.pitCrew.skill, 1, 100);
}

/** Public estimate used before a stop; randomness is deliberately excluded. */
export function predictedStationaryTime(team: TeamState, repair = false): number {
  const base = 2.2 + (100 - focus(team, 'speed')) / 100 * 1.3;
  return round1(base + (repair ? 6 : 0));
}

/** Shared stop model for live and automatic races. */
export function actualStationaryTime(team: TeamState, random: () => number, repair = false): { predicted: number; actual: number; slow: boolean } {
  const predicted = predictedStationaryTime(team, repair);
  const consistency = focus(team, 'consistency');
  const errorControl = focus(team, 'error_control');
  const variation = (random() - .5) * (0.25 + (100 - consistency) / 100 * .75);
  const slow = random() < ((100 - errorControl) / 100) * .12;
  const errorLoss = slow ? 2 + random() * 4 : 0;
  return { predicted, actual: round1(Math.max(1.8, predicted + variation + errorLoss)), slow };
}
