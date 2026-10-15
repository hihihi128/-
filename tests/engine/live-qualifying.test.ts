import { describe, expect, it } from 'vitest';
import { act, advanceUntil, newTestGame, tryAct } from '../helpers';
import { deepClone } from '../../src/engine/util';
import { migrateState } from '../../src/engine/migrate';

function atQualifying(seed = 700) {
  const state = advanceUntil(newTestGame(seed), value => value.season.phase === 'qualifying', 1200);
  state.weekend!.weather.qualifying = 'dry';
  return state;
}

function usableSetId(state: ReturnType<typeof atQualifying>, driverId: string): string {
  const team = state.teams[state.meta.playerTeamId];
  return team.tyreInventory![driverId].find(set => !set.returned && !state.rules.tyres[set.compound].wet)!.id;
}

function start(state: ReturnType<typeof atQualifying>) {
  return act(state, { type: 'START_QUALIFYING', kind: 'qualifying' });
}

function resume(state: ReturnType<typeof atQualifying>) {
  const live = state.weekend!.liveQualifying!;
  return act(state, { type: 'SET_QUALIFYING_CLOCK', sessionId: live.id, expectedRevision: live.revision, paused: false, speed: 1 });
}

function advance(state: ReturnType<typeof atQualifying>, ticks: number) {
  const live = state.weekend!.liveQualifying!;
  return act(state, { type: 'ADVANCE_QUALIFYING', sessionId: live.id, expectedRevision: live.revision, ticks });
}

describe('实时排位状态机', () => {
  it('启动时暂停，并允许两台玩家赛车独立放车', () => {
    let state = start(atQualifying());
    const live = state.weekend!.liveQualifying!;
    expect(live).toMatchObject({ version: 2, stage: 'ready', paused: true, speed: 1, segmentIndex: 0 });
    expect(live.cars.c1.phase).toBe('garage');
    expect(live.cars.c2.phase).toBe('garage');

    state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: usableSetId(state, 'c1') });
    expect(state.weekend!.liveQualifying!.cars.c1.phase).toBe('pit_out');
    expect(state.weekend!.liveQualifying!.cars.c2.phase).toBe('garage');
    expect(state.weekend!.liveQualifying!.elapsedTicks).toBe(0);

    const duplicate = tryAct(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: state.weekend!.liveQualifying!.revision, driverId: 'c1', tyreSetId: usableSetId(state, 'c1') });
    expect(duplicate.ok).toBe(false);
  });

  it('暂停不会推进，恢复后位置与计时同步推进', () => {
    let state = start(atQualifying(701));
    let live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: usableSetId(state, 'c1') });
    live = state.weekend!.liveQualifying!;
    const blocked = tryAct(state, { type: 'ADVANCE_QUALIFYING', sessionId: live.id, expectedRevision: live.revision, ticks: 10 });
    expect(blocked.ok).toBe(false);
    expect(blocked.state).toEqual(state);

    state = resume(state);
    state = advance(state, 20);
    expect(state.weekend!.liveQualifying!.elapsedTicks).toBe(20);
    expect(state.weekend!.liveQualifying!.cars.c1.phaseElapsedTicks).toBe(20);
  });

  it('不同合法批次产生相同物理状态和随机数', () => {
    let base = start(atQualifying(702));
    let live = base.weekend!.liveQualifying!;
    base = act(base, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: usableSetId(base, 'c1') });
    base = resume(base);
    let one = deepClone(base);
    let many = deepClone(base);
    one = advance(one, 80);
    for (let index = 0; index < 8; index++) many = advance(many, 10);
    expect(many.weekend!.liveQualifying!.elapsedTicks).toBe(one.weekend!.liveQualifying!.elapsedTicks);
    expect(many.weekend!.liveQualifying!.cars).toEqual(one.weekend!.liveQualifying!.cars);
    expect(many.weekend!.liveQualifying!.rngState).toBe(one.weekend!.liveQualifying!.rngState);
  });

  it('快车接近同区段慢车时累计交通损失', () => {
    let state = start(atQualifying(703));
    let live = state.weekend!.liveQualifying!;
    for (const driverId of ['c1', 'c2']) {
      state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: state.weekend!.liveQualifying!.revision, driverId, tyreSetId: usableSetId(state, driverId) });
      live = state.weekend!.liveQualifying!;
    }
    live.cars.c1.phase = 'flying_lap';
    live.cars.c1.progress = .1;
    live.cars.c1.activeRun!.flyingStartedTick = 0;
    live.cars.c2.phase = 'out_lap';
    live.cars.c2.progress = .12;
    state = resume(state);
    state = advance(state, 10);
    expect(state.weekend!.liveQualifying!.cars.c1.trafficDriverId).toBe('c2');
    expect(state.weekend!.liveQualifying!.cars.c1.activeRun!.trafficLoss).toBeGreaterThan(0);
  });

  it('慢车完成让车后不会反复重置阻挡计时', () => {
    let state = start(atQualifying(707));
    let live = state.weekend!.liveQualifying!;
    for (const driverId of ['c1', 'c2']) {
      state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: state.weekend!.liveQualifying!.revision, driverId, tyreSetId: usableSetId(state, driverId) });
      live = state.weekend!.liveQualifying!;
    }
    live.cars.c1.phase = 'flying_lap';
    live.cars.c1.progress = .1;
    live.cars.c1.activeRun!.cleanTime = 80;
    live.cars.c1.activeRun!.flyingStartedTick = 0;
    live.cars.c2.phase = 'out_lap';
    live.cars.c2.progress = .12;
    live.cars.c2.activeRun!.cleanTime = 80;
    state = resume(state);
    for (let index = 0; index < 4; index++) state = advance(state, 80);
    const run = state.weekend!.liveQualifying!.cars.c1.activeRun!;
    expect(run.trafficLoss).toBeGreaterThan(0);
    expect(run.trafficLoss).toBeLessThan(5);
    expect(state.weekend!.liveQualifying!.cars.c1.progress).toBeGreaterThan(.35);
  });

  it('保存并迁移真实运行中的 S3 赛车不会清除实时状态', () => {
    let state = start(atQualifying(708));
    let live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: usableSetId(state, 'c1') });
    state = resume(state);
    live = state.weekend!.liveQualifying!;
    live.cars.c1.phase = 'flying_lap';
    live.cars.c1.progress = .8;
    live.cars.c1.sector = 3;
    live.cars.c1.activeRun!.flyingStartedTick = live.elapsedTicks;
    live.cars.c1.activeRun!.flyingElapsedTicks = 12.5;
    const restored = JSON.parse(JSON.stringify(state));
    migrateState(restored);
    expect(restored.weekend!.liveQualifying).toMatchObject({ controlMode: 'manual', stage: 'running' });
    expect(restored.weekend!.liveQualifying!.cars.c1).toMatchObject({ phase: 'flying_lap', sector: 3, progress: .8 });
    migrateState(restored);
    expect(restored.weekend!.liveQualifying!.events.filter((event: { text: string }) => event.text.includes('无法验证'))).toHaveLength(0);
  });

  it('保存并迁移跨线后的分数 tick 不会清除实时状态', () => {
    let state = start(atQualifying(712));
    let live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: usableSetId(state, 'c1') });
    state = resume(state);
    live = state.weekend!.liveQualifying!;
    live.cars.c1.phase = 'out_lap';
    live.cars.c1.phaseElapsedTicks = 0;
    live.cars.c1.progress = 0;
    live.cars.c1.activeRun!.cleanTime = 76.195;
    for (let index = 0; index < 13 && state.weekend!.liveQualifying!.cars.c1.phase === 'out_lap'; index++) state = advance(state, 80);
    live = state.weekend!.liveQualifying!;
    expect(live.cars.c1.phase).toBe('flying_lap');
    expect(Number.isInteger(live.cars.c1.phaseElapsedTicks)).toBe(false);

    const restored = JSON.parse(JSON.stringify(state));
    migrateState(restored);
    expect(restored.weekend!.liveQualifying).toMatchObject({ controlMode: 'manual', stage: 'running' });
    expect(restored.weekend!.liveQualifying!.cars.c1.phase).toBe('flying_lap');
    expect(restored.weekend!.liveQualifying!.events.filter((event: { text: string }) => event.text.includes('无法验证'))).toHaveLength(0);
  });

  it('迁移下一分段时允许保留已淘汰的玩家赛车状态', () => {
    let state = start(atQualifying(709));
    const live = state.weekend!.liveQualifying!;
    live.segmentIndex = 1;
    live.sessions = [{ name: 'Q1', entries: live.alive.map(driverId => ({ driverId, teamId: live.cars[driverId].teamId, time: 80, eliminated: driverId === 'c2' })) }];
    live.alive = live.alive.filter(driverId => driverId !== 'c2');
    live.finalOrder = ['c2'];
    live.cars.c2.phase = 'done';
    const restored = JSON.parse(JSON.stringify(state));
    migrateState(restored);
    expect(restored.weekend!.liveQualifying).toMatchObject({ controlMode: 'manual', segmentIndex: 1 });
    expect(restored.weekend!.liveQualifying!.cars.c2).toMatchObject({ player: true, phase: 'done' });
  });

  it('计时归零后完成赛道上的圈并结算当前分段', () => {
    let state = start(atQualifying(704));
    let live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: usableSetId(state, 'c1') });
    live = state.weekend!.liveQualifying!;
    live.durationTicks = 300;
    live.cars.c1.activeRun!.cleanTime = 1;
    for (const car of Object.values(live.cars)) if (!car.player) car.phase = 'done';
    state = resume(state);
    for (let index = 0; index < 10 && state.weekend!.liveQualifying!.segmentIndex === 0; index++) state = advance(state, 80);
    expect(state.weekend!.liveQualifying!.segmentIndex).toBe(1);
    expect(state.weekend!.liveQualifying!.sessions[0].name).toBe('Q1');
    expect(state.weekend!.liveQualifying!.paused).toBe(true);
    expect(Object.keys(state.weekend!.liveQualifying!.cars)).toEqual(expect.arrayContaining(['c1', 'c2']));
    for (const driverId of ['c1', 'c2']) if (!state.weekend!.liveQualifying!.alive.includes(driverId)) {
      expect(state.weekend!.liveQualifying!.cars[driverId].phase).toBe('done');
    }
  });

  it('按圈线通过的精确时刻决定是否可在零点前开始飞行圈', () => {
    let state = start(atQualifying(710));
    let live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: usableSetId(state, 'c1') });
    state = resume(state);
    live = state.weekend!.liveQualifying!;
    live.durationTicks = 10;
    live.elapsedTicks = 9;
    live.cars.c1.phase = 'out_lap';
    const duration = live.cars.c1.activeRun!.cleanTime * 1.32 * 10;
    for (const car of Object.values(live.cars)) if (car.driverId !== 'c1') car.phase = 'done';
    const beforeZero = deepClone(state);
    beforeZero.weekend!.liveQualifying!.cars.c1.progress = 1 - .5 / duration;
    const exactZero = deepClone(state);
    exactZero.weekend!.liveQualifying!.cars.c1.progress = 1 - 1 / duration;
    const accepted = advance(beforeZero, 1);
    const refused = advance(exactZero, 1);
    expect(accepted.weekend!.liveQualifying!.cars.c1.phase).toBe('flying_lap');
    expect(accepted.weekend!.liveQualifying!.cars.c1.activeRun!.flyingStartedTick).toBeCloseTo(9.5, 5);
    expect(accepted.weekend!.liveQualifying!.cars.c1.activeRun!.flyingElapsedTicks).toBeCloseTo(.5, 5);
    expect(refused.weekend!.liveQualifying!.cars.c1.phase).toBe('in_lap');
  });

  it('空赛道飞行圈保留毫秒级 clean time', () => {
    let state = start(atQualifying(713));
    let live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: usableSetId(state, 'c1') });
    state = resume(state);
    live = state.weekend!.liveQualifying!;
    for (const car of Object.values(live.cars)) if (car.driverId !== 'c1') car.phase = 'done';
    live.cars.c1.phase = 'flying_lap';
    live.cars.c1.progress = 0;
    live.cars.c1.phaseElapsedTicks = 0;
    live.cars.c1.activeRun!.cleanTime = 76.195;
    live.cars.c1.activeRun!.flyingStartedTick = live.elapsedTicks;
    while (state.weekend!.liveQualifying!.cars.c1.phase === 'flying_lap') state = advance(state, 80);
    expect(state.weekend!.liveQualifying!.cars.c1.lastTime).toBe(76.195);
    expect(state.weekend!.liveQualifying!.cars.c1.activeRun!.trafficLoss).toBe(0);
  });

  it('SQ1 只接受全新指定中性胎且只有一次出场', () => {
    let state = advanceUntil(newTestGame(711), value => value.season.phase === 'sprint_qualifying', 1200);
    state.weekend!.weather.sprintQualifying = 'dry';
    state = act(state, { type: 'START_QUALIFYING', kind: 'sprint_qualifying' });
    const live = state.weekend!.liveQualifying!;
    expect(live.runAllowance).toBe(1);
    const team = state.teams[state.meta.playerTeamId];
    const soft = team.tyreInventory!.c1.find(set => set.compound === state.rules.dryCompounds[0] && !set.returned)!;
    const medium = team.tyreInventory!.c1.find(set => set.compound === state.rules.dryCompounds[1] && set.state === 'new' && !set.returned)!;
    const rejected = tryAct(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: soft.id });
    expect(rejected.ok).toBe(false);
    state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: medium.id });
    expect(state.weekend!.liveQualifying!.cars.c1.activeRun!.compound).toBe(state.rules.dryCompounds[1]);
  });

  it('允许暂停并继续完成计时归零时仍在赛道上的圈', () => {
    let state = start(atQualifying(706));
    let live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'RELEASE_QUALIFYING_CAR', sessionId: live.id, expectedRevision: live.revision, driverId: 'c1', tyreSetId: usableSetId(state, 'c1') });
    live = state.weekend!.liveQualifying!;
    live.durationTicks = 1;
    for (const car of Object.values(live.cars)) if (!car.player) car.phase = 'done';
    state = resume(state);
    state = advance(state, 1);
    expect(state.weekend!.liveQualifying!.stage).toBe('finishing');
    live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'SET_QUALIFYING_CLOCK', sessionId: live.id, expectedRevision: live.revision, paused: true, speed: 4 });
    live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'SET_QUALIFYING_CLOCK', sessionId: live.id, expectedRevision: live.revision, paused: false, speed: 4 });
    expect(state.weekend!.liveQualifying!.paused).toBe(false);
    expect(state.weekend!.liveQualifying!.speed).toBe(4);
  });

  it('陈旧 revision 与非法步数不会修改状态', () => {
    const state = start(atQualifying(705));
    const live = state.weekend!.liveQualifying!;
    const stale = tryAct(state, { type: 'SET_QUALIFYING_CLOCK', sessionId: live.id, expectedRevision: live.revision + 1, paused: false, speed: 1 });
    expect(stale.ok).toBe(false);
    expect(stale.state).toEqual(state);
    const invalid = tryAct(state, { type: 'ADVANCE_QUALIFYING', sessionId: live.id, expectedRevision: live.revision, ticks: 81 });
    expect(invalid.ok).toBe(false);
    expect(invalid.state).toEqual(state);
  });
});
