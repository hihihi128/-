import { setRandomEventContent, triggerNextWeeklyRandomEvent } from '../../src/engine/randomEvents';
import { Rng } from '../../src/engine/rng';
import type { GameState, RandomEventEffect, RandomEventRecord, RandomEventRules } from '../../src/engine/types';
import { newTestGame } from '../helpers';

/** Default rule set for deterministic weekly-event tests. */
export const WEEKLY_EVENT_RULES: RandomEventRules = {
  minPerWeek: 3,
  maxPerWeek: 3,
  routineWeight: 80,
  noneWeight: 0,
  driverInjuryWeight: 7,
  windTunnelWeight: 6,
  partIssueWeight: 7,
  minDialogueTurns: 2,
  maxDialogueTurns: 2,
};

export function weeklyEventRules(overrides: Partial<RandomEventRules> = {}): RandomEventRules {
  return { ...WEEKLY_EVENT_RULES, ...overrides };
}

export function configureWeeklyEvents(state: GameState, overrides: Partial<RandomEventRules> = {}): GameState {
  state.rules.randomEvents = weeklyEventRules(overrides);
  return state;
}

/**
 * Creates an event that has already passed event-content generation and is ready
 * for a player answer. Tests can choose category, quota, and turn count solely
 * through rule weights instead of relying on ambient defaults.
 */
export function readyWeeklyEventFixture(options: {
  seed?: number;
  playerTeamId?: string;
  rules?: Partial<RandomEventRules>;
} = {}): { state: GameState; rng: Rng; event: RandomEventRecord } {
  const state = newTestGame(options.seed ?? 7001, options.playerTeamId);
  configureWeeklyEvents(state, options.rules);
  const rng = new Rng(options.seed ?? 7001);
  const event = triggerNextWeeklyRandomEvent(state, rng);
  if (!event) throw new Error('weekly event fixture did not start an event');
  setRandomEventContent(state, event.id, {
    title: event.category === 'routine' ? '工程师的午餐邀请' : '供应商检测争议',
    prompt: event.category === 'routine'
      ? '这是一件不影响比赛周末的日常小事。'
      : '一批关键零件的检测结果不一致。',
    answerOptions: ['谨慎沟通并跟进', '立即安排负责人处理'],
  });
  return { state, rng, event };
}

export function routineAffinityEffect(targetId: string, delta = 0.05): RandomEventEffect {
  return { op: 'affinity', targetId, delta, reason: '日常交流改变了彼此的了解程度' };
}

/** A pre-f8e02c5-shaped save for migration coverage. */
export function legacyWeeklyEventState(seed = 7002): GameState {
  const state = newTestGame(seed);
  state.rules.randomEvents = {
    noneWeight: 52,
    driverInjuryWeight: 14,
    windTunnelWeight: 17,
    partIssueWeight: 17,
  };
  state.randomEvents = {
    lastRoundKey: '2026-0',
    current: {
      id: 'legacy-current-event',
      roundKey: '2026-0',
      kind: 'driver_injury',
      status: 'awaiting_player',
      title: '旧存档训练安排',
      detail: '车手需要调整训练负荷。',
      prompt: '车手需要调整训练负荷。',
      answerOptions: ['安排复查'],
      playerAnswer: null,
      mainReply: null,
      outcomeSummary: null,
      effects: [],
      generationError: null,
    } as unknown as RandomEventRecord,
    history: [{
      id: 'legacy-resolved-event',
      roundKey: '2026-0',
      kind: 'wind_tunnel_data',
      status: 'resolved',
      title: '旧存档风洞事件',
      detail: '数据复核完成。',
      prompt: '数据复核完成。',
      answerOptions: [],
      playerAnswer: '安排复核',
      mainReply: '工程师确认数据可靠。',
      outcomeSummary: null,
      effects: [],
      generationError: null,
    } as unknown as RandomEventRecord],
  } as unknown as GameState['randomEvents'];
  for (const driver of Object.values(state.drivers)) delete (driver as Partial<typeof driver>).affinity;
  for (const team of Object.values(state.teams)) {
    for (const staff of Object.values(team.staff)) delete (staff as Partial<typeof staff>).affinity;
  }
  return state;
}
