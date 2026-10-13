import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('strategy mode interface', () => {
  const weekend = readFileSync(resolve(__dirname, '../../src/ui/panel/views/Weekend.vue'), 'utf8');
  const newGame = readFileSync(resolve(__dirname, '../../src/ui/panel/views/NewGame.vue'), 'utf8');
  const liveRace = readFileSync(resolve(__dirname, '../../src/ui/panel/components/LiveRaceDesk.vue'), 'utf8');

  it('shows player, engineer, and optional perfect AI strategy controls', () => {
    expect(weekend).toContain('玩家自己做策略');
    expect(weekend).toContain('听工程师');
    expect(weekend).toContain('完美策略 AI');
    expect(weekend).toContain('requestPerfectStrategy');
    expect(weekend).toContain('codex-fab');
    expect(weekend).toContain("d.plan.strategySource === 'perfect'");
    expect(weekend.match(/\(d\.plan\.strategySource \?\? 'player'\) === 'player'/g)).toHaveLength(3);
    expect(weekend).toContain('bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 12px)');
    expect(weekend).not.toContain('d.options.slice(0, 2)');
    expect(weekend).not.toContain('车队工程师建议');
    expect(weekend).toContain("strategySource: 'player', tyrePlan: [...customFor(d)], paceMode: 'balanced', pitTiming: 'standard', scReaction: true");
  });

  it('shows the reliability warning on new-game and strategy screens', () => {
    expect(newGame).toContain('工程师给的策略不一定靠谱');
    expect(weekend).toContain('工程师给的策略不一定靠谱');
    expect(newGame).toContain('策略部门历史表现不稳定');
    expect(weekend).toContain('当前策略人员的判断或风险偏好不稳定');
  });

  it('opens a red-flag tyre picker and keeps free wing repair visible', () => {
    expect(liveRace).toContain('免费换胎…');
    expect(liveRace).toContain('选择 {{ driverShort(tyrePickerDriverId) }} 的重启轮胎');
    expect(liveRace).toContain('role="dialog"');
    expect(liveRace).toContain('红旗下免费更换前翼');
  });
});
