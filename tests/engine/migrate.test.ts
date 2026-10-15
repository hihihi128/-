import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateState } from '../../src/engine/migrate';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { recordPuFit } from '../../src/engine/powerunit';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { encodeState, decodeState } from '../../src/tavern/store';
import { act, advanceUntil, cardSources, newTestGame } from '../helpers';
import { legacyWeeklyEventState } from '../fixtures/weekly-random-events';

/** 2025 规则版本（本 PR 之前）生成的真实存档：第 1 站赛后 */
const legacy = (): GameState => JSON.parse(readFileSync(resolve(__dirname, '../fixtures/legacy-save-2025.json'), 'utf8'));

describe('旧存档升级', () => {
  it('为原始员工和赛道迁移策略层级与减半后的降雨概率', () => {
    const loaded = normalizeDatabase(cardSources());
    if (!loaded.db) throw new Error('card database failed to load');
    const state = createGame(loaded.db, { playerTeamId: 'ferrari', principalName: '测试领队', seed: 95, gameId: 'balance-migration', now: 1 });
    delete state.flags['strategy-rain-balance-v1'];
    state.tracks.spa.rainChance = .48;
    state.teams.ferrari.staff.strategist.skill = 78;
    state.teams.ferrari.staff.strategist.abilities = { strategy: 76, weather: 74, reaction: 73, risk: 82 };
    state.teams.williams.staff.strategist.id = '';
    state.teams.williams.staff.strategist.name = `${state.teams.williams.name} strategist`;
    state.teams.williams.staff.strategist.skill = 80;
    state.teams.mclaren.staff.strategist = { ...state.teams.mclaren.staff.strategist, id: 'hired-strategist', name: '玩家签约策略师', skill: 99 };

    const restored = migrateState(state);
    expect(restored.tracks.spa.rainChance).toBe(.24);
    expect(restored.teams.ferrari.staff.strategist).toMatchObject({ skill: 54, abilities: { strategy: 54, weather: 52, reaction: 52, risk: 82 } });
    expect(restored.teams.williams.staff.strategist).toMatchObject({ id: 'williams-strategist', name: '夏尔-安托万·弗洛朗坦', skill: 85 });
    expect(restored.teams.mclaren.staff.strategist).toMatchObject({ id: 'hired-strategist', name: '玩家签约策略师', skill: 99 });
    expect(restored.flags['strategy-rain-balance-v1']).toBe(true);

    restored.tracks.spa.rainChance = .3;
    expect(migrateState(restored).tracks.spa.rainChance).toBe(.3);
  });

  it('补齐练习赛轮胎与调校选择，但保留旧存档已有选择', () => {
    const state = advanceUntil(newTestGame(93), value => value.season.phase === 'practice');
    const plans = state.weekend!.plans;
    const [first, second] = Object.keys(plans);
    delete plans[first].practiceTyre;
    delete plans[first].practiceSetupFocus;
    plans[second].practiceTyre = 'hard';
    plans[second].practiceSetupFocus = 'tyre_prep';
    delete (state.rules as Partial<GameState['rules']>).practiceReturnSets;

    const restored = migrateState(state);
    expect(restored.weekend!.plans[first]).toMatchObject({ practiceTyre: 'auto', practiceSetupFocus: 'balanced' });
    expect(restored.weekend!.plans[second]).toMatchObject({ practiceTyre: 'hard', practiceSetupFocus: 'tyre_prep' });
    expect(restored.rules.practiceReturnSets).toBe(2);
  });

  it('保留 v2 实时比赛的物理版本、上下文和低温起点', () => {
    let state = advanceUntil(newTestGame(94), value => value.season.phase === 'race');
    state = act(state, { type: 'START_RACE', kind: 'race' });
    const restored = migrateState(JSON.parse(JSON.stringify(state)) as GameState);
    const live = restored.weekend!.liveRace!;
    const car = Object.values(live.cars)[0];
    const tyre = restored.rules.tyres[car.tyre];
    expect(live.physicsVersion).toBe(2);
    expect(car.performanceContext?.tyreStress).toBeGreaterThanOrEqual(0);
    expect(car.tyreTemperature).toBe((tyre.temperatureWindow?.[0] ?? (tyre.wet ? 58 : 80)) - 18);
  });

  it('为旧的未确认湿地发车恢复所有仍在比赛的玩家选择，不重开已就绪比赛', () => {
    let state = advanceUntil(newTestGame(95), value => value.season.phase === 'race');
    state.weekend!.weather.race = 'wet';
    const playerIds = Object.values(state.drivers).filter(driver => driver.teamId === state.meta.playerTeamId).map(driver => driver.id);
    state.weekend!.plans[playerIds[0]].strategySource = 'engineer';
    state.weekend!.plans[playerIds[1]].strategySource = 'perfect';
    state = act(state, { type: 'START_RACE', kind: 'race' });
    const legacy = JSON.parse(JSON.stringify(state)) as GameState;
    legacy.weekend!.liveRace!.pendingDecision = null;
    const restored = migrateState(legacy).weekend!.liveRace!;
    expect(restored.pendingDecision?.eligibleDriverIds).toEqual(expect.arrayContaining(playerIds));
    const tyres = JSON.stringify(restored.cars);
    restored.stage = 'ready';
    restored.pendingDecision = null;
    migrateState(legacy);
    expect(restored.pendingDecision).toBeNull();
    expect(JSON.stringify(restored.cars)).toBe(tyres);
  });

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
    expect(state.rules.randomEvents).toMatchObject({ minPerWeek: 1, maxPerWeek: 1, routineWeight: 192, minDialogueTurns: 2, maxDialogueTurns: 3 });
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
    expect(s.rules.puAllocation).toEqual({ ice: 4, turbocharger: 4, mgu_k: 3, energy_store: 3, control_electronics: 3, exhaust: 4 });
    expect(s.rules.qualiFinalists).toBe(10);
    expect(s.rules.ferrari.minMedia).toBe(20);
    expect(s.ferrari).toBeNull();
    for (const t of Object.values(s.teams)) {
      for (const type of ['ice', 'turbocharger', 'mgu_k', 'energy_store', 'control_electronics', 'exhaust']) {
        expect(t.parts[type].specs).toHaveLength(1);
        for (const c of t.cars) expect(c.fitted[type]).toBe(t.parts[type].specs[0].id);
      }
    }
    expect(s.drivers.c1.puUsed).toEqual({ ice: 1, turbocharger: 1, mgu_k: 1, energy_store: 1, control_electronics: 1, exhaust: 1 });
    expect(() => buildView(s)).not.toThrow();
    const after = advanceUntil(s, x => x.season.phase === 'post_race' && x.season.roundIndex === 1);
    expect(after.history).toHaveLength(2);
  });

  it('把两组动力单元旧存档拆成六类，并保留配额、库存与磨损', () => {
    const state = newTestGame(9);
    const targets = ['ice', 'turbocharger', 'mgu_k', 'energy_store', 'control_electronics', 'exhaust'];
    state.rules.parts.power_unit = state.rules.parts.ice;
    state.rules.parts.ers = state.rules.parts.mgu_k;
    state.rules.puAllocation = { power_unit: 5, ers: 4 };
    state.rules.aduo.parts = ['power_unit', 'ers'];
    state.rules.aduo.measurePart = 'power_unit';
    for (const team of Object.values(state.teams)) {
      team.parts.power_unit = team.parts.ice;
      team.parts.ers = team.parts.mgu_k;
      for (const car of team.cars) {
        car.fitted.power_unit = car.fitted.ice;
        car.fitted.ers = car.fitted.mgu_k;
        for (const type of targets) delete car.fitted[type];
      }
      for (const type of targets) delete team.parts[type];
    }
    const car = state.teams.team_c.cars[0];
    Object.assign(car, {
      puWear: { power_unit: { specId: car.fitted.power_unit, wear: 21 } },
      puWearPool: { power_unit: { [car.fitted.power_unit]: 21 } },
    });
    state.drivers.c1.puUsed = { power_unit: 3, ers: 2 };
    state.drivers.c1.puPool = { power_unit: ['a', 'b', 'c'], ers: ['d', 'e'] };
    state.teams.team_c.projects.push({ id: 'legacy-pu', kind: 'design', label: '旧动力升级', partType: 'power_unit', cost: 9, weeksTotal: 3, weeksLeft: 2, startedAt: 'legacy' });
    state.rules.aduo.baseUpgrades = 1;
    state.teams.team_c.puHomologations = 2;
    state.teams.team_c.aduoUpgrades = 1;
    for (const team of Object.values(state.teams)) {
      for (const parts of Object.values(team.parts)) for (const spec of parts.specs) delete spec.homologated;
    }
    state.rules.astonMartin.aduoPuBuff = 8;

    migrateState(state);
    expect(state.rules.puAllocation).toEqual({ ice: 5, turbocharger: 5, exhaust: 5, mgu_k: 4, energy_store: 4, control_electronics: 4 });
    expect(state.rules.parts.power_unit).toBeUndefined();
    expect(state.teams.team_c.parts.power_unit).toBeUndefined();
    expect(state.drivers.c1.puUsed).toMatchObject({ ice: 3, turbocharger: 3, exhaust: 3, mgu_k: 2, energy_store: 2, control_electronics: 2 });
    expect(car.puWear?.ice?.wear).toBe(21);
    expect(car.puWear?.turbocharger?.wear).toBe(21);
    const splitProjects = state.teams.team_c.projects.filter(project => project.id.startsWith('legacy-pu-'));
    expect(splitProjects).toHaveLength(3);
    expect(splitProjects.reduce((sum, project) => sum + project.cost, 0)).toBe(9);
    expect(splitProjects.every(project => project.label.includes('旧动力升级 · '))).toBe(true);
    expect(state.rules.aduo.baseUpgrades).toBe(0);
    expect(state.teams.team_c.puHomologations).toBe(1);
    expect(state.teams.team_c.aduoUpgrades).toBe(2);
    expect(state.teams.team_c.aduoUpgrades - state.teams.team_c.puHomologations).toBe(1);
    expect(state.rules.astonMartin.aduoPuBuff).toBe(4.2);
    expect(() => buildView(state)).not.toThrow();
    const once = JSON.stringify(state);
    migrateState(state);
    expect(JSON.stringify(state)).toBe(once);
  });

  it('现代存档有意删除 ICE 时不把它误判成旧动力单元存档', () => {
    const state = newTestGame(10);
    delete state.rules.parts.ice;
    delete state.rules.puAllocation.ice;
    for (const team of Object.values(state.teams)) {
      delete team.parts.ice;
      for (const car of team.cars) delete car.fitted.ice;
    }
    migrateState(state);
    expect(state.rules.parts.ice).toBeUndefined();
    expect(state.rules.puAllocation.ice).toBeUndefined();
    expect(state.teams.team_c.parts.ice).toBeUndefined();
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
    expect(s.rules.parts.mgu_k).toBeTruthy();
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
    team.cars[1].fitted.ice = 'pu-new';
    s.drivers.c2.puPool!.ice = ['pu-new'];
    const next = act(s, { type: 'SWAP_DRIVER', slot: 2, driverId: 'c1' });
    expect(next.teams.team_c.cars[1].driverId).toBe('c1');
    expect(next.teams.team_c.cars[0].driverId).toBe('c2');
    expect(next.drivers.c1.puUsed!.ice).toBe(2);
    // c2 换到 1 号车，那台内燃机是新的
    expect(next.drivers.c2.puUsed!.ice).toBe(2);
  });

  it('最后一站正赛后超出配额不罚退（新赛季配额重置）', () => {
    const s = advanceUntil(newTestGame(12), x => x.season.roundIndex === x.calendar.length - 1 && x.season.phase === 'post_race');
    s.drivers.c1.puUsed!.ice = 4;
    expect(recordPuFit(s, 'c1', 'ice', 'late')).toBe('');
    expect(s.drivers.c1.puUsed!.ice).toBe(5);
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
