import { describe, expect, it } from 'vitest';
import { applyRandomEventResolution, closeUnansweredRandomEvent, setRandomEventContent, triggerWeekendRandomEvent } from '../../src/engine/randomEvents';
import { Rng } from '../../src/engine/rng';
import { parseRandomEventContent, parseRandomEventResolution, randomEventGenerationPrompt, randomEventNarrationMessage } from '../../src/tavern/randomEventFlow';
import { newTestGame } from '../helpers';

describe('随机事件双 API 协议', () => {
  it('严格解析副 API 事件，并让主 API 正常聊天叙述', () => {
    expect(parseRandomEventContent('{"title":"供应商争议","prompt":"一批部件检测结果不一致，你如何处理？","answerOptions":["停用并复查","继续使用"]}')).toEqual({
      title: '供应商争议', prompt: '一批部件检测结果不一致，你如何处理？', answerOptions: ['停用并复查', '继续使用'],
    });
    expect(() => parseRandomEventContent('{"title":"错误","prompt":"问题","answerOptions":["一个"],"constructor":true}')).toThrow('字段不正确');
    const state = newTestGame(3);
    const event = { ...state.randomEvents?.current, id: 'event-1', title: '供应商争议', prompt: '一批部件检测结果不一致。' } as any;
    expect(randomEventNarrationMessage(state, event, '停用并复查')).toContain('不要返回 JSON');
  });

  it('随机事件编剧只接收员工定性信息并禁止输出内部评分', () => {
    const state = newTestGame(9);
    state.rules.randomEvents = { noneWeight: 0, driverInjuryWeight: 0, windTunnelWeight: 0, partIssueWeight: 1 };
    triggerWeekendRandomEvent(state, new Rng(2));
    const prompt = randomEventGenerationPrompt(state, state.randomEvents!.current!);
    expect(prompt).toContain('内部评分');
    expect(prompt).toContain('只能使用姓名、职务和定性表现');
    expect(prompt).toContain('"experience"');
    expect(prompt).not.toContain('"skill"');
  });

  it('后续轮次依靠正常聊天记录衔接，不把此前正文再次塞进叙述请求', () => {
    const state = newTestGame(12);
    const event = {
      ...state.randomEvents?.current,
      id: 'event-repeat',
      title: '训练计划复查',
      prompt: '医疗组建议分三步确认训练负荷。',
      completedDialogueTurns: 1,
      totalDialogueTurns: 3,
      dialogue: [{ player: '先安排复查。', assistant: '医疗主管完成第一轮负荷评估。' }],
    } as any;

    const message = randomEventNarrationMessage(state, event, '继续确认恢复情况。');

    expect(message).toContain('此前轮次已经在上方正常聊天记录中');
    expect(message).toContain('只输出本轮新发生的剧情正文');
    expect(message).not.toContain('医疗组建议分三步确认训练负荷。');
    expect(message).not.toContain('先安排复查。');
    expect(message).not.toContain('医疗主管完成第一轮负荷评估。');
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
    expect(applyRandomEventResolution(state, event.id, 'resolved', '叠加越界。', [
      { op: 'funds', targetId: null, delta: 2, reason: '一' },
      { op: 'funds', targetId: null, delta: 2, reason: '二' },
      { op: 'funds', targetId: null, delta: 2, reason: '三' },
    ]).ok).toBe(false);
    const rival = Object.values(state.drivers).find(driver => driver.teamId !== state.meta.playerTeamId)!;
    expect(applyRandomEventResolution(state, event.id, 'resolved', '非法目标。', [{ op: 'driver_morale', targetId: rival.id, delta: 2, reason: '不属于玩家' }]).ok).toBe(false);
    const project = state.teams[state.meta.playerTeamId].projects[0];
    if (project) expect(applyRandomEventResolution(state, event.id, 'resolved', '小数周。', [{ op: 'project_weeks', targetId: project.id, delta: .5, reason: '无效小数' }]).ok).toBe(false);
    expect(event.status).toBe('awaiting_player');
  });

  it('closes an unanswered fallback event without effects at round end', () => {
    const state = newTestGame(12);
    state.rules.randomEvents = { noneWeight: 0, driverInjuryWeight: 1, windTunnelWeight: 0, partIssueWeight: 0 };
    triggerWeekendRandomEvent(state, new Rng(2));
    const event = state.randomEvents!.current!;
    setRandomEventContent(state, event.id, { title: event.title, prompt: event.prompt, answerOptions: ['谨慎', '激进'] }, '副 API 未配置');
    const funds = state.teams[state.meta.playerTeamId].funds;
    closeUnansweredRandomEvent(state);
    expect(event).toMatchObject({ status: 'unresolved', effects: [] });
    expect(state.randomEvents!.history.at(-1)?.status).toBe('unresolved');
    expect(state.teams[state.meta.playerTeamId].funds).toBe(funds);
  });
});
