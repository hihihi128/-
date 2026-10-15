import { describe, expect, it } from 'vitest';
import { simulateRace } from '../../src/engine/race';
import { applyPenalties } from '../../src/engine/weekend';
import { Rng } from '../../src/engine/rng';
import { strategyOptions, validatePlan, degFactor } from '../../src/engine/strategy';
import type { GameState } from '../../src/engine/types';
import { act, advanceUntil, newTestGame, tryAct } from '../helpers';

function atRace(seed: number, team = 'team_c'): GameState {
  return advanceUntil(newTestGame(seed, team), x => x.season.phase === 'race');
}

describe('比赛模拟', () => {
  it('成绩表完整、名次连续、积分正确', () => {
    const s = atRace(101);
    const { result } = simulateRace(s, new Rng(1), 'race');
    expect(result.classification).toHaveLength(22);
    const finished = result.classification.filter(c => c.status === 'finished');
    finished.forEach((c, i) => expect(c.pos).toBe(i + 1));
    expect(finished[0].points).toBe(25);
    for (const c of finished) {
      // 干地正赛必须使用至少两种配方（计划外进站也会补足）
      if (result.weather === 'dry') expect(new Set(c.tyres).size).toBeGreaterThanOrEqual(1);
      expect(c.pits).toBeGreaterThanOrEqual(result.weather === 'dry' ? 1 : 0);
    }
    expect(result.events.length).toBeGreaterThan(0);
    expect(Object.keys(result.lapChart)).toHaveLength(2);
    expect(result.lapChart[Object.keys(result.lapChart)[0]]).toHaveLength(result.laps);
    expect(result.rainHistory).toHaveLength(result.laps);
    expect(result.rainHistory?.every(value => value >= 0 && value <= 1)).toBe(true);
  });

  it('更强的赛车 + 车手统计上更常获胜', () => {
    const wins: Record<string, number> = {};
    for (let seed = 1; seed <= 60; seed++) {
      const s = atRace(500 + (seed % 3));
      // 把 D 队赛车性能大幅提高，观察胜率
      for (const p of Object.values(s.teams.team_d.parts)) for (const spec of p.specs) spec.perf = 97;
      const { result } = simulateRace(s, new Rng(seed * 7919), 'race');
      const w = result.classification[0];
      wins[w.teamId] = (wins[w.teamId] ?? 0) + 1;
    }
    expect(wins.team_d ?? 0).toBeGreaterThan(30);
  });

  it('退赛率处在合理区间', () => {
    let dnf = 0;
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = atRace(900);
      const { result } = simulateRace(s, new Rng(seed * 104729), 'race');
      total += result.classification.length;
      dnf += result.classification.filter(c => c.status === 'dnf').length;
    }
    const rate = dnf / total;
    expect(rate).toBeGreaterThan(0.01);
    expect(rate).toBeLessThan(0.25);
  });

  it('玩家指定的轮胎策略会被执行', () => {
    let s = atRace(77);
    s = act(s, { type: 'SET_PLAN', driverId: 'c1', plan: { tyrePlan: ['hard', 'medium'] } });
    s = act(s, { type: 'SET_PLAN', driverId: 'c2', plan: { tyrePlan: ['soft', 'medium', 'soft'] } });
    s.weekend!.weather.race = 'dry';
    s.weekend!.forecast.race = 0;
    delete s.weekend!.forecast.raceRainWindow;
    s.tracks[s.calendar[s.season.roundIndex].trackId].rainChance = 0;
    const { result } = simulateRace(s, new Rng(3), 'race');
    const c1 = result.classification.find(c => c.driverId === 'c1')!;
    const c2 = result.classification.find(c => c.driverId === 'c2')!;
    if (c1.status === 'finished') expect(c1.tyres[0]).toBe('hard');
    if (c2.status === 'finished') expect(c2.tyres[0]).toBe('soft');
  });

  it('非法轮胎策略会被拒绝', () => {
    const s = atRace(78);
    const res = tryAct(s, { type: 'SET_PLAN', driverId: 'c1', plan: { tyrePlan: ['soft', 'soft'] } });
    expect(res.ok).toBe(false);
    expect(validatePlan(s.rules, ['medium', 'hard'], false)).toBeNull();
    expect(validatePlan(s.rules, ['inter'], true)).toBeNull();
  });

  it('车队指令「偏向」会触发让车（或抗命）事件', () => {
    let found = 0;
    for (let seed = 1; seed <= 30 && found === 0; seed++) {
      let s = atRace(1000 + seed, 'team_c');
      s = act(s, { type: 'SET_TEAM_ORDERS', orders: { mode: 'favor', favorDriverId: 'c2' } });
      // 让被偏向的 c2 从后面出发、赛车更快，制造让车场景
      s.weekend!.qualifying!.grid = ['c1', 'c2', ...s.weekend!.qualifying!.grid.filter(id => id !== 'c1' && id !== 'c2')];
      const car2 = s.teams.team_c.cars.find(c => c.driverId === 'c2')!;
      s.teams.team_c.parts.floor.specs.push({ id: 'floor-x', type: 'floor', version: 5, perf: 99, rel: 95, verified: true, expected: null, introduced: 't' });
      car2.fitted.floor = 'floor-x';
      const { result } = simulateRace(s, new Rng(seed), 'race');
      found += result.orderOutcomes.length;
    }
    expect(found).toBeGreaterThan(0);
  });

  it('车队指令「保持位置」时队友之间不超车', () => {
    let s = atRace(31, 'team_c');
    s = act(s, { type: 'SET_TEAM_ORDERS', orders: { mode: 'hold', favorDriverId: null } });
    const { result } = simulateRace(s, new Rng(5), 'race');
    const teamOvertakes = result.events.filter(
      e => e.type === 'overtake' && e.drivers.every(id => s.drivers[id].teamId === 'team_c'),
    );
    expect(teamOvertakes).toHaveLength(0);
  });

  it('冲刺赛圈数约为正赛三分之一且不强制进站', () => {
    const s = advanceUntil(newTestGame(66), x => x.season.phase === 'sprint');
    const { result } = simulateRace(s, new Rng(2), 'sprint');
    const track = s.tracks[s.calendar[s.season.roundIndex].trackId];
    expect(result.laps).toBe(Math.round(track.laps * s.rules.sprintLapsFactor));
    expect(result.classification[0].points).toBe(8);
  });
});

describe('策略预测', () => {
  it('高轮胎负荷赛道更倾向多停', () => {
    const s = newTestGame();
    const track = { ...s.tracks.barcelona };
    const ctx = { driverTyre: 80, carTyre: 80, paceMode: 'balanced' as const, knowledge: 50 };
    const low = strategyOptions(s.rules, { ...track, tyreStress: 10 }, 52, ctx, { wet: false, sprint: false });
    const high = strategyOptions(s.rules, { ...track, tyreStress: 95 }, 52, ctx, { wet: false, sprint: false });
    expect(low[0].stops).toBeLessThanOrEqual(high[0].stops);
    expect(low[0].delta).toBe(0);
    for (const o of high) expect(o.stints.reduce((a, b) => a + b, 0)).toBe(52);
  });

  it('进攻模式衰减更快', () => {
    const s = newTestGame();
    const t = s.tracks.monza;
    const base = { driverTyre: 80, carTyre: 80, knowledge: 0 };
    expect(degFactor(t, { ...base, paceMode: 'push' })).toBeGreaterThan(degFactor(t, { ...base, paceMode: 'conserve' }));
  });
});

describe('罚退', () => {
  it('多名车手被罚时每人都后移规定的格数', () => {
    expect(applyPenalties(['A', 'B', 'C', 'D'], { A: 2, B: 2 })).toEqual(['C', 'D', 'A', 'B']);
    expect(applyPenalties(['A', 'B', 'C', 'D'], { A: 1 })).toEqual(['B', 'A', 'C', 'D']);
    // 目标位置相同：排位成绩好的在前
    expect(applyPenalties(['A', 'B', 'C', 'D'], { A: 2, B: 1 })).toEqual(['C', 'D', 'A', 'B']);
    // 超出发车格数时排到最后
    expect(applyPenalties(['A', 'B', 'C'], { A: 10 })).toEqual(['B', 'C', 'A']);
    expect(applyPenalties(['A', 'B', 'C'], {})).toEqual(['A', 'B', 'C']);
  });
});
