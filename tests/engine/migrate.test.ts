import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateState } from '../../src/engine/migrate';
import { recordPuFit } from '../../src/engine/powerunit';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { encodeState, decodeState } from '../../src/tavern/store';
import { act, advanceUntil, newTestGame } from '../helpers';

/** 2025 规则版本（本 PR 之前）生成的真实存档：第 1 站赛后 */
const legacy = (): GameState => JSON.parse(readFileSync(resolve(__dirname, '../fixtures/legacy-save-2025.json'), 'utf8'));

describe('旧存档升级', () => {
  it('为旧规则补齐全雨胎，并把旧雨胎名称改为半雨胎', () => {
    const state = newTestGame(5);
    delete (state.rules as Partial<typeof state.rules>).fullWetCompound;
    delete state.rules.tyres.wet;
    state.rules.tyres.inter.name = '雨胎';
    migrateState(state);
    expect(state.rules.fullWetCompound).toBe('wet');
    expect(state.rules.tyres.inter.name).toBe('半雨胎');
    expect(state.rules.tyres.wet.name).toBe('全雨胎');
  });

  it('2025 规则存档补齐 2026 字段后可以生成视图并继续推进', () => {
    const raw = legacy();
    expect(raw.rules.puAllocation).toBeUndefined();
    const s = migrateState(raw);
    expect(s.rules.puAllocation).toEqual({ power_unit: 4, ers: 3 });
    expect(s.rules.qualiFinalists).toBe(10);
    expect(s.rules.ferrari.minMedia).toBe(20);
    expect(s.ferrari).toBeNull();
    for (const t of Object.values(s.teams)) {
      expect(t.parts.ers.specs).toHaveLength(1);
      for (const c of t.cars) expect(c.fitted.ers).toBe(t.parts.ers.specs[0].id);
    }
    expect(s.drivers.c1.puUsed).toEqual({ power_unit: 1, ers: 1 });
    expect(() => buildView(s)).not.toThrow();
    const after = advanceUntil(s, x => x.season.phase === 'post_race' && x.season.roundIndex === 1);
    expect(after.history).toHaveLength(2);
  });

  it('不恢复玩家有意删除的零件和轮胎', () => {
    const raw = legacy();
    delete raw.rules.parts.floor;
    for (const t of Object.values(raw.teams)) {
      delete t.parts.floor;
      for (const c of t.cars) delete c.fitted.floor;
    }
    delete raw.rules.tyres.hard;
    const s = migrateState(raw);
    expect(s.rules.parts.floor).toBeUndefined();
    expect(s.rules.tyres.hard).toBeUndefined();
    expect(s.teams.team_c.cars[0].fitted.floor).toBeUndefined();
    expect(s.rules.parts.ers).toBeTruthy();
  });

  it('幂等：对新存档不做改动', () => {
    const s = newTestGame();
    const before = JSON.stringify(s);
    expect(JSON.stringify(migrateState(s))).toBe(before);
    const once = migrateState(legacy());
    expect(JSON.stringify(migrateState(JSON.parse(JSON.stringify(once))))).toBe(JSON.stringify(once));
  });

  it('从聊天变量解码存档时自动升级', () => {
    const s = decodeState(encodeState(legacy()));
    expect(s.rules.puAllocation).toBeTruthy();
  });

  it('把旧格式的单节练习结果保留为第一节，不改变已推进的阶段', () => {
    let state = advanceUntil(newTestGame(313), x => x.season.phase === 'practice');
    state = act(state, { type: 'RUN_PRACTICE' });
    expect(state.season.phase).toBe('practice');
    const oldResult = state.weekend!.practice;
    // In the former format this single result already advanced directly to qualifying.
    state.season.phase = 'qualifying';
    delete (state.weekend as unknown as Record<string, unknown>).practiceSessions;

    const migrated = migrateState(state);
    expect(migrated.season.phase).toBe('qualifying');
    expect(migrated.weekend!.practiceSessions).toEqual([oldResult]);
    expect(buildView(migrated).weekend!.practiceSessions).toEqual([oldResult]);
  });
});

describe('动力单元配额：边界情况', () => {
  it('两位正式车手对调座位时，双方都按新车上的动力单元计数', () => {
    const s = newTestGame();
    const team = s.teams.team_c;
    // 给 2 号车装一台 1 号车车手没用过的内燃机
    team.cars[1].fitted.power_unit = 'pu-new';
    s.drivers.c2.puPool!.power_unit = ['pu-new'];
    const next = act(s, { type: 'SWAP_DRIVER', slot: 2, driverId: 'c1' });
    expect(next.teams.team_c.cars[1].driverId).toBe('c1');
    expect(next.teams.team_c.cars[0].driverId).toBe('c2');
    expect(next.drivers.c1.puUsed!.power_unit).toBe(2);
    // c2 换到 1 号车，那台内燃机（power_unit-1）是新的
    expect(next.drivers.c2.puUsed!.power_unit).toBe(2);
  });

  it('最后一站正赛后超出配额不罚退（新赛季配额重置）', () => {
    const s = advanceUntil(newTestGame(12), x => x.season.roundIndex === x.calendar.length - 1 && x.season.phase === 'post_race');
    s.drivers.c1.puUsed!.power_unit = 4;
    expect(recordPuFit(s, 'c1', 'power_unit', 'late')).toBe('');
    expect(s.drivers.c1.puUsed!.power_unit).toBe(5);
    expect(s.flags.pendingPenalties).toBeUndefined();
  });
});

describe('撤职后的视图', () => {
  it('不再提供推进按钮', () => {
    const s = newTestGame(41, 'ferrari');
    s.ferrari!.dismissed = '测试';
    expect(buildView(s).next).toBeNull();
  });
});
