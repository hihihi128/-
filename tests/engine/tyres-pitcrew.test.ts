import { describe, expect, it } from 'vitest';
import { migrateState } from '../../src/engine/migrate';
import { actualStationaryTime, predictedStationaryTime } from '../../src/engine/pitstop';
import { advanceUntil, act, newTestGame, tryAct } from '../helpers';

describe('physical tyre sets and pit crew timing', () => {
  it('requires each player driver to return the configured number of sets after practice', () => {
    let state = advanceUntil(newTestGame(41), s => s.season.phase === 'practice');
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
});
