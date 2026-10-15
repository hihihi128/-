import type { Compound, GameState, TeamState, TyreSet } from './types';

const STANDARD_DRY_ALLOCATION = [8, 3, 2];
const SPRINT_DRY_ALLOCATION = [6, 4, 2];

export function weekendTyreKey(state: GameState, roundIndex = state.season.roundIndex): string {
  return `${state.season.year}:r${roundIndex + 1}`;
}

function setId(teamId: string, driverId: string, key: string, compound: Compound, serial: number): string {
  return `tyre-${teamId}-${driverId}-${key}-${compound}-${serial}`;
}

function setsPerCompound(state: GameState, compound: string): number {
  const tyre = state.rules.tyres[compound];
  if (compound === state.rules.wetCompound) return 4;
  if (compound === state.rules.fullWetCompound) return 3;
  if (tyre.wet) return 3;
  const index = state.rules.dryCompounds.indexOf(compound);
  const allocation = state.calendar[state.season.roundIndex]?.sprint ? SPRINT_DRY_ALLOCATION : STANDARD_DRY_ALLOCATION;
  return allocation[index] ?? 2;
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
      inventory.push({ id: setId(team.id, driverId, key, compound, serial), compound, state: 'new', laps: 0, wearAge: 0, returned: false, weekendKey: key });
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

/** Check whether the remaining physical inventory can supply every planned stint. */
export function canRunTyreStrategy(team: TeamState, driverId: string, key: string, compounds: Compound[]): boolean {
  const available = driverTyreSets(team, driverId, key).filter(set => !set.returned);
  let fittedSetId: string | undefined;
  for (const compound of compounds) {
    const next = available
      .filter(set => set.compound === compound && set.id !== fittedSetId)
      .sort((a, b) => Number(a.state === 'used') - Number(b.state === 'used') || a.laps - b.laps || a.id.localeCompare(b.id))[0];
    if (!next) return false;
    fittedSetId = next.id;
  }
  return true;
}

/** Keep race reserves, plus the two new mediums required for SQ1 and SQ2. */
export function returnEligibleTyreSets(state: GameState, team: TeamState, driverId: string): TyreSet[] {
  const dry = new Set(state.rules.dryCompounds);
  const available = ensureDriverWeekendTyres(state, team, driverId).filter(set => !set.returned && dry.has(set.compound));
  const protectedIds = new Set<string>();
  for (const compound of state.rules.dryCompounds) {
    const reserveCount = state.calendar[state.season.roundIndex]?.sprint && compound === state.rules.dryCompounds[1] ? 2 : 1;
    const reserves = available.filter(set => set.compound === compound)
      .sort((a, b) => Number(a.state === 'used') - Number(b.state === 'used') || a.laps - b.laps || a.id.localeCompare(b.id))
      .slice(0, reserveCount);
    for (const reserve of reserves) protectedIds.add(reserve.id);
  }
  return available.filter(set => !protectedIds.has(set.id));
}

/** Prefer unused rubber, then the least-used available set. */
export function takeTyreSet(team: TeamState, driverId: string, compound: Compound, key: string, excludeSetId?: string, newOnly = false): TyreSet | null {
  const candidates = driverTyreSets(team, driverId, key)
    .filter(set => set.compound === compound && !set.returned && set.id !== excludeSetId && (!newOnly || set.state === 'new'))
    .sort((a, b) => Number(a.state === 'used') - Number(b.state === 'used') || a.laps - b.laps || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

/** Resolve a specific usable physical set without changing its state. */
export function tyreSetById(team: TeamState, driverId: string, key: string, setId: string): TyreSet | null {
  return driverTyreSets(team, driverId, key).find(set => set.id === setId && !set.returned) ?? null;
}

export function useTyreSet(set: TyreSet | null | undefined, laps: number, wearIncrement = laps): void {
  if (!set) return;
  set.state = 'used';
  set.laps += Math.max(0, laps);
  set.wearAge = Math.max(0, (set.wearAge ?? Math.max(0, set.laps - laps)) + Math.max(0, wearIncrement));
}
