import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/engine/rng';
import { createWeekend, runPractice } from '../../src/engine/weekend';
import { newTestGame } from '../helpers';

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
});
