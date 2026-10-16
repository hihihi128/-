import { describe, expect, it } from 'vitest';
import { act, advanceUntil, newTestGame } from '../helpers';
import { advanceRaceSession, engineerDecisionRoll, engineerWeatherRisk, severeDryChaosProbability, severeWeatherChaosProbability } from '../../src/engine/race';
import { staffAbility } from '../../src/engine/staff';
import { advanceWeatherChaosLap, armWeatherChaosDecision, restoreWeatherChaosScenario, weatherChaosScenario, weatherDecisionSeed } from '../fixtures/weather-chaos';

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
    while (!(!engineerDecisionRoll({ id: live.id, weatherRngState: matchingSeed }, { driverId: car.teamId }, 'weather-chaos:0', probability)
      && engineerDecisionRoll({ id: live.id, weatherRngState: matchingSeed }, { driverId: car.teamId }, 'weather-chaos:1', probability))) matchingSeed++;
    live.weatherRngState = matchingSeed;

    live.wetness = .1;
    live.weatherTrajectory[live.completedLaps] = .1;
    advanceRaceSession(state, live, 'next_lap');
    expect(car.engineerWeatherChaosStage).toBeUndefined();
    expect(car.engineerWeatherSpellActive).toBe(true);

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
    expect(car.engineerWeatherChaosStage).toBe(1);
  });

  it('allows all three eligible teams to force the initial severe-chaos stop', () => {
    for (const teamId of ['mclaren', 'aston_martin', 'ferrari'] as const) {
      const scenario = weatherChaosScenario(teamId, 7300);
      armWeatherChaosDecision(scenario, true);

      advanceWeatherChaosLap(scenario, .1, .1);

      expect(scenario.car.engineerWeatherChaosStage).toBe(1);
      expect(scenario.car.tyre).toBe(scenario.state.rules.wetCompound);
      expect(scenario.car.pits).toBe(1);
    }
  });

  it('never starts severe weather chaos for non-eligible teams', () => {
    for (const teamId of ['red_bull', 'mercedes', 'williams', 'haas', 'audi', 'alpine', 'cadillac', 'racing_bulls']) {
      const scenario = weatherChaosScenario(teamId, 7301);
      scenario.live.weatherRngState = 0;

      advanceWeatherChaosLap(scenario, .1, .1);

      expect(scenario.car.engineerWeatherChaosStage).toBeUndefined();
      expect(scenario.live.events.some(event => event.drivers.includes(scenario.car.driverId) && event.text.includes('策略组'))).toBe(false);
    }
  });

  it('does not broaden forced ordinary stops beyond Ferrari', () => {
    for (const teamId of ['mclaren', 'aston_martin'] as const) {
      const scenario = weatherChaosScenario(teamId, 7302);
      scenario.car.tyre = scenario.state.rules.wetCompound;
      scenario.car.tyreAge = 0;
      scenario.car.raceEngineerWeather = 50;
      scenario.car.raceEngineerReaction = 50;
      scenario.state.teams[teamId].staff.strategist.abilities = { ...scenario.state.teams[teamId].staff.strategist.abilities, risk: 84 };
      const risk = engineerWeatherRisk(50, 50, 84, .4)!;
      scenario.live.weatherRngState = weatherDecisionSeed(scenario.live, scenario.car.driverId, 'wet-dry-tyre:0', risk.probability, true);
      const pits = scenario.car.pits;

      advanceWeatherChaosLap(scenario, .4, .2);

      expect(scenario.car.engineerTyreOverride).not.toBeNull();
      expect(scenario.car.pits).toBe(pits);
      expect(scenario.car.tyre).toBe(scenario.state.rules.wetCompound);
    }

    const ferrari = weatherChaosScenario('ferrari', 7302);
    ferrari.car.tyre = ferrari.state.rules.wetCompound;
    ferrari.car.tyreAge = 0;
    ferrari.car.raceEngineerWeather = 50;
    ferrari.car.raceEngineerReaction = 50;
    ferrari.state.teams.ferrari.staff.strategist.abilities = { ...ferrari.state.teams.ferrari.staff.strategist.abilities, risk: 84 };
    const risk = engineerWeatherRisk(50, 50, 84, .4)!;
    ferrari.live.weatherRngState = weatherDecisionSeed(ferrari.live, ferrari.car.driverId, 'wet-dry-tyre:0', risk.probability, true);
    const pits = ferrari.car.pits;

    advanceWeatherChaosLap(ferrari, .4, .2);

    expect(ferrari.car.pits).toBe(pits + 1);
    expect(ferrari.state.rules.tyres[ferrari.car.tyre].wet).toBe(false);
  });

  it('preserves weather-chaos stages across save and resume', () => {
    const finishShower = (scenario: ReturnType<typeof weatherChaosScenario>) => {
      advanceWeatherChaosLap(scenario, .1, .1);
      advanceWeatherChaosLap(scenario, .1, .1);
      advanceWeatherChaosLap(scenario, .2, .3);
    };
    const comparedCar = (scenario: ReturnType<typeof weatherChaosScenario>) => ({
      tyre: scenario.car.tyre,
      pits: scenario.car.pits,
      stage: scenario.car.engineerWeatherChaosStage,
      nextLap: scenario.car.engineerWeatherChaosNextLap,
      events: scenario.live.events.filter(event => event.drivers.includes(scenario.car.driverId)),
    });

    const stageOne = weatherChaosScenario('ferrari', 7303);
    armWeatherChaosDecision(stageOne, true);
    advanceWeatherChaosLap(stageOne, .1, .1);
    expect(stageOne.car.engineerWeatherChaosStage).toBe(1);
    const resumedStageOne = restoreWeatherChaosScenario(stageOne);
    finishShower(stageOne);
    finishShower(resumedStageOne);
    expect(comparedCar(resumedStageOne)).toEqual(comparedCar(stageOne));

    const stageTwo = weatherChaosScenario('ferrari', 7304);
    armWeatherChaosDecision(stageTwo, true);
    advanceWeatherChaosLap(stageTwo, .1, .1);
    advanceWeatherChaosLap(stageTwo, .1, .1);
    expect(stageTwo.car.engineerWeatherChaosStage).toBe(2);
    const resumedStageTwo = restoreWeatherChaosScenario(stageTwo);
    advanceWeatherChaosLap(stageTwo, .1, .1);
    advanceWeatherChaosLap(stageTwo, .2, .3);
    advanceWeatherChaosLap(resumedStageTwo, .1, .1);
    advanceWeatherChaosLap(resumedStageTwo, .2, .3);
    expect(comparedCar(resumedStageTwo)).toEqual(comparedCar(stageTwo));
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

  it('keeps Ferrari severe-chaos calls near the 75% cap across rain spells', () => {
    const decisions = Array.from(
      { length: 10_000 },
      (_, spell) => engineerDecisionRoll({ id: 'ferrari-chaos-rate', weatherRngState: 7194 }, { driverId: 'ferrari' }, `weather-chaos:${spell}`, .75),
    );
    const rate = decisions.filter(Boolean).length / decisions.length;
    expect(rate).toBeGreaterThanOrEqual(.72);
    expect(rate).toBeLessThanOrEqual(.78);
  });

  it('turns every low dry-strategy team into consecutive unnecessary stops', () => {
    for (const teamId of ['mclaren', 'aston_martin', 'ferrari'] as const) {
      const scenario = weatherChaosScenario(teamId, 7310);
      const probability = severeDryChaosProbability(scenario.state.teams[teamId]);
      expect(probability).toBeGreaterThan(0);
      if (teamId === 'aston_martin' && scenario.state.astonMartin) scenario.state.astonMartin.aduoEngineArrived = true;
      scenario.live.weatherRngState = weatherDecisionSeed(scenario.live, teamId, 'dry-chaos', probability, true);
      scenario.live.weatherTrajectory.fill(0);
      const triggerLap = Math.max(5, Math.round(scenario.live.totalLaps * .3));
      while (scenario.live.lap < triggerLap - 1) {
        scenario.live.scLeft = 0;
        scenario.live.vscLeft = 0;
        advanceWeatherChaosLap(scenario, 0, 0);
      }
      const pits = scenario.car.pits;

      scenario.live.scLeft = 0;
      scenario.live.vscLeft = 0;
      advanceWeatherChaosLap(scenario, 0, 0);
      expect(scenario.car.engineerDryChaosStage, teamId).toBe(1);
      expect(scenario.car.pits, teamId).toBe(pits + 1);

      scenario.live.scLeft = 0;
      scenario.live.vscLeft = 0;
      advanceWeatherChaosLap(scenario, 0, 0);
      expect(scenario.car.engineerDryChaosStage).toBe(2);
      expect(scenario.car.pits).toBe(pits + 2);
      expect(scenario.live.events.filter(event => event.drivers.includes(scenario.car.driverId) && event.text.includes('策略组')).map(event => event.text)).toEqual(expect.arrayContaining([
        expect.stringContaining('误判轮胎窗口'),
        expect.stringContaining('再次推翻决定'),
        expect.stringContaining('连续进站换胎'),
      ]));
    }
  });

  it('never applies severe dry-strategy chaos outside the bottom three teams', () => {
    for (const teamId of ['red_bull', 'mercedes', 'williams', 'haas', 'audi', 'alpine', 'cadillac', 'racing_bulls']) {
      const scenario = weatherChaosScenario(teamId, 7311);
      expect(severeDryChaosProbability(scenario.state.teams[teamId])).toBe(0);
      scenario.live.weatherTrajectory.fill(0);
      scenario.car.tyreAge = 0;
      scenario.car.plannedCompounds = [scenario.car.tyre];
      scenario.car.stints = [scenario.live.totalLaps + 1];
      const triggerLap = Math.max(5, Math.round(scenario.live.totalLaps * .3));
      while (scenario.live.lap < triggerLap) {
        scenario.live.scLeft = 0;
        scenario.live.vscLeft = 0;
        advanceWeatherChaosLap(scenario, 0, 0);
      }
      expect(scenario.car.engineerDryChaosStage).toBeUndefined();
      expect(scenario.car.pits).toBe(0);
    }
  });

  it('excludes player cars and sprints, and requires another dry compound before dry chaos starts', () => {
    const prepareAtTrigger = (seed: number) => {
      const scenario = weatherChaosScenario('ferrari', seed);
      const probability = severeDryChaosProbability(scenario.state.teams.ferrari);
      scenario.live.weatherRngState = weatherDecisionSeed(scenario.live, 'ferrari', 'dry-chaos', probability, true);
      scenario.live.weatherTrajectory.fill(0);
      const triggerLap = Math.max(5, Math.round(scenario.live.totalLaps * .3));
      while (scenario.live.lap < triggerLap - 1) {
        scenario.live.scLeft = 0;
        scenario.live.vscLeft = 0;
        advanceWeatherChaosLap(scenario, 0, 0);
      }
      return scenario;
    };

    const playerCar = prepareAtTrigger(7313);
    playerCar.car.player = true;
    advanceWeatherChaosLap(playerCar, 0, 0);
    expect(playerCar.car.engineerDryChaosAssessed).toBeUndefined();
    expect(playerCar.car.engineerDryChaosStage).toBeUndefined();

    const sprint = prepareAtTrigger(7314);
    sprint.live.kind = 'sprint';
    advanceWeatherChaosLap(sprint, 0, 0);
    expect(sprint.car.engineerDryChaosAssessed).toBeUndefined();
    expect(sprint.car.engineerDryChaosStage).toBeUndefined();

    const noAlternative = prepareAtTrigger(7315);
    noAlternative.state.rules.dryCompounds = [noAlternative.car.tyre];
    const pits = noAlternative.car.pits;
    advanceWeatherChaosLap(noAlternative, 0, 0);
    expect(noAlternative.car.engineerDryChaosAssessed).toBe(true);
    expect(noAlternative.car.engineerDryChaosStage).toBeUndefined();
    expect(noAlternative.car.pits).toBe(pits);
  });

  it('preserves dry-chaos state through JSON save and resume', () => {
    const scenario = weatherChaosScenario('ferrari', 7312);
    const probability = severeDryChaosProbability(scenario.state.teams.ferrari);
    scenario.live.weatherRngState = weatherDecisionSeed(scenario.live, 'ferrari', 'dry-chaos', probability, true);
    scenario.live.weatherTrajectory.fill(0);
    const triggerLap = Math.max(5, Math.round(scenario.live.totalLaps * .3));
    while (scenario.live.lap < triggerLap) {
      scenario.live.scLeft = 0;
      scenario.live.vscLeft = 0;
      advanceWeatherChaosLap(scenario, 0, 0);
    }
    expect(scenario.car).toMatchObject({ engineerDryChaosAssessed: true, engineerDryChaosStage: 1, engineerDryChaosNextLap: scenario.live.lap + 1 });

    const resumed = restoreWeatherChaosScenario(scenario);
    expect(resumed.car).toMatchObject({ engineerDryChaosAssessed: true, engineerDryChaosStage: 1, engineerDryChaosNextLap: scenario.car.engineerDryChaosNextLap });
    scenario.live.scLeft = 0;
    scenario.live.vscLeft = 0;
    resumed.live.scLeft = 0;
    resumed.live.vscLeft = 0;
    advanceWeatherChaosLap(scenario, 0, 0);
    advanceWeatherChaosLap(resumed, 0, 0);
    expect({
      tyre: resumed.car.tyre,
      pits: resumed.car.pits,
      stage: resumed.car.engineerDryChaosStage,
      nextLap: resumed.car.engineerDryChaosNextLap,
      events: resumed.live.events.filter(event => event.drivers.includes(resumed.car.driverId)),
    }).toEqual({
      tyre: scenario.car.tyre,
      pits: scenario.car.pits,
      stage: scenario.car.engineerDryChaosStage,
      nextLap: scenario.car.engineerDryChaosNextLap,
      events: scenario.live.events.filter(event => event.drivers.includes(scenario.car.driverId)),
    });
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
