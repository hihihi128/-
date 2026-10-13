import type { Compound, GameState, TeamState, TyreSet } from './types';

const SETS_PER_DRY_COMPOUND = 6;
const SETS_PER_WET_COMPOUND = 4;

export function weekendTyreKey(state: GameState, roundIndex = state.season.roundIndex): string {
  return `${state.season.year}:r${roundIndex + 1}`;
}

function setId(teamId: string, driverId: string, key: string, compound: Compound, serial: number): string {
  return `tyre-${teamId}-${driverId}-${key}-${compound}-${serial}`;
}

function setsPerCompound(state: GameState, compound: string): number {
  const sessions = state.calendar[state.season.roundIndex]?.sprint ? 1 : 3;
  const base = state.rules.tyres[compound].wet ? SETS_PER_WET_COMPOUND : SETS_PER_DRY_COMPOUND;
  // A player may return every selected compound after each practice. Keep two
  // sets beyond that ceiling, so an otherwise valid configurable return rule
  // can never leave a driver unable to complete the request.
  return Math.max(base, Math.max(0, state.rules.practiceReturnSets) * sessions + 2);
}

/** Issue a driver's current-weekend allocation, dropping all stale seasons/rounds. */
export function ensureDriverWeekendTyres(state: GameState, team: TeamState, driverId: string): TyreSet[] {
  const key = weekendTyreKey(state);
  team.tyreInventory ??= {};
  const inventory: TyreSet[] = (team.tyreInventory[driverId] ??= []).filter(set => set.weekendKey === key);
  team.tyreInventory[driverId] = inventory;
  for (const compound of Object.keys(state.rules.tyres)) {
    const amount = setsPerCompound(state, compound);
    const existing = inventory.filter(set => set.compound === compound).length;
    for (let serial = existing + 1; serial <= amount; serial++) {
      inventory.push({ id: setId(team.id, driverId, key, compound, serial), compound, state: 'new', laps: 0, returned: false, weekendKey: key });
    }
  }
  return inventory;
}

/** Give every active race driver fresh, independent physical sets for a new weekend. */
export function provisionWeekendTyres(state: GameState): void {
  const key = weekendTyreKey(state);
  for (const team of Object.values(state.teams)) {
    team.tyreInventory ??= {};
    for (const [driverId, inventory] of Object.entries(team.tyreInventory)) {
      team.tyreInventory[driverId] = inventory.filter(set => set.weekendKey === key);
    }
    for (const car of team.cars) if (car.driverId) ensureDriverWeekendTyres(state, team, car.driverId);
  }
}

/** Synthesize a safe usable inventory for saves made before physical sets existed. */
export function migrateTyreInventory(state: GameState): void {
  // Before a weekend there is no issued allocation to reconstruct. The next
  // startWeekend call provisions it, avoiding a meaningless migration write to
  // brand-new/pre-race saves.
  if (!state.weekend) return;
  const key = weekendTyreKey(state, state.weekend.roundIndex);
  for (const team of Object.values(state.teams)) {
    team.tyreInventory ??= {};
    for (const [driverId, inventory] of Object.entries(team.tyreInventory)) {
      team.tyreInventory[driverId] = inventory.filter(set => {
        if (set.weekendKey) return true;
        const legacyRound = (set as TyreSet & { roundIndex?: number }).roundIndex;
        if (legacyRound !== undefined && legacyRound !== -1 && legacyRound !== state.weekend!.roundIndex) return false;
        set.weekendKey = key;
        return true;
      });
    }
    for (const car of team.cars) {
      if (!car.driverId) continue;
      ensureDriverWeekendTyres(state, team, car.driverId);
    }
  }
}

export function driverTyreSets(team: TeamState, driverId: string, key?: string): TyreSet[] {
  return (team.tyreInventory?.[driverId] ?? []).filter(set => key === undefined || set.weekendKey === key);
}

/** Keep one physical set of every compound available for the race. */
export function returnEligibleTyreSets(state: GameState, team: TeamState, driverId: string): TyreSet[] {
  const available = ensureDriverWeekendTyres(state, team, driverId).filter(set => !set.returned);
  const protectedIds = new Set<string>();
  for (const compound of Object.keys(state.rules.tyres)) {
    const reserve = available.filter(set => set.compound === compound).sort((a, b) => a.laps - b.laps || a.id.localeCompare(b.id))[0];
    if (reserve) protectedIds.add(reserve.id);
  }
  return available.filter(set => !protectedIds.has(set.id));
}

/** Prefer unused rubber, then the least-used available set. */
export function takeTyreSet(team: TeamState, driverId: string, compound: Compound, key: string, excludeSetId?: string): TyreSet | null {
  const candidates = driverTyreSets(team, driverId, key)
    .filter(set => set.compound === compound && !set.returned && set.id !== excludeSetId)
    .sort((a, b) => Number(a.state === 'used') - Number(b.state === 'used') || a.laps - b.laps || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

export function useTyreSet(set: TyreSet | null | undefined, laps: number): void {
  if (!set) return;
  set.state = 'used';
  set.laps += Math.max(0, laps);
}
