import { describe, expect, it } from 'vitest';
import { act, advanceUntil, newTestGame } from '../helpers';
import { advanceRaceSession, engineerDecisionRoll, engineerWeatherRisk, severeWeatherChaosProbability } from '../../src/engine/race';
import { staffAbility } from '../../src/engine/staff';

describe('engineer strategy execution', () => {
  function makeMclarenScenario(state: ReturnType<typeof newTestGame>) {
    const live = state.weekend!.liveRace!;
    const car = Object.values(live.cars).find(candidate => candidate.teamId === 'ferrari')!;
    const ferrari = state.teams.ferrari;
    state.teams.mclaren = {
      ...ferrari,
      id: 'mclaren',
      staff: {
        ...ferrari.staff,
        strategist: { ...ferrari.staff.strategist, skill: 70, abilities: { strategy: 70, weather: 69, reaction: 69, risk: 71 } },
      },
    };
    car.teamId = 'mclaren';
    return { live, car };
  }

  it('uses neutral risk for legacy staff without specialist abilities', () => {
    expect(staffAbility({ name: 'legacy', skill: 95, salary: 1 }, 'risk')).toBe(70);
  });
  it('derives wet-weather risks from personal abilities rather than team identity', () => {
    expect(engineerWeatherRisk(72, 70, 84, .3)).toMatchObject({ preference: 'soft', holdLaps: 2 });
    expect(engineerWeatherRisk(90, 88, 68, .7)).toMatchObject({ preference: 'medium', holdLaps: 1 });
    expect(engineerWeatherRisk(75, 74, 86, .1)).toMatchObject({ preference: 'intermediate', holdLaps: 3 });
    expect(engineerWeatherRisk(90, 90, 70, .1)).toBeNull();
    expect(engineerWeatherRisk(72, 70, 84, .5)!.probability).toBeGreaterThan(engineerWeatherRisk(90, 88, 68, .5)!.probability);
  });

  it('can make Ferrari switch wet, dry, then wet again during one changing shower', () => {
    let state = advanceUntil(newTestGame(7194), current => current.season.phase === 'race');
    state = act(state, { type: 'START_RACE', kind: 'race' });
    const live = state.weekend!.liveRace!;
    const car = Object.values(live.cars).find(candidate => candidate.teamId === 'ferrari')!;
    for (const candidate of Object.values(live.cars)) candidate.player = false;
    live.pendingDecision = null;
    live.stage = 'ready';
    car.plan.strategySource = 'engineer';
    car.tyre = state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0];
    car.tyreAge = 6;
    const probability = severeWeatherChaosProbability(state.teams[car.teamId]);
    let matchingSeed = 0;
    while (!engineerDecisionRoll({ id: live.id, weatherRngState: matchingSeed }, { driverId: car.teamId }, 'weather-chaos:0', probability)) matchingSeed++;
    live.weatherRngState = matchingSeed;

    live.wetness = .1;
    live.weatherTrajectory[live.completedLaps] = .1;
    advanceRaceSession(state, live, 'next_lap');
    expect(car.tyre).toBe(state.rules.wetCompound);

    live.wetness = .1;
    live.weatherTrajectory[live.completedLaps] = .1;
    advanceRaceSession(state, live, 'next_lap');
    expect(state.rules.tyres[car.tyre].wet).toBe(false);

    live.wetness = .1;
    live.weatherTrajectory[live.completedLaps] = .1;
    advanceRaceSession(state, live, 'next_lap');
    expect(state.rules.tyres[car.tyre].wet).toBe(false);

    live.wetness = .2;
    live.weatherTrajectory[live.completedLaps] = .3;
    advanceRaceSession(state, live, 'next_lap');
    expect(state.rules.tyres[car.tyre].wet).toBe(true);
    expect(car.pits).toBeGreaterThanOrEqual(3);
  });

  it('does not force an ordinary McLaren weather suggestion into a pit stop', () => {
    let state = advanceUntil(newTestGame(7195), current => current.season.phase === 'race');
    state = act(state, { type: 'START_RACE', kind: 'race' });
    const { live, car } = makeMclarenScenario(state);
    for (const candidate of Object.values(live.cars)) candidate.player = false;
    live.pendingDecision = null;
    live.stage = 'ready';
    car.plan.strategySource = 'engineer';
    car.tyre = state.rules.wetCompound;
    car.tyreAge = 0;
    car.raceEngineerWeather = 50;
    car.raceEngineerReaction = 50;
    const risk = engineerWeatherRisk(50, 50, state.teams[car.teamId].staff.strategist.abilities!.risk!, .4)!;
    let matchingSeed = 0;
    while (!engineerDecisionRoll({ id: live.id, weatherRngState: matchingSeed }, car, 'wet-dry-tyre:0', risk.probability)) matchingSeed++;
    live.weatherRngState = matchingSeed;
    live.wetness = .4;
    live.weatherTrajectory[live.completedLaps] = .2;
    const pits = car.pits;

    advanceRaceSession(state, live, 'next_lap');

    expect(car.pits).toBe(pits);
    expect(car.tyre).toBe(state.rules.wetCompound);
    expect(car.engineerTyreOverride).not.toBeNull();
  });

  it('uses a new chaos roll after the track dries between showers', () => {
    let state = advanceUntil(newTestGame(7196), current => current.season.phase === 'race');
    state = act(state, { type: 'START_RACE', kind: 'race' });
    const { live, car } = makeMclarenScenario(state);
    for (const candidate of Object.values(live.cars)) candidate.player = false;
    live.pendingDecision = null;
    live.stage = 'ready';
    car.plan.strategySource = 'engineer';
    car.tyre = state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0];
    car.tyreAge = 6;
    const probability = severeWeatherChaosProbability(state.teams[car.teamId]);
    let matchingSeed = 0;
    while (!(engineerDecisionRoll({ id: live.id, weatherRngState: matchingSeed }, { driverId: car.teamId }, 'weather-chaos:0', probability)
      && !engineerDecisionRoll({ id: live.id, weatherRngState: matchingSeed }, { driverId: car.teamId }, 'weather-chaos:1', probability))) matchingSeed++;
    live.weatherRngState = matchingSeed;

    live.wetness = .1;
    live.weatherTrajectory[live.completedLaps] = .1;
    advanceRaceSession(state, live, 'next_lap');
    expect(car.engineerWeatherChaosStage).toBe(1);

    live.wetness = 0;
    live.weatherTrajectory[live.completedLaps] = 0;
    advanceRaceSession(state, live, 'next_lap');
    expect(car.engineerWeatherSpell).toBe(1);
    expect(car.engineerWeatherChaosStage).toBeUndefined();

    car.tyre = state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0];
    car.tyreAge = 6;
    live.wetness = .1;
    live.weatherTrajectory[live.completedLaps] = .1;
    advanceRaceSession(state, live, 'next_lap');
    expect(car.engineerWeatherChaosStage).toBeUndefined();
  });

  it('makes each weather decision deterministic without using a supplied race RNG', () => {
    const session = { id: 'race-test' };
    const car = { driverId: 'driver-test' };
    const first = engineerDecisionRoll(session, car, 'wet-dry-tyre', .55);
    for (let i = 0; i < 10; i++) expect(engineerDecisionRoll(session, car, 'wet-dry-tyre', .55)).toBe(first);
  });

  it('mixes the private weather seed and rain-spell key into deterministic decisions', () => {
    const car = { driverId: 'driver-test' };
    const seeded = new Set(Array.from({ length: 32 }, (_, weatherRngState) => engineerDecisionRoll({ id: 'race-test', weatherRngState }, car, 'wet-dry-tyre:0', .55)));
    const spells = new Set(Array.from({ length: 32 }, (_, spell) => engineerDecisionRoll({ id: 'race-test', weatherRngState: 7190 }, car, `wet-dry-tyre:${spell}`, .55)));
    expect(seeded).toEqual(new Set([true, false]));
    expect(spells).toEqual(new Set([true, false]));
  });

  it('skips player decision windows when both drivers listen to engineers', () => {
    let state = advanceUntil(newTestGame(7190), current => current.season.phase === 'race');
    const driverIds = Object.values(state.drivers).filter(driver => driver.teamId === state.meta.playerTeamId).map(driver => driver.id);
    for (const driverId of driverIds) state = act(state, { type: 'SET_PLAN', driverId, plan: { strategySource: 'engineer' } });
    state = act(state, { type: 'START_RACE', kind: 'race' });
    expect(state.weekend!.liveRace!.pendingDecision).toBeNull();
    const live = state.weekend!.liveRace!;
    state = act(state, { type: 'ADVANCE_RACE', sessionId: live.id, expectedRevision: live.revision, until: 'next_lap' });
    expect(state.weekend!.liveRace!.completedLaps).toBe(1);
  });

  it('automatically resolves mixed player and engineer strategy modes', () => {
    let state = advanceUntil(newTestGame(7191), current => current.season.phase === 'race');
    const driverIds = Object.values(state.drivers).filter(driver => driver.teamId === state.meta.playerTeamId).map(driver => driver.id);
    state = act(state, { type: 'SET_PLAN', driverId: driverIds[0], plan: { strategySource: 'engineer' } });
    state = act(state, { type: 'SET_PLAN', driverId: driverIds[1], plan: { strategySource: 'player' } });
    const finished = act(state, { type: 'RUN_RACE' });
    expect(finished.weekend!.race).not.toBeNull();
    expect(finished.weekend!.liveRace).toBeNull();
  });

  it('does not create engineer weather events for a retired car', () => {
    let state = advanceUntil(newTestGame(7192), current => current.season.phase === 'race');
    state.teams[state.meta.playerTeamId].name = '法拉利';
    const driverIds = Object.values(state.drivers).filter(driver => driver.teamId === state.meta.playerTeamId).map(driver => driver.id);
    for (const driverId of driverIds) state = act(state, { type: 'SET_PLAN', driverId, plan: { strategySource: 'engineer' } });
    state = act(state, { type: 'START_RACE', kind: 'race' });
    const live = state.weekend!.liveRace!;
    live.cars[driverIds[0]].status = 'dnf';
    live.cars[driverIds[0]].reason = 'test';
    live.wetness = .29;
    live.surface = 'damp';
    live.weatherTrajectory[0] = 1;
    let matchingSeed = 0;
    while (!engineerDecisionRoll({ id: live.id, weatherRngState: matchingSeed }, { driverId: driverIds[0] }, 'wet-dry-tyre:0', .55)) matchingSeed++;
    live.weatherRngState = matchingSeed;
    state = act(state, { type: 'ADVANCE_RACE', sessionId: live.id, expectedRevision: live.revision, until: 'next_lap' });
    expect(state.weekend!.liveRace!.events.some(event => event.drivers.includes(driverIds[0]) && event.text.includes('工程师误判'))).toBe(false);
  });

  it('perfect strategy stays automated without staff weather mistakes', () => {
    let state = advanceUntil(newTestGame(7193), current => current.season.phase === 'race');
    const driverIds = Object.values(state.drivers).filter(driver => driver.teamId === state.meta.playerTeamId).map(driver => driver.id);
    for (const driverId of driverIds) state = act(state, { type: 'SET_PLAN', driverId, plan: { strategySource: 'perfect' } });
    state = act(state, { type: 'START_RACE', kind: 'race' });
    let live = state.weekend!.liveRace!;
    if (live.pendingDecision) {
      state = act(state, {
        type: 'RESOLVE_RACE_DECISION',
        sessionId: live.id,
        expectedRevision: live.revision,
        windowId: live.pendingDecision.id,
        drivers: live.pendingDecision.eligibleDriverIds.map(driverId => ({ driverId, pit: 'auto', startCompound: state.rules.wetCompound })),
      });
      live = state.weekend!.liveRace!;
    }
    live.wetness = .29;
    live.surface = 'damp';
    live.weatherTrajectory[0] = 1;
    state = act(state, { type: 'ADVANCE_RACE', sessionId: live.id, expectedRevision: live.revision, until: 'next_lap' });
    expect(state.weekend!.liveRace!.pendingDecision).toBeNull();
    expect(state.weekend!.liveRace!.events.some(event => event.drivers.some(id => driverIds.includes(id)) && (event.text.includes('工程师误判') || event.text.includes('反应过度')))).toBe(false);
  });
});
