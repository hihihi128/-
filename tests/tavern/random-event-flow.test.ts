import { describe, expect, it } from 'vitest';
import { applyRandomEventResolution, setRandomEventContent, triggerWeekendRandomEvent } from '../../src/engine/randomEvents';
import { Rng } from '../../src/engine/rng';
import { parseRandomEventContent, parseRandomEventMainReply, parseRandomEventResolution } from '../../src/tavern/randomEventFlow';
import { newTestGame } from '../helpers';

describe('随机事件双 API 协议', () => {
  it('严格解析副 API 事件和主 API 角色回复', () => {
    expect(parseRandomEventContent('{"title":"供应商争议","prompt":"一批部件检测结果不一致，你如何处理？","answerOptions":["停用并复查","继续使用"]}')).toEqual({
      title: '供应商争议', prompt: '一批部件检测结果不一致，你如何处理？', answerOptions: ['停用并复查', '继续使用'],
    });
    expect(parseRandomEventMainReply('{"speaker":"质量主管","reply":"我建议先隔离问题批次。"}')).toEqual({ speaker: '质量主管', reply: '我建议先隔离问题批次。' });
    expect(() => parseRandomEventContent('{"title":"错误","prompt":"问题","answerOptions":["一个"],"constructor":true}')).toThrow('字段不正确');
  });

  it('只接受匹配事件 ID 和白名单效果', () => {
    const parsed = parseRandomEventResolution('{"eventId":"event-1","outcome":"resolved","summary":"处理完成。","effects":[{"op":"funds","targetId":null,"delta":2,"reason":"赞助支持"}]}', 'event-1');
    expect(parsed.effects[0]).toMatchObject({ op: 'funds', delta: 2 });
    expect(() => parseRandomEventResolution('{"eventId":"other","outcome":"resolved","summary":"处理完成。","effects":[]}', 'event-1')).toThrow('ID 不匹配');
    expect(() => parseRandomEventResolution('{"eventId":"event-1","outcome":"resolved","summary":"处理完成。","effects":[{"op":"flags","targetId":null,"delta":1,"reason":"非法"}]}', 'event-1')).toThrow('操作无效');
  });

  it('引擎拒绝越界效果和非玩家目标', () => {
    const state = newTestGame(77);
    state.rules.randomEvents = { noneWeight: 0, driverInjuryWeight: 1, windTunnelWeight: 0, partIssueWeight: 0 };
    triggerWeekendRandomEvent(state, new Rng(2));
    const event = state.randomEvents!.current!;
    setRandomEventContent(state, event.id, { title: event.title, prompt: event.prompt, answerOptions: ['谨慎', '激进'] });
    expect(applyRandomEventResolution(state, event.id, 'resolved', '越界。', [{ op: 'funds', targetId: null, delta: 50, reason: '过大' }]).ok).toBe(false);
    const rival = Object.values(state.drivers).find(driver => driver.teamId !== state.meta.playerTeamId)!;
    expect(applyRandomEventResolution(state, event.id, 'resolved', '非法目标。', [{ op: 'driver_morale', targetId: rival.id, delta: 2, reason: '不属于玩家' }]).ok).toBe(false);
    expect(event.status).toBe('awaiting_player');
  });
});
