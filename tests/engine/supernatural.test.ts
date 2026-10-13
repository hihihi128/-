import { createWeekend } from '../../src/engine/weekend';
import { Rng } from '../../src/engine/rng';
import { applySupernaturalCommands, parseSupernaturalCommands } from '../../src/engine/supernatural';
import { migrateState } from '../../src/engine/migrate';
import { buildView } from '../../src/engine/view';
import { newTestGame } from '../helpers';
import { describe, expect, it } from 'vitest';

describe('超自然干预协议', () => {
  function enabled() {
    const state = newTestGame(101);
    state.meta.supernaturalMode = true;
    return state;
  }

  it('is opt-in, accepts only one strict envelope, and does not touch RNG', () => {
    const state = enabled();
    const rng = state.rng;
    expect(parseSupernaturalCommands('<F1M_UPDATE>[{"op":"morale","driver":"c1","delta":2}]</F1M_UPDATE>').error).toBeNull();
    expect(parseSupernaturalCommands('<F1M_UPDATE>[]</F1M_UPDATE><F1M_UPDATE>[]</F1M_UPDATE>').error).toBeTruthy();
    expect(parseSupernaturalCommands('<F1M_UPDATE>{}</F1M_UPDATE>').error).toBeTruthy();
    const result = applySupernaturalCommands(state, [{ op: 'morale', driver: 'c1', delta: 3, reason: '重置' }], 'test');
    expect(result.changed).toBe(true);
    expect(state.rng).toBe(rng);
    expect(result.logs[0]).toMatchObject({ source: 'supernatural', invocationId: 'test', applied: 3 });
  });

  it('rejects numeric strings, extra fields, other teams, and oversized batches', () => {
    const state = enabled();
    const before = state.drivers.c1.morale;
    const result = applySupernaturalCommands(state, [
      { op: 'morale', driver: 'c1', delta: '5' },
      { op: 'morale', driver: 'c1', delta: 5, extra: true },
      { op: 'morale', driver: 'a1', delta: 5 },
    ], 'test');
    expect(result.changed).toBe(false);
    expect(state.drivers.c1.morale).toBe(before);
    expect(result.logs.every(log => !log.ok)).toBe(true);
    expect(parseSupernaturalCommands(`<F1M_UPDATE>${JSON.stringify(Array.from({ length: 9 }, () => ({ op: 'board', delta: 1 })))}</F1M_UPDATE>`).error).toContain('最多');
  });

  it('enforces absolute per-invocation budgets and persistent bounds', () => {
    const state = enabled();
    const result = applySupernaturalCommands(state, [
      { op: 'morale', driver: 'c1', delta: 8 },
      { op: 'morale', driver: 'c1', delta: -8 },
      { op: 'morale', driver: 'c1', delta: 8 },
      { op: 'driver_attr', driver: 'c1', attr: 'pace', delta: 1 },
      { op: 'driver_attr', driver: 'c1', attr: 'wet', delta: 1 },
      { op: 'funds', delta: 10 },
    ], 'test');
    expect(result.logs.filter(log => log.ok).map(log => log.applied)).toEqual([8, -2, 1, 3]);
    expect(state.drivers.c1.attrs.pace).toBeLessThanOrEqual(100);
    expect(state.teams.team_c.funds).toBeLessThanOrEqual(500);
  });

  it('limits research, stores weather only before weekend, and keeps setup temporary', () => {
    const state = enabled();
    const project = state.teams.team_c.projects.find(item => item.kind === 'design');
    if (!project) {
      state.teams.team_c.projects.push({ id: 'design', kind: 'design', label: '设计', cost: 1, weeksTotal: 3, weeksLeft: 3, startedAt: 'now' });
    }
    const design = state.teams.team_c.projects.find(item => item.kind === 'design')!;
    let result = applySupernaturalCommands(state, [
      { op: 'research_progress', projectId: design.id, weeks: 4 },
      { op: 'weather_tendency', delta: .1 },
    ], 'test');
    expect(design.weeksLeft).toBe(2);
    expect(state.supernatural.pendingWeather?.rainBias).toBe(.1);
    state.weekend = createWeekend(state, new Rng(state.rng));
    expect(state.supernatural.pendingWeather).toBeNull();
    expect(state.weekend.supernaturalRainBias).toBe(.1);
    result = applySupernaturalCommands(state, [{ op: 'car_setup', driver: 'c1', field: 'confidence', delta: 12 }], 'test');
    expect(result.changed).toBe(true);
    expect(state.weekend.setup.c1.confidence).toBeLessThanOrEqual(100);
    expect(state.weekend.supernaturalCarEffects?.c1.confidence).toBe(10);
  });

  it('moves legacy debt and over-limit funds only by the requested bounded amount', () => {
    const debt = enabled();
    debt.teams.team_c.funds = -10;
    applySupernaturalCommands(debt, [{ op: 'funds', delta: 3 }], 'test');
    expect(debt.teams.team_c.funds).toBe(-7);

    const overLimit = enabled();
    overLimit.teams.team_c.funds = 502;
    applySupernaturalCommands(overLimit, [{ op: 'funds', delta: -1 }], 'test');
    expect(overLimit.teams.team_c.funds).toBe(501);
  });

  it('uses one total research week and staffAbility fallback for risk', () => {
    const state = enabled();
    const team = state.teams.team_c;
    team.projects.push({ id: 'design', kind: 'design', label: '设计', cost: 1, weeksTotal: 4, weeksLeft: 4, startedAt: 'now' });
    const strategist = team.staff.strategist;
    delete strategist.abilities;
    const result = applySupernaturalCommands(state, [
      { op: 'research_progress', projectId: 'design', weeks: 1 },
      { op: 'research_progress', projectId: 'design', weeks: 1 },
      { op: 'staff_skill', staffId: strategist.id!, field: 'risk', delta: 1 },
    ], 'test');
    expect(team.projects.find(project => project.id === 'design')?.weeksLeft).toBe(3);
    expect(result.logs.filter(log => log.op === 'research_progress' && log.ok)).toHaveLength(1);
    expect((strategist.abilities as Record<string, number> | undefined)?.risk).toBe(71);
  });

  it('permits round-two pre-race weather despite a stale round-one weekend', () => {
    const state = enabled();
    state.weekend = createWeekend(state, new Rng(state.rng));
    state.season.roundIndex = 1;
    state.season.phase = 'pre_race';
    const result = applySupernaturalCommands(state, [{ op: 'weather_tendency', delta: .1 }], 'test');
    expect(result.changed).toBe(true);
    expect(state.supernatural.pendingWeather).toEqual({ year: state.season.year, roundIndex: 1, rainBias: .1 });
    expect(buildView(state).supernatural.categories.weather).toMatchObject({ available: true, reason: null });
    expect(buildView(state).supernatural.categories.setup.available).toBe(false);
  });

  it('never reverses setup direction when an inherited effect is saturated', () => {
    const state = enabled();
    state.weekend = createWeekend(state, new Rng(state.rng));
    state.weekend.setup.c1.confidence = 100;
    state.weekend.supernaturalCarEffects = { c1: { confidence: 5, tyreKnowledge: 0 } };
    const result = applySupernaturalCommands(state, [{ op: 'car_setup', driver: 'c1', field: 'confidence', delta: 5 }], 'test');
    expect(result.changed).toBe(false);
    expect(state.weekend.supernaturalCarEffects.c1.confidence).toBe(5);
    expect(result.logs[0].applied).toBeNull();
  });

  it('repairs malformed primitive supernatural state during migration', () => {
    const state = enabled();
    (state as unknown as { supernatural: unknown }).supernatural = 3;
    expect(() => migrateState(state)).not.toThrow();
    expect(state.supernatural).toEqual({ pendingWeather: null });
  });

  it('reports a clear global unavailability reason after season end', () => {
    const state = enabled();
    state.season.phase = 'season_end';
    expect(buildView(state).supernatural).toMatchObject({ available: false, reason: '赛季已经结束，不能干预' });
  });
});
