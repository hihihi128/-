import { describe, expect, it } from 'vitest';
import { act, advanceUntil, newTestGame, tryAct } from '../helpers';
import { deepClone } from '../../src/engine/util';

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
