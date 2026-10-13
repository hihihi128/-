import { describe, expect, it } from 'vitest';
import { buildView } from '../../src/engine/view';
import { act, advanceUntil, newTestGame, tryAct } from '../helpers';

describe('开局', () => {
  it('生成合法的初始存档', () => {
    const s = newTestGame();
    expect(s.season.phase).toBe('preseason');
    expect(Object.keys(s.teams)).toHaveLength(11);
    expect(s.teams.team_c.isPlayer).toBe(true);
    for (const t of Object.values(s.teams)) {
      expect(t.cars).toHaveLength(2);
      for (const c of t.cars) expect(Object.keys(c.fitted)).toHaveLength(Object.keys(s.rules.parts).length);
    }
    // 替补车手不占车
    expect(s.teams.team_a.cars.map(c => c.driverId)).toEqual(['a1', 'a2']);
    expect(Object.keys(s.standings.drivers)).toHaveLength(24);
    expect(s.narration.length).toBeGreaterThan(0);
    // 存档是纯 JSON
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('完整赛季流程', () => {
  it('ADVANCE 可以跑完整个赛季并进入新赛季', () => {
    let s = newTestGame(777);
    const phases: string[] = [s.season.phase];
    s = advanceUntil(s, x => {
      if (phases[phases.length - 1] !== x.season.phase) phases.push(x.season.phase);
      return x.season.phase === 'season_end';
    });
    expect(phases).toEqual(
      expect.arrayContaining(['preseason', 'pre_race', 'practice', 'qualifying', 'race', 'post_race', 'sprint_qualifying', 'sprint', 'season_end']),
    );
    expect(s.history).toHaveLength(3);
    // 积分一致性：积分榜 = 历史成绩之和（含冲刺赛）
    for (const [id, st] of Object.entries(s.standings.drivers)) {
      const fromHistory = s.history.reduce((acc, h) => {
        const race = h.results.find(r => r[0] === id)?.[2] ?? 0;
        const spr = h.sprint?.find(r => r[0] === id)?.[2] ?? 0;
        return acc + race + spr;
      }, 0);
      expect(st.points).toBe(fromHistory);
    }
    const teamSum = Object.values(s.standings.teams).reduce((a, t) => a + t.points, 0);
    const driverSum = Object.values(s.standings.drivers).reduce((a, d) => a + d.points, 0);
    expect(teamSum).toBe(driverSum);
    expect(s.lastSeason?.driverChampion).toBeTruthy();

    const next = act(s, { type: 'START_NEXT_SEASON' });
    expect(next.season.year).toBe(s.season.year + 1);
    expect(next.season.phase).toBe('preseason');
    expect(next.history).toHaveLength(0);
    expect(Object.values(next.standings.drivers).every(d => d.points === 0)).toBe(true);
    expect(next.teams.team_c.costCapSpent).toBe(0);
  });

  it('同一存档 + 同一操作 → 同一结果（可复现）', () => {
    const run = () => advanceUntil(newTestGame(4242), x => x.season.phase === 'post_race');
    const a = run();
    const b = run();
    expect(a.weekend!.race!.classification).toEqual(b.weekend!.race!.classification);
    expect(a.rng).toBe(b.rng);
  });

  it('不同种子产生不同比赛', () => {
    const results = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = advanceUntil(newTestGame(seed), x => x.season.phase === 'post_race');
      results.add(s.weekend!.race!.classification.map(c => c.driverId).join(','));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it('阶段错误时拒绝动作并保留原存档', () => {
    const s = newTestGame();
    const res = tryAct(s, { type: 'RUN_RACE' });
    expect(res.ok).toBe(false);
    expect(res.state).toBe(s);
  });

  it('视图模型可以在每个阶段构建', () => {
    let s = newTestGame(99);
    for (let i = 0; i < 40 && s.season.phase !== 'season_end'; i++) {
      const v = buildView(s);
      expect(v.player.cars).toHaveLength(2);
      expect(v.standings.teams).toHaveLength(11);
      s = s.fiaMeeting?.current ? act(s, { type: 'FIA_DEBATE', stance: 'compromise' }) : act(s, { type: 'ADVANCE' });
    }
    const v = buildView(s);
    expect(v.season.phase).toBe('season_end');
    expect(v.next?.action.type).toBe('START_NEXT_SEASON');
  });

  it('未到来的场次天气不会提前公开', () => {
    let s = newTestGame(5);
    s = advanceUntil(s, x => x.season.phase === 'practice');
    const v = buildView(s);
    expect(v.weekend!.weather.practice).not.toBeNull();
    expect(v.weekend!.weather.race).toBeNull();
    s = advanceUntil(s, x => x.season.phase === 'race');
    expect(buildView(s).weekend!.weather.race).not.toBeNull();
  });
});
