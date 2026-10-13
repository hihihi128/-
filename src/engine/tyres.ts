import type { Compound, GameState, TeamState, TyreSet } from './types';

const SETS_PER_DRY_COMPOUND = 6;
const SETS_PER_WET_COMPOUND = 4;

function setId(teamId: string, driverId: string, roundIndex: number, compound: Compound, serial: number): string {
  return `tyre-${teamId}-${driverId}-r${roundIndex + 1}-${compound}-${serial}`;
}

/** Give every race driver fresh, independent physical sets for a new weekend. */
export function provisionWeekendTyres(state: GameState, roundIndex: number): void {
  for (const team of Object.values(state.teams)) {
    team.tyreInventory ??= {};
    for (const car of team.cars) {
      if (!car.driverId) continue;
      const inventory: TyreSet[] = team.tyreInventory[car.driverId] ??= [];
      if (inventory.some(set => set.roundIndex === roundIndex)) continue;
      for (const compound of Object.keys(state.rules.tyres)) {
        const amount = state.rules.tyres[compound].wet ? SETS_PER_WET_COMPOUND : SETS_PER_DRY_COMPOUND;
        for (let serial = 1; serial <= amount; serial++) {
          inventory.push({ id: setId(team.id, car.driverId, roundIndex, compound, serial), compound, state: 'new', laps: 0, returned: false, roundIndex });
        }
      }
    }
  }
}

/** Synthesize a safe usable inventory for saves made before physical sets existed. */
export function migrateTyreInventory(state: GameState): void {
  // Before a weekend there is no issued allocation to reconstruct. The next
  // startWeekend call provisions it, avoiding a meaningless migration write to
  // brand-new/pre-race saves.
  if (!state.weekend) return;
  for (const team of Object.values(state.teams)) {
    team.tyreInventory ??= {};
    for (const car of team.cars) {
      if (!car.driverId || team.tyreInventory[car.driverId]?.length) continue;
      const inventory: TyreSet[] = team.tyreInventory[car.driverId] = [];
      for (const compound of Object.keys(state.rules.tyres)) {
        const amount = state.rules.tyres[compound].wet ? SETS_PER_WET_COMPOUND : SETS_PER_DRY_COMPOUND;
        for (let serial = 1; serial <= amount; serial++) {
          inventory.push({ id: `tyre-${team.id}-${car.driverId}-legacy-${compound}-${serial}`, compound, state: 'new', laps: 0, returned: false, roundIndex: -1 });
        }
      }
    }
  }
}

export function driverTyreSets(team: TeamState, driverId: string, roundIndex?: number): TyreSet[] {
  return (team.tyreInventory?.[driverId] ?? []).filter(set => roundIndex === undefined || set.roundIndex === roundIndex);
}

/** Prefer unused rubber, then the least-used available set. */
export function takeTyreSet(team: TeamState, driverId: string, compound: Compound, roundIndex: number): TyreSet | null {
  const candidates = driverTyreSets(team, driverId, roundIndex)
    .filter(set => set.compound === compound && !set.returned)
    .sort((a, b) => Number(a.state === 'used') - Number(b.state === 'used') || a.laps - b.laps || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

export function useTyreSet(set: TyreSet | null | undefined, laps: number): void {
  if (!set) return;
  set.state = 'used';
  set.laps += Math.max(0, laps);
}
