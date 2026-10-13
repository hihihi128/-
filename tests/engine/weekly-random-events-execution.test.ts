import { describe, expect, it } from 'vitest';
import { applyRandomEventResolution, setRandomEventContent, triggerNextWeeklyRandomEvent } from '../../src/engine/randomEvents';
import { Rng } from '../../src/engine/rng';
import { newTestGame } from '../helpers';

function resolveCurrent(state: ReturnType<typeof newTestGame>, rng: Rng) {
  const event = triggerNextWeeklyRandomEvent(state, rng);
  expect(event).not.toBeNull();
  const current = event!;
  expect(setRandomEventContent(state, current.id, {
    title: current.title,
    prompt: current.prompt,
    answerOptions: ['处理', '跳过'],
  })).toBe(true);
  expect(applyRandomEventResolution(state, current.id, 'resolved', '已按计划处理。', []).ok).toBe(true);
}

describe('weekly random-event execution', () => {
  it.each([3, 4])('exhausts an exact %i-event weekly quota', quota => {
    const state = newTestGame(70_000 + quota);
    state.rules.randomEvents = {
      minPerWeek: quota, maxPerWeek: quota,
      routineWeight: 1, noneWeight: 0, driverInjuryWeight: 0, windTunnelWeight: 0, partIssueWeight: 0,
      minDialogueTurns: 2, maxDialogueTurns: 2,
    };
    const rng = new Rng(80_000 + quota);

    for (let index = 0; index < quota; index++) resolveCurrent(state, rng);

    expect(state.randomEvents).toMatchObject({ weeklyQuota: quota, weeklyStarted: quota });
    expect(state.randomEvents!.history).toHaveLength(quota);
    expect(triggerNextWeeklyRandomEvent(state, rng)).toBeNull();
  });

  it('closes an unanswered event and resets quota on week rollover', () => {
    const state = newTestGame(92_000);
    state.rules.randomEvents = {
      minPerWeek: 3, maxPerWeek: 3,
      routineWeight: 1, noneWeight: 0, driverInjuryWeight: 0, windTunnelWeight: 0, partIssueWeight: 0,
      minDialogueTurns: 2, maxDialogueTurns: 2,
    };
    const rng = new Rng(93_000);
    const original = triggerNextWeeklyRandomEvent(state, rng)!;
    expect(setRandomEventContent(state, original.id, {
      title: original.title,
      prompt: original.prompt,
      answerOptions: ['处理'],
    })).toBe(true);

    state.season.week += 1;
    const next = triggerNextWeeklyRandomEvent(state, rng)!;

    expect(next.id).not.toBe(original.id);
    expect(state.randomEvents).toMatchObject({ weeklyQuota: 3, weeklyStarted: 1, current: { id: next.id } });
    expect(state.randomEvents!.history.find(event => event.id === original.id)).toMatchObject({ status: 'unresolved', effects: [] });
  });

  it('keeps default routine selection in the 76–84% band over 10,000 weeks', () => {
    const state = newTestGame(90_000);
    const rng = new Rng(91_000);
    let routine = 0;
    const total = 10_000;

    for (let week = 0; week < total; week++) {
      state.season.week = week;
      const event = triggerNextWeeklyRandomEvent(state, rng);
      expect(event).not.toBeNull();
      expect(['routine', 'problem']).toContain(event!.category);
      if (event!.category === 'routine') routine++;
    }

    expect(routine / total).toBeGreaterThanOrEqual(0.76);
    expect(routine / total).toBeLessThanOrEqual(0.84);
  });
});
