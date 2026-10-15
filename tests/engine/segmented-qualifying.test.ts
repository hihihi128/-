import { describe, expect, it } from 'vitest';
import { advanceUntil, act, newTestGame, tryAct } from '../helpers';
import { returnEligibleTyreSets, weekendTyreKey } from '../../src/engine/tyres';
import { deepClone } from '../../src/engine/util';
import { buildView } from '../../src/engine/view';
import { migrateState } from '../../src/engine/migrate';

describe('逐段排位与实体轮胎组', () => {
  it('逐段推进 Q1/Q2/Q3，并保存每次出场选择的实体轮胎组', () => {
    let state = advanceUntil(newTestGame(314), value => value.season.phase === 'qualifying');
    const team = state.teams[state.meta.playerTeamId];
    const key = weekendTyreKey(state);
    const choices = Object.fromEntries(team.cars.filter(car => car.driverId).map(car => {
      const driverId = car.driverId!;
      const set = team.tyreInventory![driverId].find(candidate => candidate.weekendKey === key && !candidate.returned && !state.rules.tyres[candidate.compound].wet)!;
      return [driverId, [set.id, set.id]];
    }));

    state = act(state, { type: 'RUN_QUALIFYING', tyreSetIds: choices });
    expect(state.season.phase).toBe('qualifying');
    expect(state.weekend!.liveQualifying).toMatchObject({ segmentIndex: 1, segmentCount: 3 });
    for (const [driverId, setIds] of Object.entries(choices)) {
      const entry = state.weekend!.liveQualifying!.sessions[0].entries.find(item => item.driverId === driverId)!;
      expect(entry.tyreRuns?.map(run => run.setId)).toEqual(setIds);
    }

    state = act(state, { type: 'RUN_QUALIFYING' });
    expect(state.season.phase).toBe('qualifying');
    state = act(state, { type: 'RUN_QUALIFYING' });
    expect(state.season.phase).toBe('race');
    expect(state.weekend!.liveQualifying).toBeNull();
    expect(state.weekend!.qualifying!.sessions.map(session => session.name)).toEqual(['Q1', 'Q2', 'Q3']);
  });

  it.each([
    ['qualifying', 'race', ['Q1', 'Q2', 'Q3']],
    ['sprint_qualifying', 'sprint', ['SQ1', 'SQ2', 'SQ3']],
  ] as const)('一键模拟 %s，并让 AI 车手完成全部晋级分段', (kind, nextPhase, names) => {
    let state = advanceUntil(newTestGame(kind === 'qualifying' ? 324 : 325), value => value.season.phase === kind, 1200);
    const activeDriverIds = state.teamOrder.flatMap(teamId => state.teams[teamId].cars.flatMap(car => car.driverId ? [car.driverId] : []));

    state = act(state, { type: 'SIMULATE_QUALIFYING', kind });

    const result = kind === 'qualifying' ? state.weekend!.qualifying! : state.weekend!.sprintQualifying!;
    expect(state.season.phase).toBe(nextPhase);
    expect(state.weekend!.liveQualifying).toBeNull();
    expect(result.sessions.map(session => session.name)).toEqual(names);
    expect(result.order).toHaveLength(activeDriverIds.length);
    expect(new Set(result.order)).toEqual(new Set(activeDriverIds));
    expect(new Set(result.grid)).toEqual(new Set(activeDriverIds));

    for (let index = 0; index < result.sessions.length - 1; index++) {
      const eliminated = result.sessions[index].entries.filter(entry => entry.eliminated);
      const nextDriverIds = new Set(result.sessions[index + 1].entries.map(entry => entry.driverId));
      expect(eliminated.length).toBeGreaterThan(0);
      expect(eliminated.some(entry => !state.teams[entry.teamId].isPlayer)).toBe(true);
      expect(eliminated.every(entry => !nextDriverIds.has(entry.driverId))).toBe(true);
    }
    expect(result.sessions.slice(1).every(session => session.entries.some(entry => !state.teams[entry.teamId].isPlayer))).toBe(true);
  });

  it('只在两名玩家车手都淘汰后自动完成实时排位的剩余分段', () => {
    let state = advanceUntil(newTestGame(326), value => value.season.phase === 'qualifying');
    state = act(state, { type: 'RUN_QUALIFYING' });
    const live = state.weekend!.liveQualifying!;
    live.controlMode = 'manual';
    expect(tryAct(state, { type: 'SIMULATE_QUALIFYING', kind: 'qualifying' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('本队仍有车手晋级'),
    });

    const playerIds = new Set(state.teams[state.meta.playerTeamId].cars.flatMap(car => car.driverId ? [car.driverId] : []));
    const newlyEliminated = live.alive.filter(driverId => playerIds.has(driverId));
    live.alive = live.alive.filter(driverId => !playerIds.has(driverId));
    live.finalOrder.unshift(...newlyEliminated);
    for (const entry of live.sessions[0].entries) if (newlyEliminated.includes(entry.driverId)) entry.eliminated = true;
    const globalRng = state.rng;

    state = act(state, { type: 'SIMULATE_QUALIFYING', kind: 'qualifying' });
    expect(state.season.phase).toBe('race');
    expect(state.weekend!.liveQualifying).toBeNull();
    expect(state.weekend!.qualifying!.sessions.map(session => session.name)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(new Set(state.weekend!.qualifying!.order).size).toBe(state.weekend!.qualifying!.order.length);
    expect(state.weekend!.qualifying!.sessions.slice(1).every(session => session.entries.every(entry => !playerIds.has(entry.driverId)))).toBe(true);
    expect(state.rng).toBe(globalRng);
  });

  it('拒绝不可用轮胎组，并且不消耗随机数或推进分段', () => {
    const state = advanceUntil(newTestGame(315), value => value.season.phase === 'qualifying');
    const beforeRng = state.rng;
    const result = tryAct(state, { type: 'RUN_QUALIFYING', tyreSetIds: { c1: ['missing', 'missing'], c2: ['missing', 'missing'] } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('不可用');
    expect(result.state.rng).toBe(beforeRng);
    expect(result.state.weekend!.liveQualifying).toBeUndefined();
  });

  it('没有任何合法轮胎组时允许无成绩并继续', () => {
    let state = advanceUntil(newTestGame(316), value => value.season.phase === 'qualifying');
    const team = state.teams[state.meta.playerTeamId];
    for (const car of team.cars) if (car.driverId) for (const set of team.tyreInventory![car.driverId]) set.returned = true;
    state = act(state, { type: 'RUN_QUALIFYING', tyreSetIds: { c1: [], c2: [] } });
    const playerEntries = state.weekend!.liveQualifying!.sessions[0].entries.filter(entry => entry.teamId === team.id);
    expect(playerEntries.every(entry => entry.time === null && entry.note === '无可用轮胎')).toBe(true);
  });

  it('排位赛轮胎配方会影响圈速', () => {
    const base = advanceUntil(newTestGame(320), value => value.season.phase === 'qualifying');
    base.weekend!.weather.qualifying = 'dry';
    const team = base.teams[base.meta.playerTeamId];
    const sets = team.tyreInventory!.c1.filter(set => !set.returned);
    const soft = sets.find(set => set.compound === base.rules.dryCompounds[0])!;
    const hard = sets.find(set => set.compound === base.rules.dryCompounds[2])!;
    const other = team.tyreInventory!.c2.find(set => !set.returned && !base.rules.tyres[set.compound].wet)!;
    const run = (setId: string) => act(deepClone(base), { type: 'RUN_QUALIFYING', tyreSetIds: { c1: [setId, setId], c2: [other.id, other.id] } });
    const softTime = run(soft.id).weekend!.liveQualifying!.sessions[0].entries.find(entry => entry.driverId === 'c1')!.time!;
    const hardTime = run(hard.id).weekend!.liveQualifying!.sessions[0].entries.find(entry => entry.driverId === 'c1')!.time!;
    expect(softTime).toBeLessThan(hardTime);
  });

  it('SQ1 和 SQ2 只允许全新的指定中性胎，SQ3 开放合法干胎', () => {
    let state = advanceUntil(newTestGame(322), value => value.season.phase === 'sprint_qualifying', 1200);
    state.weekend!.weather.sprintQualifying = 'dry';
    const medium = state.rules.dryCompounds[1] ?? state.rules.dryCompounds[0];
    const choices = () => Object.fromEntries(buildView(state).weekend!.drivers.map(driver => {
      const sets = driver.tyreSets.filter(set => driver.qualifyingTyreSetIds.includes(set.id));
      return [driver.driverId, [sets[0]?.id].filter(Boolean) as string[]];
    }));
    for (const driver of buildView(state).weekend!.drivers) {
      const sets = driver.tyreSets.filter(set => driver.qualifyingTyreSetIds.includes(set.id));
      expect(sets.every(set => set.compound === medium && set.state === 'new')).toBe(true);
    }
    state = act(state, { type: 'RUN_SPRINT_QUALIFYING', tyreSetIds: choices() });
    for (const driver of buildView(state).weekend!.drivers.filter(item => state.weekend!.liveQualifying!.alive.includes(item.driverId))) {
      const sets = driver.tyreSets.filter(set => driver.qualifyingTyreSetIds.includes(set.id));
      expect(sets.every(set => set.compound === medium && set.state === 'new')).toBe(true);
    }
    state = act(state, { type: 'RUN_SPRINT_QUALIFYING', tyreSetIds: choices() });
    const sq3 = buildView(state).weekend!.drivers.filter(item => state.weekend!.liveQualifying!.alive.includes(item.driverId));
    expect(sq3.every(driver => driver.qualifyingTyreSetIds.length > 0)).toBe(true);
    expect(sq3.some(driver => driver.tyreSets.filter(set => driver.qualifyingTyreSetIds.includes(set.id)).some(set => set.compound !== medium))).toBe(true);
  });
});

describe('比赛周末动力单元磨损', () => {
  it('练习赛和排位赛都会增加持久化动力单元磨损', () => {
    let state = advanceUntil(newTestGame(317), value => value.season.phase === 'practice');
    const car = state.teams[state.meta.playerTeamId].cars.find(item => item.driverId === 'c1')!;
    const initial = car.puWear?.ice?.wear ?? 0;
    state = act(state, { type: 'RUN_PRACTICE' });
    const afterPractice = state.teams[state.meta.playerTeamId].cars.find(item => item.driverId === 'c1')!.puWear!.ice!.wear;
    expect(afterPractice).toBeGreaterThan(initial);
    state = advanceUntil(state, value => value.season.phase === 'qualifying');
    const beforeQualifying = state.teams[state.meta.playerTeamId].cars.find(item => item.driverId === 'c1')!.puWear!.ice!.wear;
    state = act(state, { type: 'RUN_QUALIFYING' });
    expect(state.teams[state.meta.playerTeamId].cars.find(item => item.driverId === 'c1')!.puWear!.ice!.wear).toBeGreaterThan(beforeQualifying);
  });
});

describe('逐段排位存档迁移', () => {
  it('保留合法进度并清除畸形进度', () => {
    let state = advanceUntil(newTestGame(323), value => value.season.phase === 'qualifying');
    state = act(state, { type: 'RUN_QUALIFYING' });
    const valid = deepClone(state);
    migrateState(valid);
    expect(valid.weekend!.liveQualifying?.segmentIndex).toBe(1);

    const malformed = deepClone(state);
    malformed.weekend!.liveQualifying!.segmentCount = Number.NaN;
    migrateState(malformed);
    expect(malformed.weekend!.liveQualifying).toBeNull();
  });
});

describe('正赛实体轮胎组', () => {
  it('按每个正赛赛段保存并装上玩家指定的实体轮胎组', () => {
    let state = advanceUntil(newTestGame(318), value => value.season.phase === 'race');
    state.weekend!.weather.race = 'dry';
    const team = state.teams[state.meta.playerTeamId];
    const sets = team.tyreInventory!.c1.filter(set => !set.returned);
    const first = sets.find(set => !state.rules.tyres[set.compound].wet)!;
    const second = sets.find(set => set.compound !== first.compound && !state.rules.tyres[set.compound].wet)!;
    state = act(state, {
      type: 'SET_PLAN',
      driverId: 'c1',
      plan: { tyrePlan: [first.compound, second.compound], raceTyreSetPlan: [first.id, second.id], strategySource: 'player' },
    });
    state = act(state, { type: 'START_RACE', kind: 'race' });
    expect(state.weekend!.liveRace!.cars.c1.tyreSetId).toBe(first.id);
    expect(state.weekend!.liveRace!.cars.c1.plannedTyreSetIds).toEqual([first.id, second.id]);
    let live = state.weekend!.liveRace!;
    state = act(state, {
      type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision!.id,
      drivers: live.pendingDecision!.eligibleDriverIds.map(driverId => ({ driverId, pit: 'auto' as const, startCompound: live.cars[driverId].tyre })),
    });
    live = state.weekend!.liveRace!;
    live.cars.c1.stints[0] = 1;
    live.cars.c1.tyreAge = 10;
    for (let attempt = 0; attempt < 4 && state.weekend!.liveRace!.cars.c1.tyreSetId !== second.id; attempt++) {
      live = state.weekend!.liveRace!;
      state = live.pendingDecision
        ? act(state, {
            type: 'RESOLVE_RACE_DECISION', sessionId: live.id, expectedRevision: live.revision, windowId: live.pendingDecision.id,
            drivers: live.pendingDecision.eligibleDriverIds.map(driverId => ({ driverId, pit: 'auto' as const })),
          })
        : act(state, { type: 'ADVANCE_RACE', sessionId: live.id, expectedRevision: live.revision, until: 'next_lap' });
    }
    expect(state.weekend!.liveRace!.cars.c1.tyreSetId).toBe(second.id);
  });

  it('拒绝重复轮胎组，并保护已规划轮胎不被练习赛交回', () => {
    let state = advanceUntil(newTestGame(321), value => value.season.phase === 'practice');
    const team = state.teams[state.meta.playerTeamId];
    const sets = team.tyreInventory!.c1.filter(set => !set.returned && !state.rules.tyres[set.compound].wet);
    const first = sets[0];
    const second = sets.find(set => set.compound !== first.compound)!;
    const duplicate = tryAct(state, { type: 'SET_PLAN', driverId: 'c1', plan: { tyrePlan: [first.compound, second.compound], raceTyreSetPlan: [first.id, first.id] } });
    expect(duplicate.ok).toBe(false);
    state = act(state, { type: 'SET_PLAN', driverId: 'c1', plan: { tyrePlan: [first.compound, second.compound], raceTyreSetPlan: [first.id, second.id] } });
    expect(returnEligibleTyreSets(state, team, 'c1').map(set => set.id)).not.toContain(first.id);
    expect(returnEligibleTyreSets(state, team, 'c1').map(set => set.id)).not.toContain(second.id);
  });
});

describe('按退赛原因结算部件损伤', () => {
  it('动力单元故障退赛会损毁对应物理部件并启用替换件', () => {
    let state = advanceUntil(newTestGame(319), value => value.season.phase === 'race');
    state.weekend!.weather.race = 'dry';
    state = act(state, { type: 'START_RACE', kind: 'race' });
    const live = state.weekend!.liveRace!;
    const car = live.cars.c1;
    const playerTeam = state.teams[state.meta.playerTeamId];
    const fittedBefore = playerTeam.cars.find(item => item.driverId === 'c1')!.fitted.ice;
    const stockBefore = playerTeam.parts.ice.stock[fittedBefore] ?? 0;
    const usedBefore = state.drivers.c1.puUsed!.ice;
    const fitnessBefore = state.drivers.c1.fitness;
    const capSpentBefore = playerTeam.costCapSpent;
    car.status = 'dnf';
    car.reason = 'ICE 故障';
    car.completedLaps = 8;
    live.damageLedger.push({
      id: 'forced-pu-damage', incidentId: 'forced-pu', driverId: 'c1', teamId: car.teamId, slot: car.slot,
      cause: 'power_unit', severity: 'dnf', affectedPartTypes: ['ice'], repairedInRace: false,
    });
    live.pendingDecision = null;
    live.stage = 'finished';
    live.weatherHistory = [0];
    state = act(state, { type: 'ADVANCE_RACE', sessionId: live.id, expectedRevision: live.revision, until: 'next_lap' });
    const fittedAfter = state.teams[state.meta.playerTeamId].cars.find(item => item.driverId === 'c1')!.fitted.ice;
    expect(state.drivers.c1.puUsed!.ice).toBe(usedBefore + 1);
    expect(state.drivers.c1.fitness).toBe(fitnessBefore);
    expect(state.teams[state.meta.playerTeamId].costCapSpent).toBe(capSpentBefore + playerTeam.operatingCost);
    expect(state.teams[state.meta.playerTeamId].parts.ice.stock[fittedAfter] ?? 0).toBe(Math.max(0, stockBefore - 1));
    expect(state.teams[state.meta.playerTeamId].cars.find(item => item.driverId === 'c1')!.puWear!.ice!.wear).toBe(0);
    expect(fittedAfter).toBeTruthy();
  });
});
