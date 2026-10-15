import { buildView, type GameView, type LiveRaceView } from '../../src/engine/view';
import { act, advanceUntil, newTestGame } from '../helpers';

export const IMPORTANT_RACE_PAUSES = [
  ['grid', '发车'],
  ['pit_opportunity', '进站机会'],
  ['weather_change', '天气变化'],
  ['sc', '安全车'],
  ['vsc', '虚拟安全车'],
  ['red_flag', '红旗暂停'],
  ['incident', '事故与损伤'],
] as const;

export type ImportantRacePause = (typeof IMPORTANT_RACE_PAUSES)[number][0];

/**
 * Start a deterministic live race, then expose only the public view shape used
 * by the panel. UI tests can override the public decision reason without
 * relying on random incidents or weather during a simulated race.
 */
function baseLiveRaceView(): GameView {
  let state = advanceUntil(newTestGame(20261014), current => current.season.phase === 'race');
  state = act(state, { type: 'START_RACE', kind: 'race' });
  const view = buildView(state);
  if (!view.weekend?.liveRace?.pendingDecision) throw new Error('live-race fixture did not produce the grid decision');
  return structuredClone(view);
}

function requireLive(view: GameView): LiveRaceView {
  const live = view.weekend?.liveRace;
  if (!live) throw new Error('live-race fixture is missing its public live-race view');
  return live;
}

export function narrationPauseView(reason: ImportantRacePause): GameView {
  const view = baseLiveRaceView();
  requireLive(view).pendingDecision!.reasons = [reason];
  return view;
}

/** The engine removes liveRace when a race finishes; result narration is queued in post_race. */
export function postRaceNarrationView(): GameView {
  let state = advanceUntil(newTestGame(20261014), current => current.season.phase === 'race');
  state = act(state, { type: 'RUN_RACE' });
  if (state.season.phase !== 'post_race' || !state.narration.some(item => /正赛结果$/.test(item.title))) {
    throw new Error('post-race fixture did not produce a queued race-result narration');
  }
  return buildView(state);
}

export function runningLiveRaceView(): GameView {
  const view = baseLiveRaceView();
  const live = requireLive(view);
  live.stage = 'running';
  live.pendingDecision = null;
  return view;
}
