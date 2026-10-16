import { describe, expect, it } from 'vitest';
import { strategyDecisionSkill } from '../../src/engine/staff';
import { cardSources } from '../helpers';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { severeDryChaosProbability, severeWeatherChaosProbability } from '../../src/engine/race';

describe('2026 车队策略组层级', () => {
  it('保持红牛、梅奔、其他车队、小红牛、迈凯伦、马丁、法拉利的严格顺序', () => {
    const loaded = normalizeDatabase(cardSources());
    if (!loaded.db) throw new Error('card database failed to load');
    const state = createGame(loaded.db, { playerTeamId: 'cadillac', principalName: '测试领队', seed: 42, gameId: 'strategy-order', now: 1 });
    const scores = (ids: string[]) => ids.flatMap(id => [1, 2].map(slot => strategyDecisionSkill(state.teams[id], slot)));
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

  it('只让后三个策略组出现严重天气换胎反复', () => {
    const loaded = normalizeDatabase(cardSources());
    if (!loaded.db) throw new Error('card database failed to load');
    const state = createGame(loaded.db, { playerTeamId: 'cadillac', principalName: '测试领队', seed: 43, gameId: 'weather-chaos', now: 1 });
    for (const id of ['red_bull', 'mercedes', 'williams', 'haas', 'audi', 'alpine', 'cadillac', 'racing_bulls']) {
      expect(severeWeatherChaosProbability(state.teams[id])).toBe(0);
    }
    expect(severeWeatherChaosProbability(state.teams.mclaren)).toBeCloseTo(.315, 3);
    expect(severeWeatherChaosProbability(state.teams.aston_martin)).toBeCloseTo(.57, 3);
    expect(severeWeatherChaosProbability(state.teams.ferrari)).toBe(.75);
    expect(severeDryChaosProbability(state.teams.mclaren)).toBeCloseTo(.21, 3);
    expect(severeDryChaosProbability(state.teams.aston_martin)).toBeCloseTo(.38, 3);
    expect(severeDryChaosProbability(state.teams.ferrari)).toBe(.5);
  });

  it('uses actual strategist abilities for eligible probability boundaries and caps Ferrari', () => {
    const loaded = normalizeDatabase(cardSources());
    if (!loaded.db) throw new Error('card database failed to load');
    const state = createGame(loaded.db, { playerTeamId: 'cadillac', principalName: '测试领队', seed: 44, gameId: 'weather-chaos-boundaries', now: 1 });
    const setStrategyAbilities = (teamId: string, value: number) => {
      const strategist = state.teams[teamId].staff.strategist;
      state.teams[teamId].staff.strategist = {
        ...strategist,
        abilities: { ...strategist.abilities, strategy: value, weather: value, reaction: value },
      };
    };

    setStrategyAbilities('mclaren', 70);
    setStrategyAbilities('aston_martin', 60);
    expect(severeWeatherChaosProbability(state.teams.mclaren)).toBeCloseTo(.3, 6);
    expect(severeWeatherChaosProbability(state.teams.aston_martin)).toBeCloseTo(.6, 6);

    setStrategyAbilities('ferrari', 1);
    expect(severeWeatherChaosProbability(state.teams.ferrari)).toBe(.75);
    setStrategyAbilities('ferrari', 56);
    expect(severeWeatherChaosProbability(state.teams.ferrari)).toBeCloseTo(.72, 6);

    setStrategyAbilities('mclaren', 100);
    setStrategyAbilities('aston_martin', 100);
    setStrategyAbilities('ferrari', 100);
    setStrategyAbilities('red_bull', 1);
    expect(severeWeatherChaosProbability(state.teams.mclaren)).toBe(0);
    expect(severeWeatherChaosProbability(state.teams.aston_martin)).toBe(0);
    expect(severeWeatherChaosProbability(state.teams.ferrari)).toBe(0);
    expect(severeWeatherChaosProbability(state.teams.red_bull)).toBe(0);
  });
});
