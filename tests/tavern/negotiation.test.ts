import { describe, expect, it } from 'vitest';
import { NEGOTIATIONS, negotiationDefinition, parseNegotiationReply } from '../../src/tavern/negotiation';

describe('特殊事件多轮谈判协议', () => {
  it('只接受六类外部谈判', () => {
    expect(Object.keys(NEGOTIATIONS).sort()).toEqual([
      'aduo_alliance',
      'aston_honda',
      'fia_roundtable',
      'haas_toyota',
      'mercedes_politics',
      'red_bull_gp',
    ]);
    expect(negotiationDefinition('unknown')).toBeNull();
  });

  it('最低轮数前只能继续谈判', () => {
    const definition = NEGOTIATIONS.aduo_alliance;
    expect(() => parseNegotiationReply(
      '{"speaker":"法拉利代表","reply":"我们同意。","status":"agreement","choice":"alliance"}',
      definition,
      1,
      2,
      4,
    )).toThrow('至少需要 2 轮');
    expect(parseNegotiationReply(
      '{"speaker":"法拉利代表","reply":"先说明信息共享边界。","status":"continue","choice":null}',
      definition,
      1,
      2,
      4,
    )).toMatchObject({ status: 'continue', choice: null });
  });

  it('协议只能映射到事件白名单动作', () => {
    const definition = NEGOTIATIONS.fia_roundtable;
    const parsed = parseNegotiationReply(
      '前缀 {"speaker":"FIA 主持人","reply":"各方接受折中方案。","status":"agreement","choice":"compromise"} 后缀',
      definition,
      2,
      2,
      4,
    );
    expect(parsed.choice).toBe('compromise');
    expect(definition.choices[parsed.choice!].action).toEqual({ type: 'FIA_DEBATE', stance: 'compromise' });
    expect(() => parseNegotiationReply(
      '{"speaker":"FIA 主持人","reply":"直接增加一百点。","status":"agreement","choice":"cheat"}',
      definition,
      2,
      2,
      4,
    )).toThrow('非法结算选择');
  });

  it('第四轮必须结束谈判', () => {
    expect(() => parseNegotiationReply(
      '{"speaker":"Gianpiero Lambiase","reply":"我还要考虑。","status":"continue","choice":null}',
      NEGOTIATIONS.red_bull_gp,
      4,
      2,
      4,
    )).toThrow('必须在第 4 轮结算');
  });
});
