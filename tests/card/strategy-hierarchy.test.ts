import { describe, expect, it } from 'vitest';
import { strategyDecisionSkill } from '../../src/engine/staff';
import { cardSources } from '../helpers';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';

describe('2026 车队策略组层级', () => {
  it('保持红牛、梅奔、其他车队、小红牛、迈凯伦、马丁、法拉利的严格顺序', () => {
    const loaded = normalizeDatabase(cardSources());
    if (!loaded.db) throw new Error('card database failed to load');
    const state = createGame(loaded.db, { playerTeamId: 'cadillac', principalName: '测试领队', seed: 42, gameId: 'strategy-order', now: 1 });
    const scores = (ids: string[]) => ids.flatMap(id => [0, 1].map(slot => strategyDecisionSkill(state.teams[id], slot)));
    const tiers = [
      scores(['red_bull']),
      scores(['mercedes']),
      scores(['williams', 'haas', 'audi', 'alpine', 'cadillac']),
      scores(['racing_bulls']),
      scores(['mclaren']),
      scores(['aston_martin']),
      scores(['ferrari']),
    ];
    for (let index = 0; index < tiers.length - 1; index++) {
      expect(Math.min(...tiers[index])).toBeGreaterThan(Math.max(...tiers[index + 1]));
    }
  });
});
