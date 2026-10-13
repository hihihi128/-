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

  it('默认零件包含内燃机与能量回收系统，每台车都装了两者', () => {
    const s = newTestGame();
    expect(s.rules.parts.power_unit.name).toBe('内燃机');
    expect(s.rules.parts.ers.name).toBe('能量回收系统');
    for (const t of Object.values(s.teams)) for (const c of t.cars) expect(c.fitted.ers).toBeTruthy();
    expect(s.drivers.c1.puUsed).toEqual({ power_unit: 1, ers: 1 });
  });

  it('动力单元配额：第 5 台内燃机罚退 10 位，之后每台罚退 5 位，换回旧件不计数', () => {
    const s = advanceUntil(newTestGame(12), x => x.season.phase === 'practice');
    for (const spec of ['pu2', 'pu3', 'pu4']) expect(recordPuFit(s, 'c1', 'power_unit', spec)).toBe('');
    expect(s.drivers.c1.puUsed!.power_unit).toBe(4);
    // 换回已经用过的规格：不计数
    expect(recordPuFit(s, 'c1', 'power_unit', 'pu2')).toBe('');
    expect(s.drivers.c1.puUsed!.power_unit).toBe(4);
    expect(recordPuFit(s, 'c1', 'power_unit', 'pu5')).toContain('罚退 10 位');
    expect(s.weekend!.penalties.c1).toBe(10);
    expect(recordPuFit(s, 'c1', 'power_unit', 'pu6')).toContain('罚退 5 位');
    expect(s.weekend!.penalties.c1).toBe(15);
    // 事故后换上的新件（同规格）也计数
    expect(recordPuFit(s, 'c1', 'power_unit', 'pu6', { fresh: true, replaced: 'pu6' })).toContain('罚退 5 位');
    // 不计配额的零件
    expect(recordPuFit(s, 'c1', 'floor', 'x')).toBe('');
    expect(s.news.some(n => n.tag === '罚退')).toBe(true);
    const pu = buildView(s).drivers.find(d => d.id === 'c1')!.pu;
    expect(pu.find(p => p.type === 'power_unit')).toMatchObject({ used: 7, limit: 4 });
  });

  it('排位后的配额罚退留到下一站', () => {
    const s = advanceUntil(newTestGame(12), x => x.season.phase === 'post_race');
    s.drivers.c2.puUsed!.ers = 3;
    expect(recordPuFit(s, 'c2', 'ers', 'ersX')).toContain('下一站生效');
    expect(JSON.parse(String(s.flags.pendingPenalties)).c2).toBe(10);
  });

  it('新赛季重置配额', () => {
    let s: GameState = advanceUntil(newTestGame(77), x => x.season.phase === 'season_end');
    s.drivers.c1.puUsed!.power_unit = 9;
    s = advanceUntil(s, x => x.season.phase === 'preseason');
    expect(s.drivers.c1.puUsed!.power_unit).toBe(1);
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
    rules.rules.puAllocation = { foo: 2, ers: 0 };
    const res = normalizeDatabase(src);
    expect(res.issues.some(i => i.level === 'warning' && i.path === 'rules.puAllocation.foo')).toBe(true);
    expect(res.issues.some(i => i.level === 'error' && i.path.startsWith('rules.puAllocation.ers'))).toBe(true);
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
