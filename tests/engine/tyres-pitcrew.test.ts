import { describe, expect, it } from 'vitest';
import { migrateState } from '../../src/engine/migrate';
import { previewPitTraining } from '../../src/engine/development';
import { actualStationaryTime, adjustPitCrewTraining, predictedStationaryTime } from '../../src/engine/pitstop';
import { createRaceSession } from '../../src/engine/race';
import { Rng } from '../../src/engine/rng';
import { provisionWeekendTyres, takeTyreSet, weekendTyreKey } from '../../src/engine/tyres';
import type { TyreSet } from '../../src/engine/types';
import { advanceUntil, act, newTestGame, tryAct } from '../helpers';

describe('physical tyre sets and pit crew timing', () => {
  it('requires each player driver to return the configured number of sets after practice', () => {
    let state = advanceUntil(newTestGame(41), s => s.season.phase === 'practice');
    const allocatedDriver = state.teams[state.meta.playerTeamId].cars[0].driverId!;
    expect(state.teams[state.meta.playerTeamId].tyreInventory![allocatedDriver].some(set => set.compound === state.rules.wetCompound)).toBe(true);
    expect(state.teams[state.meta.playerTeamId].tyreInventory![allocatedDriver].some(set => set.compound === state.rules.fullWetCompound)).toBe(true);
    state = act(state, { type: 'RUN_PRACTICE' });
    const request = state.weekend!.practiceReturn!;
    expect(request.required).toBe(1);
    expect(request.driverIds).toHaveLength(2);
    const [firstDriver, secondDriver] = request.driverIds;
    const firstSet = state.teams[state.meta.playerTeamId].tyreInventory![firstDriver].find(set => !set.returned)!;
    expect(tryAct(state, { type: 'RETURN_PRACTICE_TYRES', driverId: firstDriver, setIds: [] }).ok).toBe(false);
    state = act(state, { type: 'RETURN_PRACTICE_TYRES', driverId: firstDriver, setIds: [firstSet.id] });
    expect(state.weekend!.practiceReturn!.driverIds).toEqual([secondDriver]);
    const secondSet = state.teams[state.meta.playerTeamId].tyreInventory![secondDriver].find(set => !set.returned)!;
    state = act(state, { type: 'RETURN_PRACTICE_TYRES', driverId: secondDriver, setIds: [secondSet.id] });
    expect(state.teams[state.meta.playerTeamId].tyreInventory![firstDriver].find(set => set.id === firstSet.id)?.returned).toBe(true);
    expect(state.season.phase).toBe('practice'); // normal weekends continue to FP2
  });

  it('migrates legacy saves to safe independent tyre inventories and crew focuses', () => {
    const state = advanceUntil(newTestGame(42), s => s.season.phase === 'practice');
    for (const team of Object.values(state.teams)) {
      delete team.tyreInventory;
      delete team.pitCrewTraining;
    }
    const migrated = migrateState(state);
    const player = migrated.teams[migrated.meta.playerTeamId];
    expect(player.tyreInventory?.c1.some(set => set.compound === 'soft' && !set.returned)).toBe(true);
    expect(player.pitCrewTraining).toEqual({ speed: player.staff.pitCrew.skill, consistency: player.staff.pitCrew.skill, error_control: player.staff.pitCrew.skill });
  });

  it('keys allocations by season and round, prunes the old weekend, and restores an active legacy weekend', () => {
    let state = advanceUntil(newTestGame(44), s => s.season.phase === 'practice');
    let team = state.teams[state.meta.playerTeamId];
    const driverId = team.cars[0].driverId!;
    const oldKey = weekendTyreKey(state);
    expect(team.tyreInventory![driverId].every(set => set.weekendKey === oldKey)).toBe(true);
    state = act(state, { type: 'RUN_PRACTICE' });
    team = state.teams[state.meta.playerTeamId];
    for (const inventory of Object.values(team.tyreInventory!)) for (const set of inventory) delete (set as Partial<typeof set>).weekendKey;
    const leaked = { ...team.tyreInventory![driverId][0], id: 'leaked-old-round' } as TyreSet & { roundIndex?: number };
    leaked.roundIndex = state.weekend!.roundIndex + 1;
    team.tyreInventory![driverId].push(leaked);
    migrateState(state);
    expect(team.tyreInventory![driverId].some(set => set.id === leaked.id)).toBe(false);
    expect(team.tyreInventory![driverId].every(set => set.weekendKey === oldKey)).toBe(true);
    expect(state.weekend!.practiceReturn!.eligibleSetIds[driverId].length).toBeGreaterThanOrEqual(state.weekend!.practiceReturn!.required);
    while (state.weekend!.practiceReturn) {
      const request = state.weekend!.practiceReturn;
      const returningDriver = request.driverIds[0];
      state = act(state, { type: 'RETURN_PRACTICE_TYRES', driverId: returningDriver, setIds: request.eligibleSetIds[returningDriver].slice(0, request.required) });
    }
    expect(state.weekend!.practiceSessions).toHaveLength(1);
    state.season.year += 1;
    provisionWeekendTyres(state);
    team = state.teams[state.meta.playerTeamId];
    const newKey = weekendTyreKey(state);
    expect(newKey).not.toBe(oldKey);
    expect(team.tyreInventory![driverId].every(set => set.weekendKey === newKey)).toBe(true);
  });

  it('always offers enough frozen, eligible return choices for a configured request', () => {
    let state = newTestGame(45);
    state.rules.practiceReturnSets = 8;
    state = advanceUntil(state, s => s.season.phase === 'practice');
    state = act(state, { type: 'RUN_PRACTICE' });
    const request = state.weekend!.practiceReturn!;
    for (const driverId of [...request.driverIds]) {
      expect(request.eligibleSetIds[driverId].length).toBeGreaterThanOrEqual(request.required);
      for (const compound of Object.keys(state.rules.tyres)) {
        expect(state.teams[state.meta.playerTeamId].tyreInventory![driverId].some(set => set.compound === compound && !request.eligibleSetIds[driverId].includes(set.id))).toBe(true);
      }
      state = act(state, { type: 'RETURN_PRACTICE_TYRES', driverId, setIds: request.eligibleSetIds[driverId].slice(0, request.required) });
    }
  });

  it('issues and wears the correct tyre allocation in round two', () => {
    let state = advanceUntil(newTestGame(48), s => s.season.roundIndex === 1 && s.season.phase === 'practice');
    const team = state.teams[state.meta.playerTeamId];
    const driverId = team.cars[0].driverId!;
    const key = weekendTyreKey(state);
    expect(team.tyreInventory![driverId].every(set => set.weekendKey === key)).toBe(true);
    state = act(state, { type: 'RUN_PRACTICE' });
    expect(state.teams[state.meta.playerTeamId].tyreInventory![driverId].some(set => set.weekendKey === key && set.laps > 0)).toBe(true);
  });

  it('uses one prediction/actual model and speed training improves the prediction', () => {
    const state = newTestGame(43);
    const team = state.teams[state.meta.playerTeamId];
    team.pitCrewTraining = { speed: 50, consistency: 70, error_control: 80 };
    const slowPrediction = predictedStationaryTime(team);
    team.pitCrewTraining.speed = 90;
    expect(predictedStationaryTime(team)).toBeLessThan(slowPrediction);
    const actual = actualStationaryTime(team, () => .5);
    expect(actual.predicted).toBe(predictedStationaryTime(team));
    expect(actual.actual).toBeGreaterThan(1.7);
  });

  it('uses current crew skill alongside focus training and previews each focus independently', () => {
    const state = newTestGame(46);
    const team = state.teams[state.meta.playerTeamId];
    team.pitCrewTraining = { speed: 60, consistency: 55, error_control: 45 };
    team.staff.pitCrew.skill = 50;
    const before = predictedStationaryTime(team);
    team.staff.pitCrew.skill = 90;
    adjustPitCrewTraining(team, 40);
    expect(predictedStationaryTime(team)).toBeLessThan(before);
    team.pitCrewTraining.speed = 100;
    expect(previewPitTraining(state, team.id, 'speed').ok).toBe(false);
    expect(previewPitTraining(state, team.id, 'consistency').ok).toBe(true);
  });

  it('carries used-set laps into race age and never offers the fitted set as its replacement', () => {
    const state = advanceUntil(newTestGame(47), s => s.season.phase === 'race');
    const team = state.teams[state.meta.playerTeamId];
    const driverId = team.cars[0].driverId!;
    const compound = state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0];
    state.weekend!.weather.race = 'dry';
    state.weekend!.forecast.race = 0;
    state.weekend!.forecast.raceRainWindow = null;
    state.weekend!.raceWeatherSeed = 1;
    state.tracks[state.calendar[state.season.roundIndex].trackId].rainChance = 0;
    const key = weekendTyreKey(state);
    const target = team.tyreInventory![driverId].find(set => set.compound === compound)!;
    for (const set of team.tyreInventory![driverId]) if (set.compound === compound && set.id !== target.id) set.returned = true;
    target.state = 'used'; target.laps = 9;
    const session = createRaceSession(state, new Rng(47), 'race');
    const car = session.cars[driverId];
    expect(car.tyreSetId).toBe(target.id);
    expect(car.tyreAge).toBe(9);
    expect(takeTyreSet(team, driverId, compound, key, target.id)).toBeNull();
  });
});
