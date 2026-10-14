import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../src/engine/defaults';
import { practiceEffects, stepTyre } from '../../src/engine/performance';
import type { RacePerformanceContext, SetupState } from '../../src/engine/types';
const setup: SetupState = { confidence: 80, tyreKnowledge: 70, thermalKnowledge: 70, trackKnowledge: 50, qualiBonus: .1 };
const context: RacePerformanceContext = { driverTyre: 80, carTyre: 80, setup, trackFit: 60, trackScore: 80, surfaceTemperature: 42, thermalDemand: 80 };

describe('统一性能模型', () => {
  it('调校收益受上限约束，排位模拟收益累积', () => {
    const first = practiceEffects(setup, DEFAULT_RULES, 60);
    expect(first.quali).toBeGreaterThan(first.race);
    expect(first.quali).toBeLessThanOrEqual(DEFAULT_RULES.performance.qualiSetupMax + DEFAULT_RULES.performance.qualiBonusMax);
    expect(first.wearMultiplier).toBeLessThan(1);
  });

  it('胎温从冷胎收敛，过热同时增加磨损且结果确定', () => {
    const tyre = DEFAULT_RULES.tyres.soft;
    const cold = stepTyre(context, tyre, { temperature: 45, wearAge: 0 }, { paceMode: 'balanced' }, DEFAULT_RULES);
    const repeat = stepTyre(context, tyre, { temperature: 45, wearAge: 0 }, { paceMode: 'balanced' }, DEFAULT_RULES);
    const hot = stepTyre(context, tyre, { temperature: 140, wearAge: 0 }, { paceMode: 'push' }, DEFAULT_RULES);
    expect(cold).toEqual(repeat);
    expect(cold.temperature).toBeGreaterThan(45);
    expect(cold.wearAge).toBeGreaterThan(0);
    expect(hot.state).toBe('hot');
    expect(hot.wearMultiplier).toBeGreaterThan(cold.wearMultiplier);
    expect(Number.isFinite(hot.lapPenalty)).toBe(true);
  });

  it('安全车目标会冷却轮胎而不产生负磨损', () => {
    const racing = stepTyre(context, DEFAULT_RULES.tyres.medium, { temperature: 100, wearAge: 5 }, { paceMode: 'push' }, DEFAULT_RULES);
    const neutral = stepTyre(context, DEFAULT_RULES.tyres.medium, { temperature: 100, wearAge: 5 }, { paceMode: 'push', neutral: true }, DEFAULT_RULES);
    expect(neutral.temperature).toBeLessThan(racing.temperature);
    expect(neutral.wearAge).toBeGreaterThanOrEqual(5);
  });
});
