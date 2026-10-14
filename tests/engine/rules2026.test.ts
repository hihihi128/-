import { describe, expect, it } from 'vitest';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { recordPuFit } from '../../src/engine/powerunit';
import { simulateRace } from '../../src/engine/race';
import { Rng } from '../../src/engine/rng';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { advanceUntil, newTestGame, placeholderDb, placeholderSources } from '../helpers';

describe('2026 规则', () => {
  it('排位赛：22 台车按 6/6/10 淘汰', () => {
    const s = advanceUntil(newTestGame(31), x => x.season.phase === 'race');
    const q = s.weekend!.qualifying!;
    expect(q.sessions.map(x => x.entries.length)).toEqual([22, 16, 10]);
    expect(q.sessions.map(x => x.entries.filter(e => e.eliminated).length)).toEqual([6, 6, 0]);
    expect(q.order).toHaveLength(22);
  });

  it('排位赛：qualiFinalists 可配置，车太少时只有一节', () => {
    const s = advanceUntil(newTestGame(31), x => x.season.phase === 'qualifying');
    s.rules.qualiFinalists = 21;
    const after = advanceUntil(s, x => x.season.phase === 'race');
    expect(after.weekend!.qualifying!.sessions).toHaveLength(1);
  });

  it('超车模式取代 DRS：加成越大，超车越多', () => {
    const count = (bonus: number) => {
      let n = 0;
      for (const seed of [1, 2, 3, 4]) {
        const s = advanceUntil(newTestGame(500 + seed), x => x.season.phase === 'race');
        s.rules.overtakeModeBonus = bonus;
        const { result } = simulateRace(s, new Rng(seed), 'race');
        n += result.events.filter(e => e.type === 'overtake').length;
      }
      return n;
    };
    expect(count(1.2)).toBeGreaterThan(count(0));
  });

  it('默认零件包含六类官方动力单元部件，每台车都装齐', () => {
    const s = newTestGame();
    expect(s.rules.parts.ice.name).toContain('ICE');
    expect(s.rules.parts.mgu_k.name).toContain('MGU-K');
    const types = ['ice', 'turbocharger', 'mgu_k', 'energy_store', 'control_electronics', 'exhaust'];
    for (const t of Object.values(s.teams)) for (const c of t.cars) for (const type of types) expect(c.fitted[type]).toBeTruthy();
    expect(s.drivers.c1.puUsed).toEqual({ ice: 1, turbocharger: 1, mgu_k: 1, energy_store: 1, control_electronics: 1, exhaust: 1 });
  });

  it('动力单元配额：第 4 台内燃机罚退 10 位，之后每台罚退 5 位，换回旧件不计数', () => {
    const s = advanceUntil(newTestGame(12), x => x.season.phase === 'practice');
    for (const spec of ['pu2', 'pu3']) expect(recordPuFit(s, 'c1', 'ice', spec)).toBe('');
    expect(s.drivers.c1.puUsed!.ice).toBe(3);
    // 换回已经用过的规格：不计数
    expect(recordPuFit(s, 'c1', 'ice', 'pu2')).toBe('');
    expect(s.drivers.c1.puUsed!.ice).toBe(3);
    expect(recordPuFit(s, 'c1', 'ice', 'pu4')).toContain('罚退 10 位');
    expect(s.weekend!.penalties.c1).toBe(10);
    expect(recordPuFit(s, 'c1', 'ice', 'pu5')).toContain('罚退 5 位');
    expect(s.weekend!.penalties.c1).toBe(15);
    // 事故后换上的新件（同规格）也计数
    expect(recordPuFit(s, 'c1', 'ice', 'pu5', { fresh: true, replaced: 'pu5' })).toContain('罚退 5 位');
    // 不计配额的零件
    expect(recordPuFit(s, 'c1', 'floor', 'x')).toBe('');
    expect(s.news.some(n => n.tag === '罚退')).toBe(true);
    const pu = buildView(s).drivers.find(d => d.id === 'c1')!.pu;
    expect(pu.find(p => p.type === 'ice')).toMatchObject({ used: 6, limit: 3 });
  });

  it('旧存档缺少动力单元计数时，第一次装件从第一件开始计算', () => {
    const s = newTestGame();
    const driver = s.drivers.c1;
    delete driver.puUsed;
    delete driver.puPool;
    expect(recordPuFit(s, driver.id, 'ice', 'legacy-first')).toBe('');
    expect(driver.puUsed!.ice).toBe(1);
    expect(driver.puPool!.ice).toEqual(['legacy-first']);
  });

  it('六类动力单元部件独立记录配额和磨损', () => {
    const s = newTestGame();
    const car = s.teams.team_c.cars.find(item => item.driverId === 'c1')!;
    const iceUsed = s.drivers.c1.puUsed!.ice;
    const mguUsed = s.drivers.c1.puUsed!.mgu_k;
    recordPuFit(s, 'c1', 'turbocharger', 'tc-new');
    expect(s.drivers.c1.puUsed!.turbocharger).toBe(2);
    expect(s.drivers.c1.puUsed!.ice).toBe(iceUsed);
    expect(s.drivers.c1.puUsed!.mgu_k).toBe(mguUsed);
    expect(car.puWear?.turbocharger).toEqual({ specId: 'tc-new', wear: 0 });
    expect(car.puWear?.ice).toBeUndefined();
  });

  it('动力单元磨损随物理规格保存，新件和新赛季会重置', () => {
    const s = newTestGame();
    const car = s.teams.team_c.cars.find(car => car.driverId === 'c1')!;
    const original = car.fitted.ice;
    car.puWear = { ice: { specId: original, wear: 24 } };
    car.puWearPool = { ice: { [original]: 24, alternate: 7 } };
    recordPuFit(s, 'c1', 'ice', 'alternate');
    expect(car.puWear.ice).toEqual({ specId: 'alternate', wear: 7 });
    recordPuFit(s, 'c1', 'ice', original);
    expect(car.puWear.ice).toEqual({ specId: original, wear: 24 });
    recordPuFit(s, 'c1', 'ice', original, { fresh: true, replaced: original });
    expect(car.puWear.ice).toEqual({ specId: original, wear: 0 });
  });

  it('排位后的配额罚退留到下一站', () => {
    const s = advanceUntil(newTestGame(12), x => x.season.phase === 'post_race');
    s.drivers.c2.puUsed!.mgu_k = 2;
    expect(recordPuFit(s, 'c2', 'mgu_k', 'ersX')).toContain('下一站生效');
    expect(JSON.parse(String(s.flags.pendingPenalties)).c2).toBe(10);
  });

  it('新赛季重置配额', () => {
    let s: GameState = advanceUntil(newTestGame(77), x => x.season.phase === 'season_end');
    s.drivers.c1.puUsed!.ice = 9;
    const car = s.teams.team_c.cars.find(car => car.driverId === 'c1')!;
    car.puWear = { ice: { specId: car.fitted.ice, wear: 40 } };
    car.puWearPool = { ice: { [car.fitted.ice]: 40 } };
    s = advanceUntil(s, x => x.season.phase === 'preseason');
    expect(s.drivers.c1.puUsed!.ice).toBe(1);
    const nextCar = s.teams.team_c.cars.find(car => car.driverId === 'c1')!;
    expect(nextCar.puWear).toEqual({});
    expect(nextCar.puWearPool).toEqual({});
  });
});

describe('数据校验（2026 新字段）', () => {
  it('未知的特殊机制会被忽略并警告', () => {
    const src = placeholderSources();
    const teams = src[1].data as { teams: Array<Record<string, unknown>> };
    teams.teams[0].special = 'unknown_team_mechanic';
    const res = normalizeDatabase(src);
    expect(res.canStart).toBe(true);
    expect(res.issues.some(i => i.level === 'warning' && i.path.endsWith('.special'))).toBe(true);
    expect(res.db!.teams[0].special).toBe('');
    expect(res.db!.teams.find(t => t.id === 'ferrari')!.special).toBe('ferrari');
  });

  it('动力单元配额：未知零件警告，非法数值报错', () => {
    const src = placeholderSources();
    const rules = src[0].data as { rules: Record<string, unknown> };
    rules.rules.puAllocation = { foo: 2, mgu_k: 0 };
    const res = normalizeDatabase(src);
    expect(res.issues.some(i => i.level === 'warning' && i.path === 'rules.puAllocation.foo')).toBe(true);
    expect(res.issues.some(i => i.level === 'error' && i.path.startsWith('rules.puAllocation.mgu_k'))).toBe(true);
  });
});

describe('开局：被选中的理由', () => {
  it('去掉控制字符、首尾空白，并截断到 300 字', () => {
    const db = placeholderDb();
    const s = createGame(db, { playerTeamId: 'team_c', principalName: '领队', seed: 1, gameId: 'g', now: 0, selectionReason: `  \u0007因为我${'很'.repeat(400)}  ` });
    expect(s.meta.selectionReason!.startsWith('因为我')).toBe(true);
    expect(s.meta.selectionReason).toHaveLength(300);
    expect(s.narration.map(n => n.detail).join('')).toContain('因为我');
  });

  it('空白理由不写入存档', () => {
    const s = createGame(placeholderDb(), { playerTeamId: 'team_c', principalName: '领队', seed: 1, gameId: 'g', now: 0, selectionReason: '   ' });
    expect(s.meta.selectionReason).toBeUndefined();
  });
});
