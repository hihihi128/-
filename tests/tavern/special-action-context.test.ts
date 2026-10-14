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

  it('已有助手楼后的重试会显式绑定下一楼，不能让该楼获得数值命令权限', async () => {
    const funds = ctrl.stateAt()!.teams.mclaren.funds;
    const applied = await ctrl.executeSpecialAction({
      requestId: 'retry-after-assistant', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '说明技术选择。', expectedRevisionId: ctrl.status().revisionId!,
    });
    await env.aiReplies('第一次叙述为空。');
    (ctrl as any).specialActionReceipt.narrationStatus = 'failed';
    const retried = await ctrl.retrySpecialActionNarration({ requestId: 'retry-after-assistant', expectedRevisionId: applied.actionRevisionId! });
    expect(retried).toMatchObject({ ok: true, narrationStatus: 'pending' });
    const replay = await env.aiReplies('第二次叙述。' + update('{"op":"funds","delta":99,"reason":"越权"}'));
    expect(replay).toBe(3);
    expect(env.getMessageVars(replay)[SPECIAL_ACTION_NARRATION_VAR]).toMatchObject({ requestId: 'retry-after-assistant' });
    expect(ctrl.stateAt()!.teams.mclaren.funds).toBe(funds);
  });

  it('retry 的 U+2 完成后 swipe 仍从用户楼继承仅叙述标记', async () => {
    const funds = ctrl.stateAt()!.teams.mclaren.funds;
    const applied = await ctrl.executeSpecialAction({
      requestId: 'u2-swipe', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '说明选择。', expectedRevisionId: ctrl.status().revisionId!,
    });
    await env.aiReplies('');
    await ctrl.retrySpecialActionNarration({ requestId: 'u2-swipe', expectedRevisionId: applied.actionRevisionId! });
    const retryReply = await env.aiReplies('重试完成。');
    await env.swipeNew('重试后的 swipe。' + update('{"op":"funds","delta":99,"reason":"swipe 越权"}'));
    expect(retryReply).toBe(3);
    expect(env.getMessageVars(retryReply)[SPECIAL_ACTION_NARRATION_VAR]).toMatchObject({ requestId: 'u2-swipe' });
    expect(ctrl.stateAt()!.teams.mclaren.funds).toBe(funds);
    expect(env.generated).toHaveLength(0);
  });

  it('retry 的 U+2 后重生成连续助手楼仍继承仅叙述标记', async () => {
    const funds = ctrl.stateAt()!.teams.mclaren.funds;
    const applied = await ctrl.executeSpecialAction({
      requestId: 'u2-regenerate', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '说明选择。', expectedRevisionId: ctrl.status().revisionId!,
    });
    await env.aiReplies('');
    await ctrl.retrySpecialActionNarration({ requestId: 'u2-regenerate', expectedRevisionId: applied.actionRevisionId! });
    await env.aiReplies('重试完成。');
    const regenerated = await env.aiReplies('重生成内容。' + update('{"op":"funds","delta":99,"reason":"重生成越权"}'), 'regenerate');
    expect(regenerated).toBe(4);
    expect(env.getMessageVars(regenerated)[SPECIAL_ACTION_NARRATION_VAR]).toMatchObject({ requestId: 'u2-regenerate' });
    expect(ctrl.stateAt()!.teams.mclaren.funds).toBe(funds);
    expect(env.generated).toHaveLength(0);
  });

  it('retry 的 U+2 STOPPED 后 ENDED 仍隔离含命令的 partial 文本', async () => {
    const funds = ctrl.stateAt()!.teams.mclaren.funds;
    const applied = await ctrl.executeSpecialAction({
      requestId: 'u2-stopped', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '说明选择。', expectedRevisionId: ctrl.status().revisionId!,
    });
    await env.aiReplies('');
    await ctrl.retrySpecialActionNarration({ requestId: 'u2-stopped', expectedRevisionId: applied.actionRevisionId! });
    env.messages.push({ role: 'assistant', swipes: ['partial' + update('{"op":"funds","delta":99,"reason":"停止后越权"}')], swipe_id: 0, variables: [{}] });
    ctrl.onGenerationStopped();
    await ctrl.onGenerationEnded();
    expect(env.getMessageVars(3)[SPECIAL_ACTION_NARRATION_VAR]).toMatchObject({ requestId: 'u2-stopped' });
    expect(ctrl.stateAt()!.teams.mclaren.funds).toBe(funds);
    expect(env.generated).toHaveLength(0);
  });

  it('创建消息失败后保留真实动作结果，错误 revision 不会销毁可重试回执', async () => {
    const originalCreate = env.createUserMessage.bind(env);
    let first = true;
    env.createUserMessage = async text => {
      if (first) { first = false; throw new Error('write failed'); }
      return originalCreate(text);
    };
    const applied = await ctrl.executeSpecialAction({
      requestId: 'create-fails', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '说明选择。', expectedRevisionId: ctrl.status().revisionId!,
    });
    expect(applied).toMatchObject({ actionApplied: true, narrationStatus: 'failed' });
    const rejected = await ctrl.retrySpecialActionNarration({ requestId: 'create-fails', expectedRevisionId: 'wrong-revision' });
    expect(rejected).toMatchObject({ ok: false, narrationStatus: 'failed', actionApplied: true });
    const retried = await ctrl.retrySpecialActionNarration({ requestId: 'create-fails', expectedRevisionId: applied.actionRevisionId! });
    expect(retried.narrationStatus).toBe('pending');
    expect(env.created[0]).toContain('引擎结果：迈凯伦启动自主车体与动力单元软件适配项目，预计 8 周完成。');
  });

  it('无助手回复的 generation ended 标记失败，swipe 重生成仍隔离数值命令', async () => {
    const funds = ctrl.stateAt()!.teams.mclaren.funds;
    const applied = await ctrl.executeSpecialAction({
      requestId: 'empty-generation', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '保持克制。', expectedRevisionId: ctrl.status().revisionId!,
    });
    await ctrl.onGenerationEnded();
    expect(ctrl.status().specialAction).toMatchObject({ narrationStatus: 'failed' });
    await ctrl.retrySpecialActionNarration({ requestId: 'empty-generation', expectedRevisionId: applied.actionRevisionId! });
    const assistant = await env.aiReplies('初稿。');
    await env.swipeNew('重生成稿。' + update('{"op":"funds","delta":99,"reason":"swipe 越权"}'));
    expect(env.getMessageVars(assistant)[SPECIAL_ACTION_NARRATION_VAR]).toMatchObject({ requestId: 'empty-generation' });
    expect(ctrl.stateAt()!.teams.mclaren.funds).toBe(funds);
  });

  it('triggerGeneration 报错且没有助手楼时保留动作，并能仅重试叙述', async () => {
    const trigger = env.triggerGeneration.bind(env);
    env.triggerGeneration = async () => { throw new Error('generation unavailable'); };
    const applied = await ctrl.executeSpecialAction({
      requestId: 'trigger-fails', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '请说明。', expectedRevisionId: ctrl.status().revisionId!,
    });
    expect(applied).toMatchObject({ ok: false, actionApplied: true, narrationStatus: 'failed' });
    expect(env.messages).toHaveLength(2);
    env.triggerGeneration = trigger;
    expect(await ctrl.retrySpecialActionNarration({ requestId: 'trigger-fails', expectedRevisionId: applied.actionRevisionId! })).toMatchObject({ ok: true, narrationStatus: 'pending' });
  });

  it('用户消息写入后发生回滚仍会写入楼层标记，不留下可执行的未标记消息', async () => {
    const create = env.createUserMessage.bind(env);
    env.createUserMessage = async text => {
      await create(text);
      await ctrl.restoreRevision('r1');
    };
    const result = await ctrl.executeSpecialAction({
      requestId: 'marker-after-rollback', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '请说明。', expectedRevisionId: ctrl.status().revisionId!,
    });
    expect(result.narrationStatus).toBe('stale');
    expect(env.getMessageVars(1)[SPECIAL_ACTION_NARRATION_VAR]).toMatchObject({ requestId: 'marker-after-rollback', mode: 'narration_only' });
  });

  it('pre_race 的只叙述回复不会启动新的随机事件判定', async () => {
    const applied = await ctrl.executeSpecialAction({
      requestId: 'pre-race-narration', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '简短说明。', expectedRevisionId: ctrl.status().revisionId!,
    });
    expect(applied.actionApplied).toBe(true);
    const state = ctrl.stateAt()!;
    state.season.phase = 'pre_race';
    const before = state.randomEvents?.weeklyStarted ?? 0;
    await env.aiReplies('这是一段仅叙述的赛前回应。');
    expect(ctrl.stateAt()!.randomEvents?.weeklyStarted ?? 0).toBe(before);
  });

  it('聊天切换或回滚后的迟到回复保持过期且不能结算命令', async () => {
    const funds = ctrl.stateAt()!.teams.mclaren.funds;
    const originalChatId = env.chatId.bind(env);
    let switched = false;
    env.chatId = () => switched ? 'chat-2' : originalChatId();
    await ctrl.executeSpecialAction({
      requestId: 'late-reply', action: { type: 'START_MCLAREN_FIX', route: 'independent' }, contextText: '说明选择。', expectedRevisionId: ctrl.status().revisionId!,
    });
    switched = true;
    ctrl.onChatChanged();
    switched = false;
    await env.aiReplies('迟到回复。' + update('{"op":"funds","delta":99,"reason":"迟到越权"}'));
    expect(ctrl.status().specialAction).toMatchObject({ narrationStatus: 'stale' });
    expect(ctrl.stateAt()!.teams.mclaren.funds).toBe(funds);
    await ctrl.restoreRevision('r1');
    expect(ctrl.status().specialAction).toMatchObject({ narrationStatus: 'stale' });
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
