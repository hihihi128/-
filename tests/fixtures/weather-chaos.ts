import { advanceRaceSession, engineerDecisionRoll, severeWeatherChaosProbability } from '../../src/engine/race';
import { migrateState } from '../../src/engine/migrate';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import type { GameState, LiveRaceCar, LiveRaceState } from '../../src/engine/types';
import { act, advanceUntil, cardSources } from '../helpers';

export const CHAOTIC_WEATHER_TEAM_IDS = ['mclaren', 'aston_martin', 'ferrari'] as const;
export type ChaoticWeatherTeamId = typeof CHAOTIC_WEATHER_TEAM_IDS[number];

export interface WeatherChaosScenario {
  state: GameState;
  live: LiveRaceState;
  car: LiveRaceCar;
}

/** Creates an AI-controlled target car in a race state suitable for deterministic weather calls. */
export function weatherChaosScenario(teamId: string, seed = 7194): WeatherChaosScenario {
  const loaded = normalizeDatabase(cardSources());
  if (!loaded.db) throw new Error('Card database failed to load');
  let state = createGame(loaded.db, { playerTeamId: 'cadillac', principalName: '测试领队', seed, gameId: `weather-chaos-${seed}`, now: 1 });
  state = advanceUntil(state, current => current.season.phase === 'race');
  state = act(state, { type: 'START_RACE', kind: 'race' });
  const live = state.weekend!.liveRace!;
  const car = Object.values(live.cars).find(candidate => candidate.teamId === teamId);
  if (!car) throw new Error(`Missing ${teamId} car in weather-chaos fixture`);

  for (const candidate of Object.values(live.cars)) candidate.player = false;
  live.pendingDecision = null;
  live.stage = 'ready';
  car.plan.strategySource = 'engineer';
  car.tyre = state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0];
  car.tyreAge = 6;
  car.engineerWeatherSpell = 0;
  car.engineerWeatherChaosStage = undefined;
  car.engineerWeatherChaosNextLap = undefined;

  return { state, live, car };
}

/** Finds a bounded deterministic weather RNG state with the requested result. */
export function weatherDecisionSeed(
  live: Pick<LiveRaceState, 'id'>,
  driverId: string,
  key: string,
  probability: number,
  expected: boolean,
): number {
  for (let weatherRngState = 0; weatherRngState < 100_000; weatherRngState++) {
    if (engineerDecisionRoll({ id: live.id, weatherRngState }, { driverId }, key, probability) === expected) return weatherRngState;
  }
  throw new Error(`Unable to find weather RNG state for ${key}=${expected}`);
}

/** Arms the target team to make (or reject) its severe-chaos decision for a given spell. */
export function armWeatherChaosDecision(
  scenario: WeatherChaosScenario,
  expected: boolean,
  spell = scenario.car.engineerWeatherSpell ?? 0,
): void {
  const probability = severeWeatherChaosProbability(scenario.state.teams[scenario.car.teamId]);
  if (probability <= 0) throw new Error(`${scenario.car.teamId} is not eligible for severe weather chaos`);
  scenario.live.weatherRngState = weatherDecisionSeed(
    scenario.live,
    scenario.car.teamId,
    `weather-chaos:${spell}`,
    probability,
    expected,
  );
}

/** Applies one deterministic weather lap without starting a UI decision window. */
export function advanceWeatherChaosLap(scenario: WeatherChaosScenario, wetness: number, rain: number): void {
  scenario.live.wetness = wetness;
  scenario.live.weatherTrajectory[scenario.live.completedLaps] = rain;
  advanceRaceSession(scenario.state, scenario.live, 'next_lap');
}

/** Models the persisted save/import boundary used by weather-chaos resume tests. */
export function restoreWeatherChaosScenario(scenario: WeatherChaosScenario): WeatherChaosScenario {
  const state = migrateState(JSON.parse(JSON.stringify(scenario.state)) as GameState);
  const live = state.weekend?.liveRace;
  if (!live) throw new Error('Weather-chaos fixture lost live race during restore');
  const car = live.cars[scenario.car.driverId];
  if (!car) throw new Error('Weather-chaos fixture lost target car during restore');
  return { state, live, car };
}
