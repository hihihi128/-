import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/engine/rng';
import { createWeekend, runPractice, runQualifying } from '../../src/engine/weekend';
import { act, newTestGame } from '../helpers';

describe('比赛周末性能数据生命周期', () => {
  it('新周末继承策略偏好时清除上一站副 API 点评', () => {
    const state = newTestGame(918);
    const first = createWeekend(state, new Rng(1));
    state.weekend = first;
    first.plans.c1.strategyReview = {
      source: 'secondary', originalPlan: { tyrePlan: ['soft', 'medium'], paceMode: 'balanced', pitTiming: 'standard', scReaction: true },
      summary: '上一站点评', issues: [], modelLabel: 'v2', roundKey: '2026:r1',
    };
    state.season.roundIndex += 1;
    const next = createWeekend(state, new Rng(2));
    expect(next.plans.c1.strategyReview).toBeUndefined();
    expect(next.plans.c1.tyrePlan).toBe('auto');
  });

  it('练习收益记录的是 clamp 后真实增加量', () => {
    const state = newTestGame(919);
    state.weekend = createWeekend(state, new Rng(3));
    Object.assign(state.weekend.setup.c1, { confidence: 100, tyreKnowledge: 100, thermalKnowledge: 100, trackKnowledge: 100, qualiBonus: state.rules.performance.qualiBonusMax });
    const result = runPractice(state, new Rng(4));
    expect(result.gains.c1).toMatchObject({ setup: 0, tyre: 0, thermal: 0, track: 0, quali: 0 });
  });

  it('练习赛使用玩家选择的轮胎和调校方向', () => {
    let state = newTestGame(920);
    state.weekend = createWeekend(state, new Rng(5));
    state.weekend.weather.practice = 'dry';
    state.season.phase = 'practice';
    state = act(state, { type: 'SET_PLAN', driverId: 'c1', plan: { practiceTyre: 'hard', practiceSetupFocus: 'tyre_prep' } });
    const result = runPractice(state, new Rng(6));
    expect(result.timesheet.find(entry => entry.driverId === 'c1')).toMatchObject({ compound: 'hard', tyreStartedNew: true });
    expect(state.weekend!.plans.c1).toMatchObject({ practiceTyre: 'hard', practiceSetupFocus: 'tyre_prep' });
  });

  it('排位赛消耗实体轮胎并记录每次使用的新旧状态', () => {
    const state = newTestGame(921);
    state.weekend = createWeekend(state, new Rng(7));
    state.weekend.weather.qualifying = 'dry';
    const team = state.teams[state.meta.playerTeamId];
    const before = team.tyreInventory!.c1.filter(set => set.compound === 'soft' && set.state === 'new').length;
    const result = runQualifying(state, new Rng(8), 'qualifying');
    const runs = result.sessions.flatMap(session => session.entries.find(entry => entry.driverId === 'c1')?.tyreRuns ?? []);
    expect(runs).toHaveLength(6);
    expect(runs.every(run => run.compound === 'soft' && run.lapsAdded === 3)).toBe(true);
    expect(runs[0]).toMatchObject({ startedNew: true, lapsBefore: 0 });
    expect(team.tyreInventory!.c1.filter(set => set.compound === 'soft' && set.state === 'new')).toHaveLength(before - 6);
    expect(team.tyreInventory!.c1.filter(set => runs.some(run => run.setId === set.id)).every(set => set.state === 'used' && set.laps === 3)).toBe(true);
  });
});
