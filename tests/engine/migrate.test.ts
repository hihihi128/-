import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateState } from '../../src/engine/migrate';
import { recordPuFit } from '../../src/engine/powerunit';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { encodeState, decodeState } from '../../src/tavern/store';
import { act, advanceUntil, newTestGame } from '../helpers';
import { legacyWeeklyEventState } from '../fixtures/weekly-random-events';

/** 2025 规则版本（本 PR 之前）生成的真实存档：第 1 站赛后 */
const legacy = (): GameState => JSON.parse(readFileSync(resolve(__dirname, '../fixtures/legacy-save-2025.json'), 'utf8'));

describe('旧存档升级', () => {
  it('把默认车队旧存档中的员工占位名替换为正式显示名', () => {
    const state = newTestGame();
    const team = state.teams.team_c;
    state.teams.mercedes = team;
    team.id = 'mercedes';
    team.name = '梅赛德斯车队';
    team.staff.aeroChief.name = '梅赛德斯车队 aeroChief';
    team.staff.raceEngineer.name = '自定义工程师';
    team.staff.raceEngineer2.name = '比赛工程师（二号车）';
    team.staff.pitCrew.name = '梅赛德斯车队 pitCrew';
    team.staff.strategist.name = '迈凯伦车队 strategist';

    migrateState(state);

    expect(state.teams.mercedes.staff.aeroChief.name).toBe('贾罗德·墨菲');
    expect(state.teams.mercedes.staff.raceEngineer.name).toBe('自定义工程师');
    expect(state.teams.mercedes.staff.raceEngineer2.name).toBe('彼得·博宁顿');
    expect(state.teams.mercedes.staff.pitCrew.name).toBe('梅赛德斯维修组');
    expect(state.teams.mercedes.staff.strategist.name).toBe('迈凯伦车队 strategist');
    const once = JSON.stringify(state.teams.mercedes.staff);
    migrateState(state);
    expect(JSON.stringify(state.teams.mercedes.staff)).toBe(once);
  });

  it('补齐旧随机事件的周配额、对话和个人好感度字段', () => {
    const state = migrateState(legacyWeeklyEventState());
    expect(state.rules.randomEvents).toMatchObject({ minPerWeek: 3, maxPerWeek: 4, routineWeight: 192, minDialogueTurns: 2, maxDialogueTurns: 3 });
    expect(state.randomEvents?.current).toMatchObject({ category: 'problem', totalDialogueTurns: 2, completedDialogueTurns: 0, dialogue: [] });
    expect(state.randomEvents?.history[0]).toMatchObject({ totalDialogueTurns: 1, completedDialogueTurns: 1 });
    expect(Object.values(state.drivers).every(driver => driver.affinity === 50)).toBe(true);
    expect(Object.values(state.teams).flatMap(team => Object.values(team.staff)).every(staff => staff.affinity === 50)).toBe(true);
  });

  it('保留旧存档中关闭随机事件的设置', () => {
    const state = newTestGame(7004);
    state.rules.randomEvents = { noneWeight: 1, driverInjuryWeight: 0, windTunnelWeight: 0, partIssueWeight: 0 };
    migrateState(state);
    expect(state.rules.randomEvents).toMatchObject({ minPerWeek: 0, maxPerWeek: 0, routineWeight: 0 });
  });
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

  it('旧自定义规则占用 wet 键时使用独立全雨胎键', () => {
    const state = newTestGame(6);
    delete (state.rules as Partial<typeof state.rules>).fullWetCompound;
    state.rules.tyres.wet = { ...state.rules.tyres.medium, name: '自定义干胎' };
    migrateState(state);
    expect(state.rules.fullWetCompound).toBe('full_wet');
    expect(state.rules.tyres.full_wet).toMatchObject({ name: '全雨胎', wet: true });
    expect(state.rules.tyres.wet.name).toBe('自定义干胎');
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
