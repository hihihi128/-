import { describe, expect, it } from 'vitest';
import { strategyDisobedienceChance, teammateRelationship } from '../../src/engine/driverBehavior';
import { newTestGame } from '../helpers';

describe('车手策略抗命', () => {
  it('队友关系由两位车手状态推算，不写入额外存档字段', () => {
    const state = newTestGame();
    const initial = teammateRelationship(state, 'team_c');
    state.drivers.c1.trust = 20;
    state.drivers.c1.morale = 10;
    expect(teammateRelationship(state, 'team_c')).toBeLessThan(initial);
  });

  it('只在信任或队友关系低于阈值时产生动态概率', () => {
    const state = newTestGame();
    const driver = state.drivers.c1;
    driver.trust = 55;
    expect(strategyDisobedienceChance(driver, 60)).toBe(0);
    driver.trust = 39;
    const smallRisk = strategyDisobedienceChance(driver, 60);
    driver.trust = 10;
    expect(strategyDisobedienceChance(driver, 60)).toBeGreaterThan(smallRisk);
    driver.trust = 55;
    expect(strategyDisobedienceChance(driver, 30)).toBeGreaterThan(0);
  });
});
