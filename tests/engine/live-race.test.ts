import { describe, expect, it } from 'vitest';
import { act, advanceUntil, newTestGame, tryAct } from '../helpers';
import { buildView } from '../../src/engine/view';
import { buildStatePrompt } from '../../src/engine/prompt';
import { Rng } from '../../src/engine/rng';
import { createForecast, createWeatherTrajectory } from '../../src/engine/raceWeather';
import { migrateState } from '../../src/engine/migrate';
import { teammateRelationship, willDisobeyStrategy } from '../../src/engine/driverBehavior';
import { redFlagProbability } from '../../src/engine/race';

describe('resumable live race', () => {
  function raceReady(seed = 702): ReturnType<typeof newTestGame> {
    let state = newTestGame(seed);
    state = advanceUntil(state, s => s.season.phase === 'race');
    return state;
  }

  it('scales red-flag risk with incident severity, weather, and involved cars', () => {
    expect(redFlagProbability('minor', 1, 2, .8)).toBe(0);
    expect(redFlagProbability('dnf', .8, 2, .5)).toBeGreaterThan(redFlagProbability('dnf', 0, 1, .5));
  });

  it('allows a free tyre change during a red flag and schedules the selected restart', () => {
    const state = act(raceReady(), { type: 'START_RACE', kind: 'race' });
    const live = state.weekend!.liveRace!;
    live.completedLaps = 8;
    live.lap = 8;
    live.stage = 'before_pit';
    live.redFlags = 1;
    live.redFlag = { active: true, triggerLap: 8, restart: 'standing', restartPending: false };
    live.pendingDecision!.stage = 'before_pit';
    live.pendingDecision!.lap = 8;
    live.pendingDecision!.reasons = ['red_flag'];
    const playerCars = Object.values(live.cars).filter(car => car.player);
    const changed = playerCars[0];
    const engineerControlled = playerCars[1];
    engineerControlled.plan.strategySource = 'engineer';
    engineerControlled.tyreAge = 9;
    const engineerStint = engineerControlled.stintIndex;
    const freeCompound = state.rules.dryCompounds.at(-1)!;
    const oldPits = changed.pits;
    const oldTime = changed.cumulativeTime;
    const result = act(state, {
      type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision!.id,
      drivers: playerCars.map((car, index) => index === 0 ? { driverId: car.driverId, pit: 'box' as const, compound: freeCompound } : { driverId: car.driverId, pit: 'auto' as const }),
    });
    const resumed = result.weekend!.liveRace!;
    expect(resumed.cars[changed.driverId].tyre).toBe(freeCompound);
    expect(resumed.cars[changed.driverId].pits).toBe(oldPits);
    expect(resumed.cars[changed.driverId].cumulativeTime).toBe(oldTime);
    expect(resumed.cars[changed.driverId].stintIndex).toBe(1);
    expect(resumed.cars[engineerControlled.driverId].tyreAge).toBe(0);
    expect(resumed.cars[engineerControlled.driverId].stintIndex).toBe(engineerStint + 1);
    expect(resumed.redFlag).toMatchObject({ active: false, restartPending: true, restart: 'standing' });
    expect(resumed.events.some(event => event.type === 'restart')).toBe(true);
  });

  it('compresses the field only after every car completes the red-flag trigger lap', () => {
    let stopped: ReturnType<typeof newTestGame> | null = null;
    for (let seed = 1; seed <= 30 && !stopped; seed++) {
      let state = raceReady(seed);
      const track = state.tracks[state.calendar[state.season.roundIndex].trackId];
      track.scChance = 1;
      for (const driver of Object.values(state.drivers)) driver.attrs.consistency = 1;
      state = act(state, { type: 'START_RACE', kind: 'race' });
      const grid = state.weekend!.liveRace!;
      for (const car of Object.values(grid.cars)) car.reliability = 1;
      grid.weatherTrajectory.fill(.8);
      state = act(state, {
        type: 'RESOLVE_RACE_DECISION', sessionId: grid.id, expectedRevision: grid.revision, windowId: grid.pendingDecision!.id,
        drivers: Object.values(grid.cars).filter(car => car.player).map(car => ({ driverId: car.driverId, pit: 'auto' as const })),
      });
      for (let step = 0; step < 40 && state.weekend?.liveRace; step++) {
        const live = state.weekend.liveRace;
        if (live.pendingDecision?.reasons.includes('red_flag')) { stopped = state; break; }
        if (live.pendingDecision) {
          state = act(state, {
            type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision.id,
            drivers: Object.values(live.cars).filter(car => car.player && car.status === 'running').map(car => ({ driverId: car.driverId, pit: 'auto' as const })),
          });
        } else state = act(state, { type: 'ADVANCE_RACE', sessionId: live.id, expectedRevision: live.revision, until: 'next_decision' });
      }
    }
    expect(stopped).not.toBeNull();
    const running = Object.values(stopped!.weekend!.liveRace!.cars).filter(car => car.status === 'running').sort((a, b) => a.cumulativeTime - b.cumulativeTime);
    expect(running.at(-1)!.cumulativeTime - running[0].cumulativeTime).toBeLessThan(8);
  });

  it('creates a JSON-safe grid checkpoint and hides private simulation inputs from the view', () => {
    const state = act(raceReady(), { type: 'START_RACE', kind: 'race' });
    const restored = JSON.parse(JSON.stringify(state));
    const live = restored.weekend.liveRace;
    expect(live.pendingDecision?.reasons).toEqual(['grid']);
    expect(live.weatherTrajectory).toHaveLength(live.totalLaps);
    const publicRace = buildView(restored).weekend?.liveRace;
    expect(publicRace?.weather.forecast.horizonLaps).toBe(5);
    expect(JSON.stringify(publicRace)).not.toContain('weatherTrajectory');
    expect(JSON.stringify(publicRace)).not.toContain('rngState');
    expect(JSON.stringify(publicRace)).not.toContain('plannedCompounds');
    const prompt = buildStatePrompt(restored);
    expect(prompt).toContain('实时比赛');
    expect(prompt).not.toContain('weatherTrajectory');
    expect(prompt).not.toContain(String(live.rngState));
  });

  it('uses the weekend hidden weather seed without exposing it in the public view', () => {
    const ready = raceReady(321);
    const track = ready.tracks[ready.calendar[ready.season.roundIndex].trackId];
    const seed = ready.weekend!.raceWeatherSeed!;
    const expected = createWeatherTrajectory(track.laps, ready.weekend!.weather.race === 'wet', track.rainChance, new Rng(seed));
    const started = act(ready, { type: 'START_RACE', kind: 'race' });
    expect(started.weekend!.liveRace!.weatherTrajectory).toEqual(expected);
    expect(JSON.stringify(buildView(started).weekend)).not.toContain('raceWeatherSeed');
  });

  it('rejects stale windows atomically and accepts a two-car grid decision', () => {
    const started = act(raceReady(), { type: 'START_RACE', kind: 'race' });
    const live = started.weekend!.liveRace!;
    const playerIds = Object.values(live.cars).filter(c => c.player).map(c => c.driverId);
    const stale = tryAct(started, { type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision + 1, windowId: live.pendingDecision!.id, drivers: [] });
    expect(stale.ok).toBe(false);
    expect(stale.state).toBe(started);
    const resolved = act(started, {
      type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision!.id,
      drivers: playerIds.map(driverId => ({ driverId, pit: 'auto' })),
    });
    expect(resolved.weekend!.liveRace?.pendingDecision).toBeNull();
    expect(resolved.weekend!.liveRace?.revision).toBeGreaterThan(live.revision);
  });

  it('does not treat an unchanged grid confirmation as a strategy instruction', () => {
    const ready = raceReady();
    for (const driver of Object.values(ready.drivers).filter(d => d.teamId === ready.meta.playerTeamId)) driver.trust = 0;
    const started = act(ready, { type: 'START_RACE', kind: 'race' });
    const live = started.weekend!.liveRace!;
    const drivers = Object.values(live.cars).filter(c => c.player).map(car => ({
      driverId: car.driverId,
      pit: 'auto' as const,
      paceMode: car.plan.paceMode,
      energyMode: car.energyMode,
      pitTiming: car.plan.pitTiming,
    }));
    const resolved = act(started, { type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision!.id, drivers });
    expect(resolved.weekend!.liveRace!.events.some(event => event.text.includes('拒绝临场策略指令'))).toBe(false);
  });

  it('keeps driver behavior rolls outside the main race random stream', () => {
    const automatic = raceReady(812);
    const instructed = raceReady(812);
    instructed.drivers.c1.trust = 0;
    automatic.drivers.c1.trust = 0;
    const planned = act(instructed, { type: 'SET_PLAN', driverId: 'c1', plan: { paceMode: 'push', pitTiming: 'late' } });
    const automaticRace = act(automatic, { type: 'START_RACE', kind: 'race' }).weekend!.liveRace!;
    const instructedRace = act(planned, { type: 'START_RACE', kind: 'race' }).weekend!.liveRace!;
    expect(instructedRace.id).toBe(automaticRace.id);
    expect(instructedRace.rngState).toBe(automaticRace.rngState);
    expect(instructedRace.weatherRngState).toBe(automaticRace.weatherRngState);
  });

  it('can refuse a changed live tactic through a deterministic behavior roll', () => {
    const ready = raceReady(913);
    ready.drivers.c1.trust = 0;
    const launched = act(ready, { type: 'START_RACE', kind: 'race' });
    const grid = launched.weekend!.liveRace!;
    const started = act(launched, { type: 'RESOLVE_RACE_DECISION', sessionId: grid.id, expectedRevision: grid.revision, windowId: grid.pendingDecision!.id, drivers: Object.values(grid.cars).filter(c => c.player).map(c => ({ driverId: c.driverId, pit: 'auto' })) });
    const live = started.weekend!.liveRace!;
    const relationship = teammateRelationship(started, started.meta.playerTeamId);
    while (!willDisobeyStrategy(started.drivers.c1, relationship, `${live.id}:tactics:lap-${live.lap}:c1`)) live.lap++;
    const before = live.cars.c1.plan.paceMode;
    const result = act(started, { type: 'SET_RACE_TACTICS', sessionId: live.id, expectedRevision: live.revision, drivers: [{ driverId: 'c1', paceMode: before === 'push' ? 'conserve' : 'push' }] });
    expect(result.weekend!.liveRace!.cars.c1.plan.paceMode).toBe(before);
    expect(result.weekend!.liveRace!.events.at(-1)?.text).toContain('拒绝实时策略调整');
  });

  it('matches automatic completion when every interactive window delegates to auto', () => {
    const ready = raceReady(991);
    const automatic = act(ready, { type: 'RUN_RACE' });
    let interactive = act(ready, { type: 'START_RACE', kind: 'race' });
    for (let i = 0; i < 200 && interactive.weekend?.liveRace; i++) {
      const live = interactive.weekend.liveRace;
      if (live.pendingDecision) {
        interactive = act(interactive, {
          type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision.id,
          drivers: Object.values(live.cars).filter(c => c.player && c.status === 'running').map(c => ({ driverId: c.driverId, pit: 'auto' })),
        });
      } else {
        interactive = act(interactive, { type: 'ADVANCE_RACE', sessionId: live.id, expectedRevision: live.revision, until: 'next_decision' });
      }
    }
    expect(interactive.weekend?.liveRace).toBeNull();
    expect(interactive.weekend?.race?.classification).toEqual(automatic.weekend?.race?.classification);
  });

  it('continues with one player retirement and only accepts running eligible choices', () => {
    const started = act(raceReady(), { type: 'START_RACE', kind: 'race' });
    const live = started.weekend!.liveRace!;
    const retired = Object.values(live.cars).find(c => c.player)!;
    retired.status = 'dnf'; retired.reason = 'test';
    const running = Object.values(live.cars).find(c => c.player && c.status === 'running')!;
    const result = act(started, { type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision!.id, drivers: [{ driverId: running.driverId, pit: 'auto' }] });
    expect(result.weekend!.liveRace?.pendingDecision).toBeNull();
    expect(result.weekend!.liveRace?.cars[retired.driverId].status).toBe('dnf');
  });

  it('allows tactical updates after a teammate retires by submitting running cars only', () => {
    const launched = act(raceReady(), { type: 'START_RACE', kind: 'race' });
    const grid = launched.weekend!.liveRace!;
    const started = act(launched, { type: 'RESOLVE_RACE_DECISION', sessionId: grid.id, expectedRevision: grid.revision, windowId: grid.pendingDecision!.id, drivers: Object.values(grid.cars).filter(c => c.player).map(c => ({ driverId: c.driverId, pit: 'auto' })) });
    const live = started.weekend!.liveRace!;
    const retired = Object.values(live.cars).find(c => c.player)!;
    retired.status = 'dnf';
    const running = Object.values(live.cars).find(c => c.player && c.status === 'running')!;
    const outcome = tryAct(started, { type: 'SET_RACE_TACTICS', sessionId: live.id, expectedRevision: live.revision, drivers: [{ driverId: running.driverId, paceMode: 'push', energyMode: 'deploy', pitTiming: 'early' }] });
    expect(outcome.ok).toBe(true);
    expect(outcome.state.weekend!.liveRace!.cars[running.driverId].plan.paceMode).toBe('push');
  });

  it('migrates trust, ego, and stay-out state into an already active session', () => {
    const started = act(raceReady(), { type: 'START_RACE', kind: 'race' });
    const live = started.weekend!.liveRace!;
    const car = Object.values(live.cars)[0] as any;
    delete car.trust; delete car.ego; delete car.stayOutUntilLap;
    migrateState(started);
    expect(car.trust).toBe(started.drivers[car.driverId].trust);
    expect(car.ego).toBe(started.drivers[car.driverId].ego);
    expect(car.stayOutUntilLap).toBe(0);
  });

  it('does not change tyre without a valid box choice and rejects invalid option values', () => {
    const started = act(raceReady(), { type: 'START_RACE', kind: 'race' });
    const live = started.weekend!.liveRace!;
    const car = Object.values(live.cars).find(c => c.player)!;
    const before = car.tyre;
    const invalid = tryAct(started, { type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision!.id, drivers: [{ driverId: car.driverId, pit: 'auto', compound: 'W' }] });
    expect(invalid.ok).toBe(false);
    expect(started.weekend!.liveRace!.cars[car.driverId].tyre).toBe(before);
    const badMode = tryAct(started, { type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision!.id, drivers: [{ driverId: car.driverId, pit: 'auto', paceMode: 'warp' as never }] });
    expect(badMode.ok).toBe(false);
  });

  it('keeps forecast uncertainty independent from the hidden five-lap weather path', () => {
    const dry = [0, 0, 0, 0, 0];
    const forecasts = Array.from({ length: 16 }, (_, i) => createForecast(dry, 0, 0, new Rng(i + 1)));
    expect(forecasts.some(f => f.arrivalLaps !== null)).toBe(true);
    expect(forecasts.some(f => f.rainProbability > 0)).toBe(true);
  });

  it('restores an exact zero RNG state', () => {
    const rng = Rng.restore(0);
    expect(rng.state).toBe(0);
    rng.next();
    expect(rng.state).not.toBe(0);
  });
});
