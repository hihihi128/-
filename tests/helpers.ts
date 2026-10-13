import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { normalizeDatabase, type RawSource } from '../src/engine/data';
import { createGame } from '../src/engine/newgame';
import { dispatch } from '../src/engine/actions';
import type { Action, Database, GameState } from '../src/engine/types';

const WB = resolve(__dirname, '../src/card/worldbook');
const FIXTURES = resolve(__dirname, 'fixtures');

/** 角色卡实际携带的世界书数据（2026 真实车队与车手） */
export const CARD_DATA_FILES: Array<[string, string]> = [
  ['[F1M数据] 规则', resolve(WB, 'data-rules.yaml')],
  ['[F1M数据] 车队', resolve(WB, 'data-teams.yaml')],
  ['[F1M数据] 车手', resolve(WB, 'data-drivers.yaml')],
  ['[F1M数据] 赛道', resolve(WB, 'data-tracks.yaml')],
  ['[F1M数据] 赛历', resolve(WB, 'data-calendar.yaml')],
];

/**
 * 测试用数据：车队与车手使用固定的占位数据（tests/fixtures），
 * 这样调整角色卡里的真实数值不会让引擎测试失效。
 */
export const DATA_FILES: Array<[string, string]> = CARD_DATA_FILES.map(([name, file]) => [
  name,
  name === '[F1M数据] 车队'
    ? resolve(FIXTURES, 'placeholder-teams.yaml')
    : name === '[F1M数据] 车手'
      ? resolve(FIXTURES, 'placeholder-drivers.yaml')
      : file,
]);

function readSources(files: Array<[string, string]>): RawSource[] {
  return files.map(([name, file]) => ({ name, data: YAML.parse(readFileSync(file, 'utf8')) }));
}

export function placeholderSources(): RawSource[] {
  return readSources(DATA_FILES);
}

export function cardSources(): RawSource[] {
  return readSources(CARD_DATA_FILES);
}

export function placeholderDb(): Database {
  const res = normalizeDatabase(placeholderSources());
  if (!res.canStart || !res.db) throw new Error(JSON.stringify(res.issues, null, 2));
  return res.db;
}

export function newTestGame(seed = 12345, playerTeamId = 'team_c'): GameState {
  return createGame(placeholderDb(), { playerTeamId, principalName: '测试领队', seed, gameId: 'gtest', now: 1_700_000_000_000 });
}

export function act(state: GameState, action: Action): GameState {
  const res = dispatch(state, action, { now: 1 });
  if (!res.ok) throw new Error(`${action.type} 失败：${res.message}`);
  return res.state;
}

export function tryAct(state: GameState, action: Action) {
  return dispatch(state, action, { now: 1 });
}

/** 一路 ADVANCE 直到满足条件 */
export function advanceUntil(state: GameState, pred: (s: GameState) => boolean, max = 500): GameState {
  let s = state;
  for (let i = 0; i < max && !pred(s); i++) {
    if (s.fiaMeeting?.current) s = act(s, { type: 'FIA_DEBATE', stance: 'compromise' });
    else if (s.weekend?.practiceReturn) {
      const team = s.teams[s.meta.playerTeamId];
      const request = s.weekend.practiceReturn;
      const driverId = request.driverIds[0];
      const setIds = (team.tyreInventory?.[driverId] ?? []).filter(set => !set.returned && set.roundIndex === s.season.roundIndex).slice(0, request.required).map(set => set.id);
      s = act(s, { type: 'RETURN_PRACTICE_TYRES', driverId, setIds });
    }
    else s = act(s, { type: 'ADVANCE' });
  }
  if (!pred(s)) throw new Error('advanceUntil: 条件未满足');
  return s;
}
