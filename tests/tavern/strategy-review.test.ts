import { beforeEach, describe, expect, it } from 'vitest';
import { F1Controller } from '../../src/tavern/controller';
import { parseStrategyReview } from '../../src/tavern/strategyReview';
import { FakeTavern } from './fakeEnv';

async function setup() {
  const env = new FakeTavern();
  const ctrl = new F1Controller(env);
  ctrl.init();
  expect((await ctrl.newGame({ playerTeamId: 'team_c', seed: 4301 })).ok).toBe(true);
  for (let i = 0; i < 30 && !ctrl.stateAt()!.weekend; i++) expect((await ctrl.dispatch({ type: 'ADVANCE' })).ok).toBe(true);
  const state = ctrl.stateAt()!;
  const grid = Object.values(state.teams).flatMap(team => team.cars.map(car => car.driverId).filter((id): id is string => !!id));
  state.season.phase = 'race';
  state.weekend!.qualifying = { kind: 'qualifying', weather: 'dry', sessions: [], order: [...grid], grid: [...grid], pole: null, events: [] };
  expect((await ctrl.importSave(JSON.stringify(state))).ok).toBe(true);
  expect((await ctrl.dispatch({
    type: 'SET_PLAN', driverId: 'c1', plan: { strategySource: 'engineer', tyrePlan: ['soft', 'medium'], paceMode: 'balanced', pitTiming: 'standard', scReaction: true },
  })).ok).toBe(true);
  ctrl.updateSettings({ engineerApi: 'main', engineerProxyPreset: 'review-secondary', engineerModel: 'review-model' });
  return { env, ctrl };
}

const changed = JSON.stringify({
  schemaVersion: 1,
  driverId: 'c1',
  verdict: 'changes_recommended',
  summary: '硬胎能更稳地覆盖后段，建议将第二段更换为硬胎。',
  issues: [{ code: 'tyre_life', severity: 'warning', message: '中性胎末段余量不足。' }],
  correctedPlan: { tyrePlan: ['soft', 'hard'], paceMode: 'balanced', pitTiming: 'standard', scReaction: true },
});

describe('策略点评副 API', () => {
  let env: FakeTavern;
  let ctrl: F1Controller;

  beforeEach(async () => {
    ({ env, ctrl } = await setup());
  });

  it('固定使用副 API，仅生成内存候选，确认一次后才应用', async () => {
    env.generateText = async (_prompt, options) => {
      expect(options).toEqual({ proxyPreset: 'review-secondary', model: 'review-model' });
      return changed;
    };
    const before = JSON.stringify(ctrl.stateAt()!.weekend!.plans.c1);
    const review = await ctrl.requestStrategyReview({ driverId: 'c1', expectedRevisionId: ctrl.status().revisionId! });
    expect(review).toMatchObject({ ok: true, api: 'secondary', correctedPlan: { tyrePlan: ['soft', 'hard'] } });
    expect(JSON.stringify(ctrl.stateAt()!.weekend!.plans.c1)).toBe(before);
    expect(review.originalPrediction?.stints.reduce((sum, laps) => sum + laps, 0)).toBe(ctrl.stateAt()!.tracks[ctrl.stateAt()!.calendar[ctrl.stateAt()!.weekend!.roundIndex].trackId].laps);

    const applied = await ctrl.applyStrategyReview({ reviewId: review.reviewId!, expectedRevisionId: ctrl.status().revisionId! });
    expect(applied).toMatchObject({ ok: true, api: 'secondary', correctedPlan: { tyrePlan: ['soft', 'hard'] } });
    expect(ctrl.stateAt()!.weekend!.plans.c1).toMatchObject({
      strategySource: 'engineer',
      tyrePlan: ['soft', 'hard'],
      strategyReview: {
        source: 'secondary',
        originalPlan: { tyrePlan: ['soft', 'medium'], paceMode: 'balanced', pitTiming: 'standard', scReaction: true },
        summary: '硬胎能更稳地覆盖后段，建议将第二段更换为硬胎。',
        issues: [{ code: 'tyre_life', severity: 'medium', message: '中性胎末段余量不足。' }],
        modelLabel: 'performance-v2',
        roundKey: '2026:r1',
      },
    });
    expect((await ctrl.applyStrategyReview({ reviewId: review.reviewId!, expectedRevisionId: ctrl.status().revisionId! })).ok).toBe(false);
    expect((await ctrl.dispatch({ type: 'SET_PLAN', driverId: 'c1', plan: { paceMode: 'push' } })).ok).toBe(true);
    expect(ctrl.stateAt()!.weekend!.plans.c1.strategyReview).toBeUndefined();
  });

  it('拒绝宽松 JSON、危险键和非法配方，且不修改策略', async () => {
    const before = JSON.stringify(ctrl.stateAt()!.weekend!.plans.c1);
    env.generateText = async () => `说明文字\n${changed}`;
    const wrapped = await ctrl.requestStrategyReview({ driverId: 'c1', expectedRevisionId: ctrl.status().revisionId! });
    expect(wrapped.ok).toBe(false);
    expect(JSON.stringify(ctrl.stateAt()!.weekend!.plans.c1)).toBe(before);

    env.generateText = async () => JSON.stringify({
      schemaVersion: 1, driverId: 'c1', verdict: 'changes_recommended', summary: 'x',
      issues: [{ code: 'legality', severity: 'warning', message: 'x' }],
      correctedPlan: { tyrePlan: ['__proto__', 'medium'], paceMode: 'balanced', pitTiming: 'standard', scReaction: true },
    });
    const invalidTyre = await ctrl.requestStrategyReview({ driverId: 'c1', expectedRevisionId: ctrl.status().revisionId! });
    expect(invalidTyre.ok).toBe(false);
    expect(JSON.stringify(ctrl.stateAt()!.weekend!.plans.c1)).toBe(before);
  });

  it('在等待或保留后安全丢弃候选，不推进状态', async () => {
    let release!: (text: string) => void;
    env.generateText = async () => new Promise<string>(resolve => { release = resolve; });
    const pending = ctrl.requestStrategyReview({ driverId: 'c1', expectedRevisionId: ctrl.status().revisionId! });
    await Promise.resolve();
    expect((await ctrl.dispatch({ type: 'SET_PLAN', driverId: 'c1', plan: { paceMode: 'push' } })).ok).toBe(true);
    release(changed);
    const stale = await pending;
    expect(stale.ok).toBe(false);
    expect(ctrl.stateAt()!.weekend!.plans.c1.paceMode).toBe('push');

    env.generateText = async () => changed;
    const review = await ctrl.requestStrategyReview({ driverId: 'c1', expectedRevisionId: ctrl.status().revisionId! });
    expect(review.ok).toBe(true);
    const kept = ctrl.discardStrategyReview({ reviewId: review.reviewId! });
    expect(kept).toMatchObject({ ok: true, api: 'secondary' });
    expect(ctrl.stateAt()!.weekend!.plans.c1.paceMode).toBe('push');
  });
});

describe('策略点评严格解析', () => {
  it('只接受单一对象或完整 JSON 围栏', () => {
    expect(parseStrategyReview(`\`\`\`json\n${changed}\n\`\`\``, 'c1').verdict).toBe('changes_recommended');
    expect(() => parseStrategyReview(`[${changed}]`, 'c1')).toThrow();
    expect(() => parseStrategyReview(JSON.stringify({ ...JSON.parse(changed), unknown: true }), 'c1')).toThrow();
    expect(() => parseStrategyReview(JSON.stringify({ ...JSON.parse(changed), driverId: 'other' }), 'c1')).toThrow();
  });
});
