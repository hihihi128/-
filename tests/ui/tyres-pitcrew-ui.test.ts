import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('tyre inventory and pit-stop interface', () => {
  const weekend = readFileSync(resolve(__dirname, '../../src/ui/panel/views/Weekend.vue'), 'utf8');
  const development = readFileSync(resolve(__dirname, '../../src/ui/panel/views/Development.vue'), 'utf8');
  const liveRace = readFileSync(resolve(__dirname, '../../src/ui/panel/components/LiveRaceDesk.vue'), 'utf8');

  it('shows selectable practice returns and set condition', () => {
    expect(weekend).toContain("RETURN_PRACTICE_TYRES");
    expect(weekend).toContain('实体轮胎库存');
    expect(weekend).toContain("set.state === 'new' ? '新' : '已用'");
    expect(weekend).toContain('set.returnEligible');
    expect(weekend).toContain('确认交回');
  });

  it('shows focused crew training and predicted versus actual stop times', () => {
    expect(development).toContain('error_control');
    expect(development).toContain('稳定性：缩小时间波动');
    expect(liveRace).toContain('预计 {{ car.predictedStationary.toFixed(1) }}s');
    expect(liveRace).toContain("car.tyreState === 'new' ? '新胎' : '已用'");
    expect(weekend).toContain('静止时间（预估/实际）');
  });
});
