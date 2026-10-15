import { describe, expect, it } from 'vitest';
import { migrateState } from '../../src/engine/migrate';
import { previewPitTraining } from '../../src/engine/development';
import { actualStationaryTime, adjustPitCrewTraining, predictedStationaryTime } from '../../src/engine/pitstop';
import { createRaceSession } from '../../src/engine/race';
import { Rng } from '../../src/engine/rng';
import { canRunTyreStrategy, provisionWeekendTyres, takeTyreSet, weekendTyreKey } from '../../src/engine/tyres';
import { createWeekend } from '../../src/engine/weekend';
import type { TyreSet } from '../../src/engine/types';
import { advanceUntil, act, newTestGame, tryAct } from '../helpers';

describe('physical tyre sets and pit crew timing', () => {
  it('provisions the real 2026 standard-weekend 2-3-8 dry allocation and 4-3 wet allocation', () => {
    const state = newTestGame(12);
    state.weekend = createWeekend(state, new Rng(12));
    const inventory = state.teams[state.meta.playerTeamId].tyreInventory!.c1;
    const count = (compound: string) => inventory.filter(set => set.compound === compound).length;
    expect(count('soft')).toBe(8);
    expect(count('medium')).toBe(3);
    expect(count('hard')).toBe(2);
    expect(count('inter')).toBe(4);
    expect(count('wet')).toBe(3);
  });
  it('requires each player driver to return the configured number of sets after practice', () => {
    let state = advanceUntil(newTestGame(41), s => s.season.phase === 'practice');
    const allocatedDriver = state.teams[state.meta.playerTeamId].cars[0].driverId!;
    expect(state.teams[state.meta.playerTeamId].tyreInventory![allocatedDriver].some(set => set.compound === state.rules.wetCompound)).toBe(true);
    expect(state.teams[state.meta.playerTeamId].tyreInventory![allocatedDriver].some(set => set.compound === state.rules.fullWetCompound)).toBe(true);
    state = act(state, { type: 'RUN_PRACTICE' });
    const request = state.weekend!.practiceReturn!;
    expect(request.required).toBe(2);
    expect(request.driverIds).toHaveLength(2);
    const [firstDriver, secondDriver] = request.driverIds;
    const firstSets = request.eligibleSetIds[firstDriver].slice(0, request.required);
    expect(tryAct(state, { type: 'RETURN_PRACTICE_TYRES', driverId: firstDriver, setIds: [] }).ok).toBe(false);
    state = act(state, { type: 'RETURN_PRACTICE_TYRES', driverId: firstDriver, setIds: firstSets });
    expect(state.weekend!.practiceReturn!.driverIds).toEqual([secondDriver]);
    const secondSets = request.eligibleSetIds[secondDriver].slice(0, request.required);
    state = act(state, { type: 'RETURN_PRACTICE_TYRES', driverId: secondDriver, setIds: secondSets });
    expect(firstSets.every(id => state.teams[state.meta.playerTeamId].tyreInventory![firstDriver].find(set => set.id === id)?.returned)).toBe(true);
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

  it('protects two new medium sets for sprint qualifying', () => {
    let state = newTestGame(46);
    state.season.roundIndex = state.calendar.findIndex(round => round.sprint);
    state.weekend = createWeekend(state, new Rng(46));
    state.season.phase = 'practice';
    const team = state.teams[state.meta.playerTeamId];
    const driverId = team.cars[0].driverId!;
    state.weekend.plans[driverId].practiceTyre = 'medium';
    state.weekend.weather.practice = 'dry';
    state = act(state, { type: 'RUN_PRACTICE' });
    const request = state.weekend!.practiceReturn!;
    const eligibleMediums = team.tyreInventory![driverId].filter(set => set.compound === 'medium' && request.eligibleSetIds[driverId].includes(set.id));
    expect(eligibleMediums).toHaveLength(2);
    const protectedNewMediums = team.tyreInventory![driverId].filter(set => set.compound === 'medium' && set.state === 'new' && !request.eligibleSetIds[driverId].includes(set.id));
    expect(protectedNewMediums).toHaveLength(2);
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

  it('rejects strategies that require returned or unavailable physical sets', () => {
    const state = advanceUntil(newTestGame(49), s => s.season.phase === 'race');
    const team = state.teams[state.meta.playerTeamId];
    const driverId = team.cars[0].driverId!;
    const key = weekendTyreKey(state);
    const [soft, medium] = state.rules.dryCompounds;
    expect(canRunTyreStrategy(team, driverId, key, [soft, medium])).toBe(true);
    const softs = team.tyreInventory![driverId].filter(set => set.compound === soft && !set.returned);
    for (const set of softs.slice(1)) set.returned = true;
    expect(canRunTyreStrategy(team, driverId, key, [soft, medium, soft])).toBe(true);
    expect(canRunTyreStrategy(team, driverId, key, [soft, soft])).toBe(false);
    const mediums = team.tyreInventory![driverId].filter(set => set.compound === medium && !set.returned);
    for (const set of mediums.slice(2)) set.returned = true;
    expect(canRunTyreStrategy(team, driverId, key, [medium, medium, medium])).toBe(true);
    softs[0].returned = true;
    expect(canRunTyreStrategy(team, driverId, key, [soft, medium])).toBe(false);
    expect(canRunTyreStrategy(team, driverId, key, [medium, medium])).toBe(true);
    mediums[1].returned = true;
    expect(canRunTyreStrategy(team, driverId, key, [medium, medium])).toBe(false);
  });
});
