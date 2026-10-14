import type { GameState, RandomEventEffect, RandomEventRecord } from '../engine/types';
import { RANDOM_EVENT_EFFECT_CAPS, randomEventContext, type RandomEventContent } from '../engine/randomEvents';

const EFFECT_OPS = new Set<RandomEventEffect['op']>(Object.keys(RANDOM_EVENT_EFFECT_CAPS) as RandomEventEffect['op'][]);

function jsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('API 没有返回 JSON 对象');
  const value = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('API 返回格式错误');
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key);
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label}无效`);
  return value.trim();
};

export function randomEventGenerationPrompt(state: GameState, event: RandomEventRecord): string {
  const themes: Record<string, string> = {
    routine_social: '无关紧要的日常社交，例如工程师或车手邀请领队吃饭、喝酒或闲聊',
    routine_factory: '无危机的工厂视察、部门走访或员工交流',
    routine_team: '车队日常生活、普通会议、后勤准备或轻松团队活动',
    driver_injury: '车手健康、训练安排或参赛准备危机',
    wind_tunnel_data: '风洞、模拟器、研发数据或项目排期危机',
    part_issue: '赛车部件、质量控制、供应链或可靠性危机',
  };
  return [
    `你是 F1 车队管理模拟器的随机事件编剧。使用简体中文生成一个具体、可信的${event.category === 'routine' ? '日常小事件' : '需要领队处理的问题'}。`,
    `事件 ID=${event.id}；类型=${event.category ?? 'problem'}；主题=${themes[event.kind] ?? event.kind}；预计持续 ${event.totalDialogueTurns ?? 2} 轮玩家-AI 对话。`,
    `当前受限车队资料=${JSON.stringify(randomEventContext(state))}`,
    `不得编造比赛结果、死亡、犯罪、政治现实人物争议或不可逆职业结局。不得包含任何存档修改指令。员工、工程师、策略师和维修组的能力分、技能分、等级、内部评分、判定概率及随机检定不得出现在 title、prompt 或 answerOptions 中；只能使用姓名、职务和定性表现。${event.category === 'routine' ? '这是无关紧要的日常事件，不得制造危机、重大冲突或紧急损失。' : ''}`,
    'title 最多 40 字；prompt 最多 260 字；answerOptions 必须有 2–4 个具体处理方向，每项最多 60 字。',
    '只返回一个 JSON 对象，不要代码块：{"title":"标题","prompt":"事件与问题","answerOptions":["方案一","方案二"]}',
  ].join('\n');
}

export function parseRandomEventContent(raw: string): RandomEventContent {
  const value = jsonObject(raw);
  if (!exact(value, ['title', 'prompt', 'answerOptions'])) throw new Error('随机事件内容字段不正确');
  if (!Array.isArray(value.answerOptions) || value.answerOptions.length < 2 || value.answerOptions.length > 4) throw new Error('随机事件选项必须为 2–4 项');
  return {
    title: text(value.title, '随机事件标题', 40),
    prompt: text(value.prompt, '随机事件问题', 260),
    answerOptions: value.answerOptions.map((option, index) => text(option, `随机事件选项 ${index + 1}`, 60)),
  };
}

/** User message that asks the normal SillyTavern chat to narrate the decision. */
export function randomEventNarrationMessage(state: GameState, event: RandomEventRecord, answer: string): string {
  const team = state.teams[state.meta.playerTeamId];
  const turn = (event.completedDialogueTurns ?? 0) + 1;
  return [
    '【F1M 随机事件叙述请求】',
    `你正在继续 ${team.name} 的正常剧情。请围绕以下随机事件和领队决定写一段完整、自然的中文叙事。`,
    `事件 ID：${event.id}`,
    turn === 1 ? `事件：${event.title}。${event.prompt}` : `继续事件：${event.title}。此前轮次已经在上方正常聊天记录中。`,
    `当前是第 ${turn}/${event.totalDialogueTurns ?? 2} 轮。`,
    `领队本轮回应：${answer}`,
    '只输出本轮新发生的剧情正文。不要复述事件介绍、领队回应或此前正文，也不要复制已有段落。',
    turn < (event.totalDialogueTurns ?? 2)
      ? '自然推进这段剧情，并在结尾给玩家一个明确、自然的回应机会。不要提前总结或结束事件。'
      : '自然完成这段剧情，并给出与此前对话一致的收束。',
    `写出相关人员的反应和具体互动；保持专业且与当前剧情衔接。${event.category === 'routine' ? '保持轻松克制，不要突然制造危机或重大后果。' : '可以说明主要风险。'}不要编造游戏数值变化、不要返回 JSON 或代码块，也不要输出 <F1M_UPDATE> 指令。`,
  ].filter(Boolean).join('\n');
}

export function randomEventResolutionPrompt(state: GameState, event: RandomEventRecord, answer: string, mainReply: string): string {
  const dialogue = [...(event.dialogue ?? []), { player: answer, assistant: mainReply }];
  return [
    '你是 F1 车队管理模拟器的随机事件裁判。根据玩家方案与主聊天实际生成的剧情，判定事件是否解决。',
    `eventId=${event.id}；事件=${event.title}：${event.prompt}`,
    `完整 ${dialogue.length} 轮对话=${JSON.stringify(dialogue)}`,
    `可用目标资料=${JSON.stringify(randomEventContext(state))}`,
    `outcome 只能是 resolved 或 unresolved。summary 最多 300 字。effects 最多 ${event.category === 'routine' ? 1 : 3} 项，可以为空。`,
    `允许 op 与范围：affinity -0.1..0.1；driver_fitness/driver_morale -12..12；funds -5..5；project_weeks -2..2；part_reliability -8..8；staff_skill -3..3；aero_hours -8..8。delta 不能为 0。${event.category === 'routine' ? '这是日常事件。通常返回空 effects；只有对话明确改善或损害某个具体人物关系时，才允许一项 affinity 效果，正向只能是 0.05 或 0.1。禁止其他效果。' : ''}`,
    'driver、project、part、staff 操作必须使用资料中的精确 ID。funds 与 aero_hours 的 targetId 必须为 null。reason 最多 160 字。不得使用其他操作或目标。',
    '只返回 JSON，不要代码块：{"eventId":"精确事件ID","outcome":"resolved|unresolved","summary":"结论","effects":[{"op":"允许操作","targetId":null或"目标ID","delta":1,"reason":"原因"}]}',
  ].join('\n');
}

export function parseRandomEventResolution(raw: string, expectedEventId: string): { outcome: 'resolved' | 'unresolved'; summary: string; effects: RandomEventEffect[] } {
  const value = jsonObject(raw);
  if (!exact(value, ['eventId', 'outcome', 'summary', 'effects'])) throw new Error('随机事件判定字段不正确');
  if (value.eventId !== expectedEventId) throw new Error('随机事件 ID 不匹配');
  if (value.outcome !== 'resolved' && value.outcome !== 'unresolved') throw new Error('随机事件判定状态无效');
  if (!Array.isArray(value.effects) || value.effects.length > 3) throw new Error('随机事件效果最多三项');
  const effects = value.effects.map((entry, index): RandomEventEffect => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`随机事件效果 ${index + 1} 格式错误`);
    const row = entry as Record<string, unknown>;
    if (!exact(row, ['op', 'targetId', 'delta', 'reason'])) throw new Error(`随机事件效果 ${index + 1} 字段不正确`);
    if (typeof row.op !== 'string' || !EFFECT_OPS.has(row.op as RandomEventEffect['op'])) throw new Error(`随机事件效果 ${index + 1} 操作无效`);
    if (row.targetId !== null && typeof row.targetId !== 'string') throw new Error(`随机事件效果 ${index + 1} 目标无效`);
    if (typeof row.delta !== 'number' || !Number.isFinite(row.delta)) throw new Error(`随机事件效果 ${index + 1} 数值无效`);
    return { op: row.op as RandomEventEffect['op'], targetId: row.targetId as string | null, delta: row.delta, reason: text(row.reason, `随机事件效果 ${index + 1} 原因`, 160) };
  });
  return { outcome: value.outcome, summary: text(value.summary, '随机事件结论', 300), effects };
}
