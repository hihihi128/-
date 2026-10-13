import type { StaffAbility, StaffMember, TeamState } from './types';
import { clamp } from './util';

/** Missing specialist ratings remain compatible with legacy scalar-skill data. */
export function staffAbility(staff: StaffMember, ability: StaffAbility): number {
  return clamp(staff.abilities?.[ability] ?? staff.skill, 1, 100);
}

/** Slot 1 uses the first engineer and slot 2 uses the second engineer. */
export function raceEngineerFor(team: Pick<TeamState, 'staff'>, slot: number): StaffMember {
  return slot === 2 ? (team.staff.raceEngineer2 ?? team.staff.raceEngineer) : team.staff.raceEngineer;
}

export function strategyDecisionSkill(team: Pick<TeamState, 'staff'>, slot: number): number {
  const engineer = raceEngineerFor(team, slot);
  return staffAbility(team.staff.strategist, 'strategy') * 0.6 + staffAbility(engineer, 'reaction') * 0.25 + staffAbility(engineer, 'communication') * 0.15;
}
