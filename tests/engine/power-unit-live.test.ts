import { describe, expect, it } from 'vitest';
import { act, advanceUntil, newTestGame } from '../helpers';

function raceReady(seed = 31415) {
  return advanceUntil(newTestGame(seed), state => state.season.phase === 'race');
}

describe('2026 live power unit model', () => {
  it('tracks heat, ICE health and electrical health during deployment', () => {
    let state = act(raceReady(), { type: 'START_RACE', kind: 'race' });
    let live = state.weekend!.liveRace!;
    const playerCars = Object.values(live.cars).filter(car => car.player);
    const target = playerCars[0];
    const initialIce = target.iceHealth!;
    const initialElectrical = target.electricalHealth!;
    state = act(state, {
      type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision!.id,
      drivers: playerCars.map(car => ({ driverId: car.driverId, pit: 'auto' as const, paceMode: 'push' as const, energyMode: 'deploy' as const })),
    });
    live = state.weekend!.liveRace!;
    state = act(state, { type: 'ADVANCE_RACE', sessionId: live.id, expectedRevision: live.revision, until: 'next_lap' });
    live = state.weekend!.liveRace!;
    expect(live.cars[target.driverId].puTemperature).toBeGreaterThan(78);
    expect(live.cars[target.driverId].iceHealth).toBeLessThan(initialIce);
    expect(live.cars[target.driverId].electricalHealth).toBeLessThan(initialElectrical);
    expect(live.cars[target.driverId].electricalHealth).toBeLessThan(live.cars[target.driverId].iceHealth!);
    const health = live.cars[target.driverId].puComponentHealth!;
    expect(Object.keys(health).sort()).toEqual(['control_electronics', 'energy_store', 'exhaust', 'ice', 'mgu_k', 'turbocharger']);
    expect(health.exhaust).toBeGreaterThan(health.ice!);
    expect(health.control_electronics).toBeGreaterThan(health.mgu_k!);
  });

  it('enters protection mode when the electrical system overheats', () => {
    let state = act(raceReady(2718), { type: 'START_RACE', kind: 'race' });
    const live = state.weekend!.liveRace!;
    const playerCars = Object.values(live.cars).filter(car => car.player);
    for (const car of playerCars) car.puTemperature = 108;
    state = act(state, {
      type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision!.id,
      drivers: playerCars.map(car => ({ driverId: car.driverId, pit: 'auto' as const, energyMode: 'deploy' as const })),
    });
    const ready = state.weekend!.liveRace!;
    state = act(state, { type: 'ADVANCE_RACE', sessionId: ready.id, expectedRevision: ready.revision, until: 'next_lap' });
    const resumed = state.weekend!.liveRace!;
    expect(resumed.cars[playerCars[0].driverId].puStatus).toMatch(/protect|critical/);
    expect(resumed.events.some(event => event.text.includes('动力单元温度过高'))).toBe(true);
  });
});
