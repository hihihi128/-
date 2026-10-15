import { describe, expect, it } from 'vitest';
import { fanGap, ferrariOnAllocation, ferrariOnOrder } from '../../src/engine/ferrari';
import { buildStatePrompt } from '../../src/engine/prompt';
import { applyAiCommands } from '../../src/engine/protocol';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { act, advanceUntil, newTestGame, tryAct } from '../helpers';

const ferrariGame = (seed = 12345): GameState => newTestGame(seed, 'ferrari');

describe('法拉利：过渡领队机制', () => {
  it('选择法拉利时初始化媒体支持率与两边粉丝意见', () => {
    const s = ferrariGame();
    const r = s.rules.ferrari;
    expect(s.teams.ferrari.special).toBe('ferrari');
    expect(s.teams.ferrari.mediaReputation).toBe(r.startMedia);
    expect(s.ferrari).toMatchObject({ fans: { hamilton: r.startFans, leclerc: r.startFans }, dismissed: null });
    expect(s.news.some(n => n.text.includes('过渡领队') && n.text.includes('瓦塞尔'))).toBe(true);
    expect(s.narration[0].title).toContain('过渡领队');
    const v = buildView(s);
    expect(v.ferrari).toMatchObject({ media: r.startMedia, gap: 0, dismissed: null, graceLeft: r.graceRounds });
    expect(buildStatePrompt(s)).toContain('法拉利·过渡领队考核');
  });

  it('其他玩家看不到法拉利机制，但法拉利 AI 仍保留状态', () => {
    const s = newTestGame();
    expect(s.ferrari ?? null).not.toBeNull();
    expect(buildView(s).ferrari ?? null).toBeNull();
    expect(buildStatePrompt(s)).not.toContain('过渡领队考核');
    expect(buildStatePrompt(s)).not.toContain('"op":"fans"');
  });

  it('指定优先车手：被选中一方粉丝上升，另一方下降', () => {
    const s = act(ferrariGame(), { type: 'SET_PRIORITY', driverId: 'hamilton' });
    const r = s.rules.ferrari;
    expect(s.ferrari!.fans.hamilton).toBe(r.startFans + r.priorityFans);
    expect(s.ferrari!.fans.leclerc).toBeCloseTo(r.startFans - r.priorityFans * 1.2, 1);
    expect(s.news.some(n => n.tag === '粉丝')).toBe(true);
  });

  it('升级件分配与车队指令影响粉丝', () => {
    const s = ferrariGame();
    const r = s.rules.ferrari;
    ferrariOnAllocation(s, 'leclerc', 'hamilton', 2);
    expect(s.ferrari!.fans.hamilton).toBe(r.startFans - r.allocationFans * 2);
    expect(s.ferrari!.fans.leclerc).toBe(r.startFans + r.allocationFans);
    const m0 = s.teams.ferrari.mediaReputation;
    ferrariOnOrder(s, 'hamilton', 'leclerc', true);
    expect(s.ferrari!.fans.hamilton).toBe(r.startFans - r.allocationFans * 2 - r.orderFans);
    expect(s.teams.ferrari.mediaReputation).toBe(m0 - 1);
    expect(fanGap(s.ferrari!)).toBeGreaterThan(10);
    expect(s.ferrari!.log.length).toBeGreaterThanOrEqual(2);
  });

  it('适应期内只警告，不撤职', () => {
    const s = ferrariGame(41);
    s.teams.ferrari.mediaReputation = 0;
    const after = advanceUntil(s, x => x.season.phase === 'post_race');
    expect(after.ferrari!.dismissed).toBeNull();
    expect(after.flags.fired).toBeFalsy();
    expect(after.narration.some(n => n.kind === 'ferrari_pressure' && n.detail.includes('适应期'))).toBe(true);
  });

  it('适应期后媒体支持率过低 → 撤职，之后只能清空待叙述事件', () => {
    const s = ferrariGame(41);
    s.rules.ferrari.graceRounds = 0;
    s.teams.ferrari.mediaReputation = 0;
    const after = advanceUntil(s, x => x.season.phase === 'post_race');
    expect(after.ferrari!.dismissed).toContain('媒体支持率');
    expect(after.flags.fired).toBe(true);
    expect(after.narration.some(n => n.kind === 'fired')).toBe(true);
    expect(buildView(after).ferrari!.dismissed).toBeTruthy();
    const blocked = tryAct(after, { type: 'ADVANCE' });
    expect(blocked.ok).toBe(false);
    expect(tryAct(after, { type: 'SET_PRIORITY', driverId: 'leclerc' }).ok).toBe(false);
    expect(tryAct(after, { type: 'CLEAR_NARRATION' }).ok).toBe(true);
    expect(buildStatePrompt(after)).toContain('撤');
  });

  it('适应期后两边粉丝意见差距过大 → 撤职', () => {
    const s = ferrariGame(41);
    s.rules.ferrari.graceRounds = 0;
    s.teams.ferrari.mediaReputation = 90;
    s.ferrari!.fans = { hamilton: 95, leclerc: 40 };
    const after = advanceUntil(s, x => x.season.phase === 'post_race');
    expect(after.ferrari!.dismissed).toContain('粉丝');
  });

  it('正常情况下第一站后不会被撤职，并生成媒体与粉丝反应', () => {
    const after = advanceUntil(ferrariGame(41), x => x.season.phase === 'post_race');
    expect(after.ferrari!.dismissed).toBeNull();
    expect(after.narration.some(n => n.kind === 'ferrari_pressure')).toBe(true);
  });
});

describe('法拉利：AI 粉丝指令', () => {
  it('只在法拉利存档有效，并受单条消息上限约束', () => {
    const s = ferrariGame();
    const limit = s.rules.aiLimits.fans;
    const logs = applyAiCommands(
      s,
      [
        { op: 'fans', driver: 'hamilton', delta: 4 },
        { op: 'fans', driver: 'hamilton', delta: 4 },
        { op: 'fans', driver: 'giovinazzi', delta: 3 },
      ],
      { messageId: 1 },
    );
    expect(s.ferrari!.fans.hamilton).toBe(s.rules.ferrari.startFans + limit);
    expect(logs[2].ok).toBe(false);

    const other = newTestGame();
    const l2 = applyAiCommands(other, [{ op: 'fans', driver: 'hamilton', delta: 3 }], { messageId: 1 });
    expect(other.ferrari!.fans.hamilton).toBe(other.rules.ferrari.startFans);
    expect(l2[0].ok).toBe(false);
  });

  it('AI 不能改写撤职标记', () => {
    const s = ferrariGame();
    const logs = applyAiCommands(s, [{ op: 'flag', key: 'firedReason', value: 'x' }], { messageId: 1 });
    expect(logs[0].ok).toBe(false);
  });
});
