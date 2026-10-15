import { describe, expect, it } from 'vitest';
import { advanceUntil, act, newTestGame, tryAct } from '../helpers';
import { weekendTyreKey } from '../../src/engine/tyres';

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
    expect(state.teams[state.meta.playerTeamId].parts.ice.stock[fittedAfter] ?? 0).toBe(Math.max(0, stockBefore - 1));
    expect(state.teams[state.meta.playerTeamId].cars.find(item => item.driverId === 'c1')!.puWear!.ice!.wear).toBe(0);
    expect(fittedAfter).toBeTruthy();
  });
});
