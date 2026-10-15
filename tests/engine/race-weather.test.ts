import { describe, expect, it } from 'vitest';
import { createPreRaceRainWindow } from '../../src/engine/raceWeather';
import { DEFAULT_RULES } from '../../src/engine/defaults';
import { requiresWetGridTyreChoice, tyreWeatherPenalty, wetCompoundFor } from '../../src/engine/race';
import { Rng } from '../../src/engine/rng';

describe('赛前公开降雨窗口', () => {
  it('由隐藏轨迹加噪生成，且同一随机种子可复现', () => {
    const trajectory = [...Array(9).fill(0), ...Array(31).fill(0.7)];
    const first = createPreRaceRainWindow(trajectory, 0.72, 80, new Rng(123));
    const second = createPreRaceRainWindow(trajectory, 0.72, 80, new Rng(123));
    expect(first).toEqual(second);
    expect(first).not.toBeNull();
    expect(first![0]).toBeGreaterThanOrEqual(1);
    expect(first![1]).toBeLessThanOrEqual(trajectory.length);
    expect(first![0]).toBeLessThanOrEqual(first![1]);
    expect(first![1]).toBeGreaterThan(first![0]);
  });

  it('允许无雨轨迹没有公开降雨窗口', () => {
    expect(createPreRaceRainWindow(Array(40).fill(0), 0, 95, new Rng(1))).toBeNull();
  });
});

describe('半雨胎与全雨胎', () => {
  it('按积水程度选择对应雨胎', () => {
    expect(DEFAULT_RULES.tyres[DEFAULT_RULES.wetCompound].name).toBe('半雨胎');
    expect(DEFAULT_RULES.tyres[DEFAULT_RULES.fullWetCompound].name).toBe('全雨胎');
    expect(wetCompoundFor(DEFAULT_RULES, .45)).toBe(DEFAULT_RULES.wetCompound);
    expect(wetCompoundFor(DEFAULT_RULES, .9)).toBe(DEFAULT_RULES.fullWetCompound);
  });

  it('只在零圈湿地发车使用积水阈值，而非当前雨强', () => {
    expect(requiresWetGridTyreChoice({ stage: 'grid', completedLaps: 0, wetness: .219 })).toBe(false);
    expect(requiresWetGridTyreChoice({ stage: 'grid', completedLaps: 0, wetness: .22 })).toBe(true);
    expect(requiresWetGridTyreChoice({ stage: 'ready', completedLaps: 0, wetness: 1 })).toBe(false);
    expect(requiresWetGridTyreChoice({ stage: 'grid', completedLaps: 1, wetness: 1 })).toBe(false);
  });

  it('半雨胎适合潮湿赛道，全雨胎适合严重积水', () => {
    const inter = DEFAULT_RULES.wetCompound;
    const fullWet = DEFAULT_RULES.fullWetCompound;
    expect(tyreWeatherPenalty(DEFAULT_RULES, inter, .4)).toBeLessThan(tyreWeatherPenalty(DEFAULT_RULES, fullWet, .4));
    expect(tyreWeatherPenalty(DEFAULT_RULES, fullWet, .85)).toBeLessThan(tyreWeatherPenalty(DEFAULT_RULES, inter, .85));
    expect(tyreWeatherPenalty(DEFAULT_RULES, 'medium', .85)).toBeGreaterThan(tyreWeatherPenalty(DEFAULT_RULES, fullWet, .85));
  });
});
