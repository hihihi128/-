import { beforeEach, describe, expect, it } from 'vitest';
import { F1Controller } from '../../src/tavern/controller';
import { SPECIAL_ACTION_NARRATION_VAR } from '../../src/tavern/specialActionContext';
import { cardWorldbook, FakeTavern } from './fakeEnv';

const update = (line: string) => `\n<F1M_UPDATE>\n${line}\n</F1M_UPDATE>`;

async function setup() {
  const env = new FakeTavern(cardWorldbook());
  const ctrl = new F1Controller(env);
  ctrl.init();
  expect((await ctrl.newGame({ playerTeamId: 'mclaren', seed: 73 })).ok).toBe(true);
  return { env, ctrl };
}

describe('特殊动作补充叙述', () => {
  let env: FakeTavern;
  let ctrl: F1Controller;

  beforeEach(async () => ({ env, ctrl } = await setup()));

  it('空白补充只提交白名单动作，重复 requestId 不会再次提交', async () => {
    const request = {
      requestId: 'mclaren-empty',
      action: { type: 'START_MCLAREN_FIX', route: 'independent' },
      contextText: '   ',
      expectedRevisionId: ctrl.status().revisionId!,
    };
    const first = await ctrl.executeSpecialAction(request);
    expect(first).toMatchObject({ ok: true, actionApplied: true, narrationStatus: 'not_requested' });
    expect(ctrl.stateAt()!.mclaren?.route).toBe('independent');
    expect(env.created).toHaveLength(0);
    expect(env.triggered).toBe(0);
    const revisions = ctrl.status().revisions;
    expect(await ctrl.executeSpecialAction(request)).toMatchObject({ actionApplied: true, narrationStatus: 'not_requested' });
    expect(ctrl.status().revisions).toBe(revisions);
  });

  it('先提交动作，再以受控楼层变量请求主聊天叙述', async () => {
    const result = await ctrl.executeSpecialAction({
      requestId: 'mclaren-story',
      action: { type: 'START_MCLAREN_FIX', route: 'mercedes' },
      contextText: '请向两支技术团队说明我们会共享必要的遥测数据。',
      expectedRevisionId: ctrl.status().revisionId!,
    });
    expect(result).toMatchObject({ ok: true, actionApplied: true, narrationStatus: 'pending' });
    expect(ctrl.stateAt()!.mclaren?.route).toBe('mercedes');
    expect(env.created).toHaveLength(1);
    expect(env.created[0]).toContain('仅需剧情叙述');
    expect(env.getMessageVars(1)[SPECIAL_ACTION_NARRATION_VAR]).toMatchObject({ mode: 'narration_only', requestId: 'mclaren-story' });
    expect(env.triggered).toBe(1);
  });

  it('只叙述回复在接收、编辑、重算和续写时都不会结算数值命令或触发随机事件', async () => {
    const funds = ctrl.stateAt()!.teams.mclaren.funds;
    const result = await ctrl.executeSpecialAction({
      requestId: 'narration-only',
      action: { type: 'START_MCLAREN_FIX', route: 'independent' },
      contextText: '把这项决定说得坚定一些。',
      expectedRevisionId: ctrl.status().revisionId!,
    });
    expect(result.actionApplied).toBe(true);
    const assistant = await env.aiReplies('工程团队确认按既定路线推进。' + update('{"op":"funds","delta":99,"reason":"恶意命令"}'));
    expect(ctrl.stateAt()!.teams.mclaren.funds).toBe(funds);
    expect(ctrl.status().specialAction).toMatchObject({ narrationStatus: 'completed' });
    expect(env.getMessageVars(assistant)[SPECIAL_ACTION_NARRATION_VAR]).toMatchObject({ mode: 'narration_only' });

    await ctrl.onMessageEdited(assistant);
    await ctrl.processAssistantMessage(assistant, { force: true });
    expect(ctrl.stateAt()!.teams.mclaren.funds).toBe(funds);

    await env.aiStreams(update('{"op":"funds","delta":99,"reason":"续写命令"}'), 'continue');
    expect(ctrl.stateAt()!.teams.mclaren.funds).toBe(funds);
    expect(env.generated).toHaveLength(0);
  });

  it('叙述停止后只会重试叙述，不会回滚或重复执行动作', async () => {
    const applied = await ctrl.executeSpecialAction({
      requestId: 'retry-only-narration',
      action: { type: 'START_MCLAREN_FIX', route: 'independent' },
      contextText: '请说明这个选择的技术理由。',
      expectedRevisionId: ctrl.status().revisionId!,
    });
    expect(applied.actionRevisionId).toBeTruthy();
    const revisions = ctrl.status().revisions;
    ctrl.onGenerationStopped();
    expect(ctrl.status().specialAction).toMatchObject({ narrationStatus: 'failed', actionRevisionId: applied.actionRevisionId });
    const retried = await ctrl.retrySpecialActionNarration({ requestId: 'retry-only-narration', expectedRevisionId: applied.actionRevisionId! });
    expect(retried).toMatchObject({ ok: true, actionApplied: true, narrationStatus: 'pending' });
    expect(ctrl.status().revisions).toBe(revisions);
    expect(ctrl.stateAt()!.mclaren?.route).toBe('independent');
    expect(env.created).toHaveLength(1);
    expect(env.triggered).toBe(2);
  });

  it('拒绝未知字段、未知动作和超过上限的文本，且不修改存档', async () => {
    const revision = ctrl.status().revisionId;
    const before = JSON.stringify(ctrl.stateAt());
    const bad = await ctrl.executeSpecialAction({
      requestId: 'bad', action: { type: 'ADVANCE' }, contextText: '', expectedRevisionId: revision, extra: true,
    });
    expect(bad).toMatchObject({ ok: false, actionApplied: false });
    const oversized = await ctrl.executeSpecialAction({
      requestId: 'too-long', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: 'x'.repeat(1001), expectedRevisionId: revision,
    });
    expect(oversized.ok).toBe(false);
    expect(JSON.stringify(ctrl.stateAt())).toBe(before);
  });
});
