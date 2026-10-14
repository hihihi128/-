import { describe, expect, it } from 'vitest';
import { dispatch } from '../../src/engine/actions';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { NEGOTIATIONS, negotiationDefinition, parseNegotiationReply } from '../../src/tavern/negotiation';
import { cardSources } from '../helpers';

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
    expect(negotiationDefinition('toString')).toBeNull();
    expect(negotiationDefinition('__proto__')).toBeNull();
  });

  it('最低轮数前只能继续谈判', () => {
    const definition = NEGOTIATIONS.aduo_alliance;
    expect(() => parseNegotiationReply(
      '{"speaker":"ADUO 联盟协调代表","reply":"我们同意。","status":"agreement","choice":"alliance"}',
      definition,
      1,
      2,
      4,
    )).toThrow('至少需要 2 轮');
    expect(parseNegotiationReply(
      '{"speaker":"ADUO 联盟协调代表","reply":"先说明信息共享边界。","status":"continue","choice":null}',
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
    expect(() => parseNegotiationReply(
      '{"speaker":"FIA 主持人","reply":"采用继承属性。","status":"agreement","choice":"constructor"}',
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

  it('每个事件的每个协议选择都能驱动其白名单引擎动作', () => {
    const loaded = normalizeDatabase(cardSources());
    if (!loaded.db) throw new Error('card database failed to load');
    const teams = {
      aduo_alliance: 'audi', fia_roundtable: 'audi', mercedes_politics: 'mercedes',
      aston_honda: 'aston_martin', red_bull_gp: 'red_bull', haas_toyota: 'haas',
    } as const;

    for (const definition of Object.values(NEGOTIATIONS)) {
      for (const choice of Object.keys(definition.choices)) {
        const state = createGame(loaded.db, { playerTeamId: teams[definition.kind], principalName: '测试领队', seed: 321, gameId: `${definition.kind}-${choice}`, now: 1 });
        if (definition.kind === 'fia_roundtable') state.fiaMeeting!.current = { index: 0, issue: 'aduo', opponents: ['ferrari'] };
        const parsed = parseNegotiationReply(JSON.stringify({ speaker: definition.participants[0], reply: '接受该协议。', status: 'agreement', choice }), definition, 2, 2, 4);
        const result = dispatch(state, definition.choices[parsed.choice!].action!, { now: 1 });
        expect(result.ok, `${definition.kind}/${choice}`).toBe(true);
        const next = result.state;
        switch (definition.kind) {
          case 'aduo_alliance':
            expect(next.audi?.alliance).toBe(true);
            expect(next.audi!.aduoProgress).toBeGreaterThan(state.audi!.aduoProgress);
            expect(next.audi!.politicalSupport).toBeGreaterThan(state.audi!.politicalSupport);
            break;
          case 'fia_roundtable':
            expect(next.fiaMeeting?.current).toBeNull();
            expect(next.fiaMeeting?.completed).toBe(1);
            expect(next.fiaMeeting?.politicalCapital).not.toBe(state.fiaMeeting?.politicalCapital);
            break;
          case 'mercedes_politics':
            expect(next.mercedes?.lastActionRound).toBeTruthy();
            if (choice === 'lobby_aduo') expect(next.mercedes!.aduoProgress).toBeGreaterThan(state.mercedes!.aduoProgress);
            else expect(next.mercedes!.politicalPressure).toBeLessThan(state.mercedes!.politicalPressure);
            if (choice === 'compromise') expect(next.mercedes!.totoSatisfaction).toBeLessThan(state.mercedes!.totoSatisfaction);
            break;
          case 'aston_honda':
            expect(next.astonMartin?.lastActionRound).toBeTruthy();
            if (choice === 'pressure_honda') expect(next.astonMartin!.aduoProgress).toBeGreaterThan(state.astonMartin!.aduoProgress);
            if (choice === 'mediate') expect(next.astonMartin!.hondaConflict).toBeLessThan(state.astonMartin!.hondaConflict);
            if (choice === 'push_newey') expect(next.astonMartin!.neweyProgress).toBeGreaterThan(state.astonMartin!.neweyProgress);
            break;
          case 'red_bull_gp':
            expect(next.redBull!.gpRetention).toBeGreaterThan(state.redBull!.gpRetention);
            expect(next.teams.red_bull.funds).toBeLessThan(state.teams.red_bull.funds);
            expect(next.redBull?.lastActionRound).toBeTruthy();
            break;
          case 'haas_toyota':
            expect(next.haas?.lastActionRound).toBeTruthy();
            if (choice === 'protect_independence') {
              expect(next.haas!.geneSupport).toBeGreaterThan(state.haas!.geneSupport);
              expect(next.haas!.toyotaSupport).toBeLessThan(state.haas!.toyotaSupport);
              expect(next.haas!.toyotaInfluence).toBeLessThan(state.haas!.toyotaInfluence);
            } else {
              expect(next.haas!.toyotaSupport).toBeGreaterThan(state.haas!.toyotaSupport);
              expect(next.teams.haas.funds).toBeGreaterThan(state.teams.haas.funds);
              expect(next.haas!.toyotaInfluence).toBeGreaterThan(state.haas!.toyotaInfluence);
            }
            break;
        }
      }
    }
  });
});
