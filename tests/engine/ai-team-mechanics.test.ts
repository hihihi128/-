import { describe, expect, it } from 'vitest';
import { advanceWeeks } from '../../src/engine/development';
import { normalizeDatabase } from '../../src/engine/data';
import { ferrariAfterRace, ferrariMediaDelta } from '../../src/engine/ferrari';
import { migrateState } from '../../src/engine/migrate';
import { afterManagementRace } from '../../src/engine/managementSpecials';
import { createGame } from '../../src/engine/newgame';
import { maybeTriggerRacingBullsRecall } from '../../src/engine/nextTeamSpecials';
import { Rng } from '../../src/engine/rng';
import { afterSpecialRace } from '../../src/engine/teamSpecials';
import { buildView } from '../../src/engine/view';
import type { GameState } from '../../src/engine/types';
import { advanceUntil, cardSources } from '../helpers';

function game(playerTeamId: string, seed = 8128): GameState {
  const loaded = normalizeDatabase(cardSources());
  if (!loaded.db) throw new Error('card database failed to load');
  return createGame(loaded.db, { playerTeamId, principalName: 'Scenario Tester', seed, gameId: `ai-${playerTeamId}-${seed}`, now: 1 });
}

describe('AI team mechanics regression scenarios', () => {
  it('advances every AI special deterministically while keeping the player narrative isolated', () => {
    const first = game('cadillac');
    const second = game('cadillac');
    advanceWeeks(first, 1, new Rng(73));
    advanceWeeks(second, 1, new Rng(73));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.mclaren?.route).toBe('independent');
    expect(first.mercedes?.lastActionRound).toBe('1-w1');
    expect(first.redBull?.lastActionRound).toBe('1-w1');
    expect(first.astonMartin?.lastActionRound).toBe('1-w1');
    expect(first.audi?.alliance).toBe(true);
    expect(first.alpine?.lastActionRound).toBe('1-w1');
    expect(first.haas?.lastActionRound).toBe('1-w1');
    expect(first.williams?.focusRound).toBe('1-w1');
    expect(first.narration.some(event => ['mclaren_fix', 'aston_aduo', 'ferrari_pressure'].includes(event.kind))).toBe(false);
  });

  it('keeps AI Ferrari effects active without firing or freezing a Cadillac player', () => {
    const state = game('cadillac');
    state.rules.ferrari.graceRounds = 0;
    state.teams.ferrari.mediaReputation = 0;
    ferrariAfterRace(state, { kind: 'race', classification: [] } as never);

    expect(ferrariMediaDelta(state, 10)).toBeCloseTo(10 * state.rules.ferrari.mediaResultMul - state.rules.ferrari.mediaPerRace, 1);
    expect(state.ferrari?.dismissed).toBeNull();
    expect(state.flags.fired).not.toBe(true);
    expect(buildView(state).next).not.toBeNull();
    expect(state.narration.some(event => event.kind === 'fired' || event.kind === 'ferrari_pressure')).toBe(false);

    const raced = game('cadillac', 8129);
    raced.rules.ferrari.mediaResultMul = 0;
    raced.rules.ferrari.mediaPerRace = 2;
    const mediaBefore = raced.teams.ferrari.mediaReputation;
    const afterRace = advanceUntil(raced, current => current.season.phase === 'post_race');
    expect(afterRace.teams.ferrari.mediaReputation).toBe(mediaBefore - 2);
    expect(afterRace.flags.fired).not.toBe(true);
    expect(buildView(afterRace).next).not.toBeNull();
  });

  it('does not let AI Racing Bulls take a Red Bull player reserve', () => {
    const state = game('red_bull');
    state.rules.racingBulls.recallChance = 1;
    for (const driver of Object.values(state.drivers)) {
      if (driver.role === 'reserve') driver.teamId = 'red_bull';
    }
    const beforeCars = state.teams.racing_bulls.cars.map(car => car.driverId);
    maybeTriggerRacingBullsRecall(state, new Rng(3));

    expect(state.racingBulls?.pendingRecall).toBeNull();
    expect(state.racingBulls?.activeRecall).toBeNull();
    expect(state.teams.racing_bulls.cars.map(car => car.driverId)).toEqual(beforeCars);
  });

  it('tolerates saves with a special state but no Haas team entry', () => {
    const state = game('cadillac');
    delete (state.teams as Partial<typeof state.teams>).haas;

    expect(() => afterManagementRace(state)).not.toThrow();
    expect(state.flags.fired).not.toBe(true);
  });

  it('does not recall drivers from missing or incomplete Racing Bulls team data', () => {
    const missing = game('cadillac');
    missing.rules.racingBulls.recallChance = 1;
    delete (missing.teams as Partial<typeof missing.teams>).racing_bulls;
    expect(() => maybeTriggerRacingBullsRecall(missing, new Rng(3))).not.toThrow();
    expect(missing.racingBulls?.pendingRecall).toBeNull();

    const incomplete = game('cadillac');
    incomplete.rules.racingBulls.recallChance = 1;
    incomplete.teams.racing_bulls.cars = [];
    expect(() => maybeTriggerRacingBullsRecall(incomplete, new Rng(3))).not.toThrow();
    expect(incomplete.racingBulls?.pendingRecall).toBeNull();
  });

  it('migrates a pre-special save once, preserves existing state, and is idempotent', () => {
    const legacy = game('cadillac');
    legacy.ferrari!.fans.hamilton = 71;
    for (const key of ['mclaren', 'mercedes', 'redBull', 'astonMartin', 'racingBulls', 'audi', 'alpine', 'haas', 'williams', 'fiaMeeting'] as const) delete (legacy as Partial<GameState>)[key];
    for (const key of ['astonMartin', 'racingBulls', 'audi', 'fiaMeeting', 'alpine', 'haas', 'williams'] as const) delete (legacy.rules as Partial<GameState['rules']>)[key];

    const migrated = migrateState(legacy);
    expect(migrated.ferrari?.fans.hamilton).toBe(71);
    expect(migrated.mclaren && migrated.mercedes && migrated.redBull && migrated.astonMartin && migrated.racingBulls && migrated.audi && migrated.alpine && migrated.haas && migrated.williams && migrated.fiaMeeting).toBeTruthy();
    advanceWeeks(migrated, 1, new Rng(74));
    const once = JSON.stringify(migrated);
    expect(JSON.stringify(migrateState(JSON.parse(once)))).toBe(once);
  });

  it('does not restart AI season-opening crises when migrating a progressed save', () => {
    const legacy = game('cadillac', 8130);
    legacy.season.roundIndex = 10;
    legacy.season.week = 20;
    legacy.teams.ferrari.mediaReputation = 44;
    for (const key of ['ferrari', 'mclaren', 'mercedes', 'redBull', 'astonMartin', 'audi', 'alpine'] as const) delete (legacy as Partial<GameState>)[key];

    const migrated = migrateState(legacy);
    expect(migrated.teams.ferrari.mediaReputation).toBe(44);
    expect(migrated.mclaren).toMatchObject({ softwareResolved: true, weeksLeft: 0 });
    expect(migrated.mercedes).toMatchObject({ aduoApproved: true, aduoProgress: 100 });
    expect(migrated.redBull).toMatchObject({ summerChecked: true, gpRetention: 100 });
    expect(migrated.astonMartin).toMatchObject({ aduoEngineArrived: true, aduoProgress: 100 });
    expect(migrated.audi).toMatchObject({ turboFixed: true, alliance: true });
    expect(migrated.alpine?.integrationPenaltyActive).toBe(false);
  });

  it('does not let the AI Red Bull clause replace a Mercedes player driver', () => {
    const state = game('mercedes', 8131);
    const before = state.teams.mercedes.cars.map(car => car.driverId);
    state.season.roundIndex = Math.ceil(state.calendar.length / 2) - 1;
    state.redBull!.summerChecked = false;
    state.redBull!.gpRetention = 100;
    state.standings.drivers.verstappen.points = 0;
    for (const id of ['russell', 'antonelli', 'leclerc']) if (state.standings.drivers[id]) state.standings.drivers[id].points = 100;

    afterSpecialRace(state);
    expect(state.teams.mercedes.cars.map(car => car.driverId)).toEqual(before);
    expect(state.redBull?.verstappenExit).toBe(false);
  });
});
