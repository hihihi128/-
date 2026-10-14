import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../src/engine/defaults';
import { practiceEffects, stepTyre } from '../../src/engine/performance';
import { PACE_MODE_TIME, stintLoss, tyreLapDelta } from '../../src/engine/strategy';
import type { RacePerformanceContext, SetupState } from '../../src/engine/types';
const setup: SetupState = { confidence: 80, tyreKnowledge: 70, thermalKnowledge: 70, trackKnowledge: 50, qualiBonus: .1 };
const context: RacePerformanceContext = { driverTyre: 80, carTyre: 80, setup, trackFit: 60, trackScore: 80, surfaceTemperature: 42, thermalDemand: 80, tyreStress: 80 };

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

  it('保留赛道胎耗负荷，并统一预测与逐圈步进的冷胎起点', () => {
    const lowStress = { ...context, tyreStress: 20 };
    const highStress = { ...context, tyreStress: 90 };
    expect(stepTyre(highStress, DEFAULT_RULES.tyres.medium, {}, { paceMode: 'balanced' }, DEFAULT_RULES).wearMultiplier)
      .toBeGreaterThan(stepTyre(lowStress, DEFAULT_RULES.tyres.medium, {}, { paceMode: 'balanced' }, DEFAULT_RULES).wearMultiplier);
    let previous: { temperature?: number; wearAge?: number } = { temperature: DEFAULT_RULES.tyres.medium.temperatureWindow![0] - 18, wearAge: 0 };
    let actual = 0;
    for (let lap = 0; lap < 8; lap++) {
      const step = stepTyre(context, DEFAULT_RULES.tyres.medium, previous, { paceMode: 'push' }, DEFAULT_RULES);
      previous = step;
      actual += tyreLapDelta(DEFAULT_RULES.tyres.medium, step.wearAge, 1) + step.lapPenalty;
    }
    const predicted = stintLoss(DEFAULT_RULES.tyres.medium, 8, 1, { context, rules: DEFAULT_RULES, paceMode: 'push' });
    expect(predicted).toBeCloseTo(actual + 8 * PACE_MODE_TIME.push, 8);
  });

  it('硬胎温窗高于中性胎高于软胎，雨胎缺省时采用雨地窗口', () => {
    expect(DEFAULT_RULES.tyres.hard.temperatureWindow![0]).toBeGreaterThan(DEFAULT_RULES.tyres.medium.temperatureWindow![0]);
    expect(DEFAULT_RULES.tyres.medium.temperatureWindow![0]).toBeGreaterThan(DEFAULT_RULES.tyres.soft.temperatureWindow![0]);
    const missingWetWindow = { ...DEFAULT_RULES.tyres.wet, temperatureWindow: undefined };
    const step = stepTyre(context, missingWetWindow, {}, { paceMode: 'balanced', wetness: 1 }, DEFAULT_RULES);
    expect(step.temperature).toBeGreaterThan(40); // 58°C 雨胎低温起点 - 18°C 后开始暖胎
  });

  it('赛道知识只缓解差适配，绝不稀释好适配收益', () => {
    const inexperienced = { ...setup, trackKnowledge: 0 };
    const prepared = { ...setup, trackKnowledge: 100 };
    expect(practiceEffects(prepared, DEFAULT_RULES, 25).race).toBeGreaterThan(practiceEffects(inexperienced, DEFAULT_RULES, 25).race);
    expect(practiceEffects(prepared, DEFAULT_RULES, 80)).toEqual(practiceEffects(inexperienced, DEFAULT_RULES, 80));
  });
});
