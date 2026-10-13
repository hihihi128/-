import { describe, expect, it } from 'vitest';
import { F1Controller } from '../../src/tavern/controller';
import { cardWorldbook, FakeTavern } from './fakeEnv';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('three-turn random-event adjudication', () => {
  it('waits for the third matching narration before adjudicating all dialogue', async () => {
    const env = new FakeTavern(cardWorldbook());
    const ctrl = new F1Controller(env);
    ctrl.init();
    await ctrl.loadData();
    expect((await ctrl.newGame({ playerTeamId: 'haas', seed: 96 })).ok).toBe(true);

    const save = JSON.parse(ctrl.exportSave()!);
    save.state.season.phase = 'pre_race';
    save.state.rules.randomEvents = {
      minPerWeek: 3, maxPerWeek: 3,
      routineWeight: 0, noneWeight: 0, driverInjuryWeight: 1, windTunnelWeight: 0, partIssueWeight: 0,
      minDialogueTurns: 3, maxDialogueTurns: 3,
    };
    expect((await ctrl.importSave(JSON.stringify(save))).ok).toBe(true);
    ctrl.updateSettings({ engineerProxyPreset: '随机事件副线', engineerModel: 'event-model' });

    let calls = 0;
    let resolutionPrompt = '';
    env.generateText = async prompt => {
      calls++;
      if (calls === 1) return '{"title":"训练计划复查","prompt":"医疗组建议分三步确认训练负荷。","answerOptions":["先安排复查"]}';
      resolutionPrompt = prompt;
      return `{"eventId":"${ctrl.stateAt()!.randomEvents!.current!.id}","outcome":"resolved","summary":"三轮复查全部完成。","effects":[]}`;
    };

    await env.userSays('安排本周训练。');
    await env.aiReplies('车队开始普通的赛前准备。');
    await tick();
    const event = ctrl.stateAt()!.randomEvents!.current!;
    expect(event).toMatchObject({ status: 'awaiting_player', totalDialogueTurns: 3, completedDialogueTurns: 0 });

    const replies = [
      '医疗组完成第一轮负荷评估。',
      '车手确认第二轮恢复安排。',
      '工程师记录第三轮最终检查。',
    ];
    for (const [index, reply] of replies.entries()) {
      const result = await ctrl.resolveRandomEvent({
        eventId: event.id,
        answer: `第 ${index + 1} 轮处理方案。`,
        expectedRevisionId: ctrl.status().revisionId!,
      });
      expect(result).toMatchObject({ ok: true, event: { status: 'awaiting_narration' } });
      await env.aiReplies(reply);
      await tick();

      if (index < 2) {
        expect(ctrl.stateAt()!.randomEvents!.current).toMatchObject({
          id: event.id,
          status: 'awaiting_player',
          completedDialogueTurns: index + 1,
        });
        expect(calls).toBe(1);
      }
    }

    expect(ctrl.stateAt()!.randomEvents!.current).toMatchObject({
      id: event.id,
      status: 'resolved',
      completedDialogueTurns: 3,
      totalDialogueTurns: 3,
    });
    expect(ctrl.stateAt()!.randomEvents!.current!.dialogue).toHaveLength(3);
    expect(env.triggered).toBe(3);
    expect(calls).toBe(2);
    for (const reply of replies) expect(resolutionPrompt).toContain(reply);
  });
});
