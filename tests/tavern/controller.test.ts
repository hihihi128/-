import { beforeEach, describe, expect, it } from 'vitest';
import { continuationSuffix, F1Controller, HUD_TAG, INJECT_ID } from '../../src/tavern/controller';
import { PTR, STORE_KEY } from '../../src/tavern/store';
import { FakeTavern } from './fakeEnv';

const update = (lines: string[]) => `\n<F1M_UPDATE>\n${lines.join('\n')}\n</F1M_UPDATE>`;

async function setup() {
  const env = new FakeTavern();
  const ctrl = new F1Controller(env);
  ctrl.init();
  const res = await ctrl.newGame({ playerTeamId: 'team_c', seed: 2024 });
  expect(res.ok).toBe(true);
  return { env, ctrl };
}

describe('后端控制器（模拟酒馆环境）', () => {
  let env: FakeTavern;
  let ctrl: F1Controller;
  beforeEach(async () => {
    ({ env, ctrl } = await setup());
  });

  it('开局后存档挂在最新楼层，并能生成视图与状态条', () => {
    expect(env.messages[0].variables[0][PTR]).toBeTruthy();
    expect(env.chatVars[STORE_KEY].revisions).toBeTruthy();
    const st = ctrl.status();
    expect(st.hasGame).toBe(true);
    expect(st.revisions).toBe(1);
    const v = ctrl.view()!;
    expect(v.player.team.name).toBe('测试车队C');
    const hud = ctrl.hud(0);
    expect(hud.hasGame).toBe(true);
    expect(hud.team?.name).toBe('测试车队C');
    expect(hud.ownRevision).toBe(true);
  });

  it('同一楼层上的连续面板操作合并为一个版本', async () => {
    expect((await ctrl.dispatch({ type: 'START_PROJECT', partType: 'floor', ambition: 'standard' })).ok).toBe(true);
    expect((await ctrl.dispatch({ type: 'START_PROJECT', partType: 'suspension', ambition: 'conservative' })).ok).toBe(true);
    expect(ctrl.status().revisions).toBe(2); // 开局 + 一个合并的面板版本
    expect(ctrl.stateAt()!.teams.team_c.projects).toHaveLength(2);
    // 新楼层的操作生成新版本
    await env.userSays('开始赛季吧');
    expect((await ctrl.dispatch({ type: 'ADVANCE' })).ok).toBe(true);
    expect(ctrl.status().revisions).toBe(3);
    expect(env.messages[1].variables[0][PTR]).toBeTruthy();
  });

  it('车队工程师默认走主 API，也可使用设置中的副 API', async () => {
    for (let i = 0; i < 30 && !ctrl.stateAt()!.weekend; i++) {
      const result = await ctrl.dispatch({ type: 'ADVANCE' });
      expect(result.ok).toBe(true);
    }
    expect(ctrl.stateAt()!.weekend).toBeTruthy();
    const main = await ctrl.requestEngineerStrategy('c1');
    expect(main.ok).toBe(true);
    expect(main.api).toBe('main');
    expect(main.plan?.tyrePlan).toBeTruthy();
    expect(env.generated.at(-1)?.options).toBeUndefined();

    ctrl.updateSettings({ engineerApi: 'secondary', engineerProxyPreset: '策略副线', engineerModel: 'test-model' });
    const secondary = await ctrl.requestEngineerStrategy('c1');
    expect(secondary.ok).toBe(true);
    expect(secondary.api).toBe('secondary');
    expect(env.generated.at(-1)?.options).toEqual({ proxyPreset: '策略副线', model: 'test-model' });

    const contextual = ctrl.stateAt()!;
    contextual.weekend!.forecast.race = 0.72;
    contextual.weekend!.forecast.raceRainWindow = [10, 14];
    contextual.weekend!.weather.race = 'dry';
    contextual.weekend!.qualifying = {
      kind: 'qualifying',
      weather: 'dry',
      sessions: [],
      order: ['a1', 'c1'],
      grid: ['a1', 'c1'],
      pole: null,
      events: [],
    };
    expect((await ctrl.importSave(JSON.stringify(contextual))).ok).toBe(true);
    const weatherAware = await ctrl.requestEngineerStrategy('c1', 'main');
    expect(weatherAware.ok).toBe(true);
    expect(weatherAware.gridPosition).toBe(2);
    expect(weatherAware.weatherResponse).toContain('第 10–14 圈可能降雨');
    expect(weatherAware.explanation).toContain('天气预案');
    expect(weatherAware.explanation).toContain('换半雨胎');
    expect(env.generated.at(-1)?.prompt).toContain('从 P2 发车');
    expect(env.generated.at(-1)?.prompt).toContain('正赛降雨概率 72%');
    expect(env.generated.at(-1)?.prompt).toContain('换半雨胎');

    contextual.weekend!.forecast.raceRainWindow = [1, 4];
    contextual.weekend!.weather.race = 'wet';
    expect((await ctrl.importSave(JSON.stringify(contextual))).ok).toBe(true);
    const earlyRain = await ctrl.requestEngineerStrategy('c1', 'main');
    expect(earlyRain.weatherResponse).toContain('发车前确认赛道');
    expect(earlyRain.weatherResponse).toContain('若已湿则直接使用半雨胎');

    delete contextual.weekend!.forecast.raceRainWindow;
    contextual.weekend!.forecast.race = 0.2;
    contextual.weekend!.weather.race = 'wet';
    expect((await ctrl.importSave(JSON.stringify(contextual))).ok).toBe(true);
    const legacyForecast = await ctrl.requestEngineerStrategy('c1', 'main');
    expect(legacyForecast.weatherResponse).toBe('目前没有明确降雨窗口，按干地基础方案执行');
  });

  it('工程师 API 失败时仍自动应用基础策略', async () => {
    for (let i = 0; i < 30 && !ctrl.stateAt()!.weekend; i++) expect((await ctrl.dispatch({ type: 'ADVANCE' })).ok).toBe(true);
    env.generateText = async () => { throw new Error('测试超时'); };
    const result = await ctrl.requestEngineerStrategy('c1');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('基础策略已自动应用并执行');
    expect(result.explanation).toContain('干地基础方案');
    const saved = ctrl.stateAt()!.weekend!.plans.c1;
    expect(saved.strategySource).toBe('engineer');
    expect(saved.tyrePlan).toEqual(result.plan?.tyrePlan);
  });

  it('完美策略复用所选 API，但忽略车队策略水平并采用最快合法方案', async () => {
    for (let i = 0; i < 30 && !ctrl.stateAt()!.weekend; i++) expect((await ctrl.dispatch({ type: 'ADVANCE' })).ok).toBe(true);
    const expected = ctrl.view()!.weekend!.drivers.find(driver => driver.driverId === 'c1')!.options[0].compounds;
    ctrl.updateSettings({ engineerProxyPreset: '完美策略副线', engineerModel: 'perfect-model' });
    const result = await ctrl.requestPerfectStrategy('c1', 'secondary');
    expect(result).toMatchObject({ ok: true, api: 'secondary', strategyLevel: '完美', mode: 'perfect' });
    expect(result.plan?.tyrePlan).toEqual(expected);
    expect(result.message).toContain('完美 AI 策略');
    expect(env.generated.at(-1)?.options).toEqual({ proxyPreset: '完美策略副线', model: 'perfect-model' });
    expect(env.generated.at(-1)?.prompt).toContain('忽略车队策略部门水平');
    expect(ctrl.stateAt()!.weekend!.plans.c1.strategySource).toBe('engineer');
  });

  it('生成前注入实时数据提示词', async () => {
    await env.userSays('你好');
    await env.fire(env.events.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    const inj = env.injected.get(INJECT_ID)!;
    expect(inj.content).toContain('测试车队C');
    expect(inj.depth).toBe(1);
    expect(inj.role).toBe('system');
  });

  it('AI 回复中的白名单指令会被结算，待叙述事件清空，并追加状态条占位符', async () => {
    await env.userSays('我去鼓励一下 C2');
    expect(ctrl.stateAt()!.narration.length).toBeGreaterThan(0);
    const m0 = ctrl.stateAt()!.drivers.c2.morale;
    const id = await env.aiReplies(`C2 听完很受鼓舞。${update(['{"op":"morale","driver":"c2","delta":5,"reason":"领队鼓励"}', '{"op":"car_perf","delta":99}'])}`);
    const s = ctrl.stateAt()!;
    expect(s.drivers.c2.morale).toBeCloseTo(Math.min(100, m0 + 5), 1);
    expect(s.narration).toHaveLength(0);
    const vars = env.messages[id].variables[0];
    expect(vars.f1m_changes.some((c: string) => c.includes('心态'))).toBe(true);
    expect(vars.f1m_changes.some((c: string) => c.includes('白名单'))).toBe(true);
    expect(env.messages[id].swipes[0]).toContain(HUD_TAG);
    // 同一文本不会重复结算
    await env.fire(env.events.MESSAGE_RECEIVED, id, 'normal');
    expect(ctrl.stateAt()!.drivers.c2.morale).toBeCloseTo(s.drivers.c2.morale, 5);
  });

  it('重 roll（新 swipe）会基于上一楼重新结算，切回旧 swipe 恢复旧状态', async () => {
    await env.userSays('谈谈');
    const m0 = ctrl.stateAt()!.drivers.c1.morale;
    const id = await env.aiReplies(`好。${update(['{"op":"morale","driver":"c1","delta":-6}'])}`);
    expect(ctrl.stateAt()!.drivers.c1.morale).toBeCloseTo(m0 - 6, 1);
    // 生成新 swipe 前注入的应是「上一楼」的状态（不含 -6）
    await env.swipeNew(`另一个版本。${update(['{"op":"morale","driver":"c1","delta":4}'])}`);
    expect(ctrl.stateAt()!.drivers.c1.morale).toBeCloseTo(Math.min(100, m0 + 4), 1);
    await env.swipeTo(id, 0);
    expect(ctrl.stateAt()!.drivers.c1.morale).toBeCloseTo(m0 - 6, 1);
  });

  it('删除楼层后存档自动回滚', async () => {
    await env.userSays('开始赛季');
    await ctrl.dispatch({ type: 'ADVANCE' });
    expect(ctrl.stateAt()!.season.phase).toBe('pre_race');
    await env.aiReplies('车队抵达首站。');
    await env.userSays('进入周末');
    await ctrl.dispatch({ type: 'ADVANCE' });
    expect(ctrl.stateAt()!.season.phase).toBe('practice');
    await env.deleteFrom(3);
    expect(ctrl.stateAt()!.season.phase).toBe('pre_race');
    await env.deleteFrom(1);
    expect(ctrl.stateAt()!.season.phase).toBe('preseason');
  });

  it('本楼已有面板操作时，编辑 AI 回复不会冲掉玩家操作', async () => {
    await env.userSays('嗨');
    const id = await env.aiReplies(`回复。${update(['{"op":"media","delta":2}'])}`);
    await ctrl.dispatch({ type: 'START_PROJECT', partType: 'floor', ambition: 'standard' });
    await env.editMessage(id, `改过的回复。${update(['{"op":"media","delta":-8}'])}`);
    const s = ctrl.stateAt()!;
    expect(s.teams.team_c.projects).toHaveLength(1);
    expect(env.toasts.some(([, m]) => m.includes('面板操作'))).toBe(true);
  });

  it('没有面板操作时编辑最新 AI 回复会重新结算', async () => {
    await env.userSays('嗨');
    const media0 = ctrl.stateAt()!.teams.team_c.mediaReputation;
    const id = await env.aiReplies(`回复。${update(['{"op":"media","delta":5}'])}`);
    expect(ctrl.stateAt()!.teams.team_c.mediaReputation).toBeCloseTo(media0 + 5, 1);
    await env.editMessage(id, `改过。${update(['{"op":"media","delta":-3}'])}`);
    expect(ctrl.stateAt()!.teams.team_c.mediaReputation).toBeCloseTo(media0 - 3, 1);
  });

  it('生成过程中拒绝面板操作', async () => {
    env.generating = true;
    const r = await ctrl.dispatch({ type: 'ADVANCE' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('生成');
  });

  it('版本数量受上限约束，且当前状态始终可解析', async () => {
    ctrl.updateSettings({ maxRevisions: 8 });
    for (let i = 0; i < 20; i++) {
      await env.userSays(`第 ${i} 轮`);
      await env.aiReplies(`好的。${update([`{"op":"media","delta":0.5}`])}`);
    }
    expect(ctrl.status().revisions).toBeLessThanOrEqual(8 + 12);
    expect(ctrl.stateAt()).toBeTruthy();
    const list = ctrl.listRevisions();
    expect(list[0].current).toBe(true);
  });

  it('请求 AI 叙述会发送用户消息并触发生成', async () => {
    const r = await ctrl.requestNarration();
    expect(r.ok).toBe(true);
    expect(env.created).toHaveLength(1);
    expect(env.triggered).toBe(1);
  });

  it('导出/导入存档', async () => {
    await ctrl.dispatch({ type: 'START_PROJECT', partType: 'floor', ambition: 'standard' });
    const text = ctrl.exportSave()!;
    const env2 = new FakeTavern();
    const ctrl2 = new F1Controller(env2);
    ctrl2.init();
    expect(ctrl2.status().hasGame).toBe(false);
    expect((await ctrl2.importSave(text)).ok).toBe(true);
    expect(ctrl2.stateAt()!.teams.team_c.projects).toHaveLength(1);
    expect((await ctrl2.importSave('{"bad":1}')).ok).toBe(false);
  });

  it('读档会把旧版本挂到最新楼层', async () => {
    const first = ctrl.listRevisions()[0].id;
    await env.userSays('开始');
    await ctrl.dispatch({ type: 'ADVANCE' });
    expect(ctrl.stateAt()!.season.phase).toBe('pre_race');
    expect((await ctrl.restoreRevision(first)).ok).toBe(true);
    expect(ctrl.stateAt()!.season.phase).toBe('preseason');
  });

  it('切换聊天会重新载入存档', async () => {
    env.chatVars = {};
    for (const m of env.messages) m.variables = m.variables.map(() => ({}));
    await env.fire(env.events.CHAT_CHANGED, 'other');
    expect(ctrl.status().hasGame).toBe(false);
    expect(env.injected.has(INJECT_ID)).toBe(false);
  });
});

describe('流式生成、继续生成与重新开局', () => {
  let env: FakeTavern;
  let ctrl: F1Controller;
  beforeEach(async () => {
    ({ env, ctrl } = await setup());
  });

  it('流式生成按真实顺序（先 GENERATION_ENDED 后 MESSAGE_RECEIVED）只结算一次', async () => {
    await env.userSays('鼓励 C2');
    const m0 = ctrl.stateAt()!.drivers.c2.morale;
    const id = await env.aiStreams(`好。${update(['{"op":"morale","driver":"c2","delta":3}'])}`);
    expect(ctrl.stateAt()!.drivers.c2.morale).toBeCloseTo(Math.min(100, m0 + 3), 1);
    expect(ctrl.stateAt()!.narration).toHaveLength(0);
    expect(env.messages[id].swipes[0].split(HUD_TAG)).toHaveLength(2);
    expect(ctrl.status().revisions).toBe(2);
  });

  it('在第一个字之前停止生成：占位楼层「...」不结算、不消耗待叙述事件、不加状态条', async () => {
    await env.userSays('说点什么');
    const pending = ctrl.stateAt()!.narration.length;
    expect(pending).toBeGreaterThan(0);
    const id = await env.aiStreams('');
    expect(env.messages[id].swipes[0]).toBe('...');
    expect(env.messages[id].variables[0][PTR]).toBeUndefined();
    expect(ctrl.stateAt()!.narration).toHaveLength(pending);
    expect(ctrl.status().revisions).toBe(1);
  });

  it('本楼有面板操作后继续生成：只结算续写部分，保留面板操作，并沿用本条消息的累计上限', async () => {
    await env.userSays('谈谈');
    const limit = ctrl.stateAt()!.rules.aiLimits.morale;
    const m0 = ctrl.stateAt()!.drivers.c1.morale;
    const media0 = ctrl.stateAt()!.teams.team_c.mediaReputation;
    const id = await env.aiReplies(`第一段。${update([`{"op":"morale","driver":"c1","delta":${-limit}}`])}`);
    const m1 = ctrl.stateAt()!.drivers.c1.morale;
    expect(m1).toBeCloseTo(Math.max(0, m0 - limit), 1);
    expect((await ctrl.dispatch({ type: 'START_PROJECT', partType: 'floor', ambition: 'standard' })).ok).toBe(true);
    await env.aiStreams(`第二段。${update([`{"op":"morale","driver":"c1","delta":${-limit}}`, '{"op":"media","delta":2}'])}`, 'continue');
    const s = ctrl.stateAt()!;
    expect(s.teams.team_c.projects).toHaveLength(1);
    expect(s.drivers.c1.morale).toBeCloseTo(m1, 1); // 已达本条消息的心态上限
    expect(s.teams.team_c.mediaReputation).toBeCloseTo(media0 + 2, 1);
    const text = env.messages[id].swipes[0];
    expect(text.match(/<F1M_UPDATE>/g)).toHaveLength(2); // 酒馆去掉的原指令块被放回
    expect(text.split(HUD_TAG)).toHaveLength(2);
    expect(text.trimEnd().endsWith(HUD_TAG)).toBe(true);
    expect(env.toasts.some(([, m]) => m.includes('面板操作'))).toBe(false);
    // 之后编辑本楼仍然受面板操作保护
    await env.editMessage(id, `改写。${update(['{"op":"media","delta":-8}'])}`);
    expect(ctrl.stateAt()!.teams.team_c.projects).toHaveLength(1);
    expect(ctrl.stateAt()!.teams.team_c.mediaReputation).toBeCloseTo(media0 + 2, 1);
    expect(env.toasts.some(([, m]) => m.includes('面板操作'))).toBe(true);
  });

  it('没有面板操作时继续生成会按全文重新结算', async () => {
    await env.userSays('谈谈');
    const media0 = ctrl.stateAt()!.teams.team_c.mediaReputation;
    await env.aiReplies(`第一段。${update(['{"op":"media","delta":2}'])}`);
    const id = await env.aiStreams(`第二段。${update(['{"op":"media","delta":3}'])}`, 'continue');
    expect(ctrl.stateAt()!.teams.team_c.mediaReputation).toBeCloseTo(media0 + 5, 1);
    expect(env.messages[id].swipes[0].match(/<F1M_UPDATE>/g)).toHaveLength(2);
    // 之后编辑本楼重新结算时，原指令仍然在文本里
    await env.editMessage(id, env.messages[id].swipes[0].replace('"delta":3', '"delta":4'));
    expect(ctrl.stateAt()!.teams.team_c.mediaReputation).toBeCloseTo(media0 + 6, 1);
  });

  it('续写对齐：忽略被去掉的指令块、占位符与空白变化', () => {
    const original = `第一段。\n${update(['{"op":"media","delta":2}'])}\n\n${HUD_TAG}`;
    expect(continuationSuffix(original, '第一段。 接着说。')).toBe(' 接着说。');
    expect(continuationSuffix(original, `${original}接着`)).toBe('\n\n接着');
    expect(continuationSuffix(original, '完全不同的文本')).toBeNull();
  });

  it('AI 回复没有指令、本楼随后有面板操作时，编辑回复不会冲掉面板操作', async () => {
    await env.userSays('嗨');
    await env.aiReplies('只是聊天。');
    await env.userSays('再聊');
    const id = await env.aiReplies('还是聊天。');
    await ctrl.dispatch({ type: 'START_PROJECT', partType: 'floor', ambition: 'standard' });
    await env.editMessage(id, `改过。${update(['{"op":"media","delta":-3}'])}`);
    expect(ctrl.stateAt()!.teams.team_c.projects).toHaveLength(1);
  });

  it('重新开局后，旧对局的楼层不会显示新对局的状态', async () => {
    await env.userSays('开始');
    await ctrl.dispatch({ type: 'ADVANCE' });
    await env.aiReplies(`好。${update(['{"op":"media","delta":1}'])}`);
    await env.userSays('再来');
    await env.aiReplies(`好。${update(['{"op":"media","delta":1}'])}`);
    const oldFloor = 2;
    expect(ctrl.stateAt(oldFloor)!.meta.playerTeamId).toBe('team_c');
    await env.userSays('换个车队');
    expect((await ctrl.newGame({ playerTeamId: 'team_a', seed: 7 })).ok).toBe(true);
    expect(ctrl.stateAt()!.meta.playerTeamId).toBe('team_a');
    expect(ctrl.stateAt(oldFloor)).toBeNull();
    expect(ctrl.hud(oldFloor).hasGame).toBe(false);
    // 新对局的版本号不会和旧楼层上的指针重名
    const oldIds = env.messages.slice(0, -1).map(m => m.variables[0][PTR]).filter(Boolean);
    expect(oldIds).not.toContain(env.messages.at(-1)!.variables[0][PTR]);
    expect(ctrl.status().revisions).toBe(1);
  });

  it('导入存档后，旧楼层同样不会显示导入的状态', async () => {
    const text = ctrl.exportSave()!;
    await env.userSays('开始');
    await ctrl.dispatch({ type: 'ADVANCE' });
    await env.userSays('导入');
    expect((await ctrl.importSave(text)).ok).toBe(true);
    // 同一对局 id 的旧指针已失效，回退版本不能比请求的楼层更晚
    expect(ctrl.stateAt(1)).toBeNull();
    expect(ctrl.stateAt()!.season.phase).toBe('preseason');
  });
});

describe('数据错误', () => {
  it('世界书没有数据条目时无法开局并给出原因', async () => {
    const env = new FakeTavern([]);
    const ctrl = new F1Controller(env);
    ctrl.init();
    const r = await ctrl.newGame({ playerTeamId: 'team_c' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('F1M数据');
  });

  it('YAML 语法错误会被报告', async () => {
    const env = new FakeTavern([{ name: '[F1M数据] 坏', content: 'teams: [ {id: a', book: 'x' }]);
    const ctrl = new F1Controller(env);
    ctrl.init();
    const rep = await ctrl.loadData();
    expect(rep.ok).toBe(false);
    expect(rep.issues.some(i => i.message.includes('YAML'))).toBe(true);
  });

  it('选择法拉利：写入被选中的理由，状态条显示媒体支持率与粉丝意见', async () => {
    const env = new FakeTavern();
    const ctrl = new F1Controller(env);
    ctrl.init();
    const res = await ctrl.newGame({ playerTeamId: 'ferrari', seed: 7, selectionReason: '我在耐力赛里带出过冠军车队' });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('过渡领队');
    const st = ctrl.stateAt()!;
    expect(st.meta.selectionReason).toBe('我在耐力赛里带出过冠军车队');
    const hud = ctrl.hud(0);
    expect(hud.ferrari).toMatchObject({ media: st.rules.ferrari.startMedia, gap: 0, dismissed: null });
    expect(hud.ferrari!.fans).toHaveLength(2);
    expect((await ctrl.loadData()).teams.find(t => t.id === 'ferrari')?.special).toBe('ferrari');
  });

  it('被法拉利撤职后状态条不再显示下一步', async () => {
    const env = new FakeTavern();
    const ctrl = new F1Controller(env);
    ctrl.init();
    await ctrl.newGame({ playerTeamId: 'ferrari', seed: 7 });
    const st = ctrl.stateAt()!;
    expect(ctrl.hud(0).season?.next).toBeTruthy();
    st.ferrari!.dismissed = '测试';
    expect((await ctrl.importSave(JSON.stringify(st))).ok).toBe(true);
    const hud = ctrl.hud(0);
    expect(hud.ferrari?.dismissed).toBe('测试');
    expect(hud.season?.next ?? null).toBeNull();
  });
});
