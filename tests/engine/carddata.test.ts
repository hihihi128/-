import { describe, expect, it } from 'vitest';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { carRatings, raceSkill } from '../../src/engine/ratings';
import type { Database } from '../../src/engine/types';
import { advanceUntil, cardSources } from '../helpers';

/** 角色卡实际携带的 2026 真实车队与车手数据 */
function cardDb(): Database {
  const res = normalizeDatabase(cardSources());
  expect(res.issues).toEqual([]);
  expect(res.canStart).toBe(true);
  return res.db!;
}

/** 2026 赛季实测：相对梅赛德斯的平均单圈差距（秒） */
const REAL_GAPS: Record<string, number> = {
  ferrari: 0.422,
  mclaren: 0.502,
  red_bull: 0.676,
  alpine: 1.657,
  audi: 1.866,
  racing_bulls: 1.877,
  haas: 2.242,
  williams: 2.454,
  cadillac: 3.676,
  aston_martin: 3.783,
};

const PU_SUPPLIERS: Record<string, string[]> = {
  mercedes: ['mclaren', 'williams', 'alpine'],
  red_bull: ['racing_bulls'],
  ferrari: ['haas', 'cadillac'],
};

describe('角色卡数据：2026 真实阵容', () => {
  it('读取时没有错误或警告', () => {
    cardDb();
  });

  it('11 支车队，每队 2 名正式车手，车号不重复', () => {
    const db = cardDb();
    expect(db.teams).toHaveLength(11);
    const race = db.drivers.filter(d => d.role === 'race');
    expect(race).toHaveLength(22);
    for (const t of db.teams) expect(race.filter(d => d.teamId === t.id)).toHaveLength(2);
    expect(new Set(db.drivers.map(d => d.number)).size).toBe(db.drivers.length);
    expect(db.drivers.every(d => d.teamId === null || db.teams.some(t => t.id === d.teamId))).toBe(true);
  });

  it('使用完整 2026 赛历与六场冲刺赛', () => {
    const db = cardDb();
    expect(db.calendar).toHaveLength(24);
    expect(db.tracks).toHaveLength(24);
    expect(db.calendar[0]).toMatchObject({ trackId: 'melbourne', sprint: false });
    expect(db.calendar.at(-1)).toMatchObject({ trackId: 'yas_marina', sprint: false });
    expect(db.calendar.filter(round => round.sprint).map(round => round.trackId)).toEqual(['shanghai', 'miami', 'montreal', 'silverstone', 'zandvoort', 'singapore']);
  });

  it('法拉利保留特殊机制与两位车手', () => {
    const db = cardDb();
    expect(db.teams.find(t => t.id === 'ferrari')!.special).toBe('ferrari');
    for (const id of ['hamilton', 'leclerc']) {
      const d = db.drivers.find(x => x.id === id)!;
      expect(d.teamId).toBe('ferrari');
      expect(d.role).toBe('race');
    }
  });

  it('同一供应商的客户车队使用同一规格的动力单元', () => {
    const db = cardDb();
    const team = (id: string) => db.teams.find(t => t.id === id)!;
    for (const [works, customers] of Object.entries(PU_SUPPLIERS)) {
      for (const c of customers) {
        expect(team(c).parts.power_unit, `${c} 内燃机`).toEqual(team(works).parts.power_unit);
        expect(team(c).parts.ers, `${c} 能量回收系统`).toEqual(team(works).parts.ers);
      }
    }
  });

  it('平均单圈差距符合 2026 实测（误差 < 0.05 秒）', () => {
    const state = createGame(cardDb(), { playerTeamId: 'ferrari', principalName: '测试', seed: 1, gameId: 'g', now: 1 });
    const r = (id: string) => carRatings(state.teams[id], state.teams[id].cars[0], state.rules);
    // 均衡赛道上的单圈损失：赛车综合分与车手正赛能力（两台车平均）
    const loss = (id: string) => {
      const t = state.teams[id];
      const per = t.cars.map(
        c => (100 - carRatings(t, c, state.rules).overall) * state.rules.secPerCarPoint + (100 - raceSkill(state.drivers[c.driverId!], false)) * state.rules.secPerDriverPoint,
      );
      return per.reduce((a, b) => a + b, 0) / per.length;
    };
    for (const [id, gap] of Object.entries(REAL_GAPS)) {
      expect(loss(id) - loss('mercedes'), id).toBeCloseTo(gap, 1);
    }
    // 动力单元排序：梅赛德斯 > 法拉利 > 红牛-福特 > 奥迪 > 本田
    const pu = (id: string) => state.teams[id].parts.power_unit.specs[0].perf;
    const order = ['mercedes', 'ferrari', 'red_bull', 'audi', 'aston_martin'].map(pu);
    expect([...order].sort((x, y) => y - x)).toEqual(order);
    expect(r('ferrari').downforce).toBeGreaterThan(r('williams').downforce);
    // 阿斯顿·马丁-本田可靠性全场最差
    const rel = Object.keys(state.teams).sort((a, b) => r(a).reliability - r(b).reliability);
    expect(rel[0]).toBe('aston_martin');
  });

  it.each(['mercedes', 'ferrari', 'cadillac'])('以 %s 开局可以跑完第一站', teamId => {
    const s = advanceUntil(
      createGame(cardDb(), { playerTeamId: teamId, principalName: '测试', seed: 7, gameId: 'g', now: 1 }),
      x => x.season.phase === 'post_race',
    );
    expect(Object.values(s.standings.drivers).reduce((a, d) => a + d.points, 0)).toBeGreaterThan(0);
  });
});
