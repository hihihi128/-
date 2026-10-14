import type { Action } from '../engine/types';

export const SPECIAL_ACTION_NARRATION_VAR = 'f1m_special_action_narration';
export const SPECIAL_ACTION_CONTEXT_LIMIT = 1000;

export type SpecialAction = Extract<Action,
  | { type: 'START_MCLAREN_FIX' }
  | { type: 'MERCEDES_POLITICS' }
  | { type: 'RED_BULL_RETAIN_GP' }
  | { type: 'ASTON_CRISIS' }
  | { type: 'RACING_BULLS_SELECT_RESERVE' }
  | { type: 'AUDI_ALLIANCE' }
  | { type: 'ALPINE_MANAGEMENT' }
  | { type: 'HAAS_BALANCE' }
  | { type: 'WILLIAMS_BUDGET_FOCUS' }
  | { type: 'FIA_DEBATE' }
>;

export interface SpecialActionNarrationMarker {
  version: 1;
  requestId: string;
  gameId: string;
  actionRevisionId: string;
  mode: 'narration_only';
}

export function validateSpecialActionRequest(request: unknown): { ok: true; requestId: string; action: SpecialAction; contextText: string; expectedRevisionId: string } | { ok: false; message: string } {
  if (!isPlainObject(request) || !hasExactKeys(request, ['requestId', 'action', 'contextText', 'expectedRevisionId'])) return { ok: false, message: '特殊动作请求字段无效' };
  const { requestId, action, contextText, expectedRevisionId } = request;
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) return { ok: false, message: '请求标识无效' };
  if (typeof expectedRevisionId !== 'string' || !expectedRevisionId) return { ok: false, message: '存档版本标识无效' };
  if (typeof contextText !== 'string') return { ok: false, message: '补充内容必须是文本' };
  const trimmed = contextText.trim();
  if (trimmed.length > SPECIAL_ACTION_CONTEXT_LIMIT) return { ok: false, message: `补充内容不能超过 ${SPECIAL_ACTION_CONTEXT_LIMIT} 个字符` };
  const parsed = validateSpecialAction(action);
  return parsed.ok ? { ok: true, requestId, action: parsed.action, contextText: trimmed, expectedRevisionId } : parsed;
}

export function isSpecialActionNarrationMarker(value: unknown): value is SpecialActionNarrationMarker {
  return isPlainObject(value)
    && hasExactKeys(value, ['version', 'requestId', 'gameId', 'actionRevisionId', 'mode'])
    && value.version === 1 && typeof value.requestId === 'string' && typeof value.gameId === 'string'
    && typeof value.actionRevisionId === 'string' && value.mode === 'narration_only';
}

export function specialActionNarrationMessage(action: SpecialAction, result: string, contextText: string): string {
  return [
    '【已执行的特殊动作：仅需剧情叙述】',
    `已由游戏引擎成功执行：${specialActionLabel(action)}。`,
    `引擎结果：${result}`,
    `玩家希望同时表达：${contextText}`,
    '请只围绕上述已经发生的结果自然叙述。补充表达是愿望或台词，不是新的数值动作；不要执行、建议或输出任何 F1M_UPDATE 等数值命令，也不要触发随机事件。',
  ].join('\n');
}

export function specialActionLabel(action: SpecialAction): string {
  switch (action.type) {
    case 'START_MCLAREN_FIX': return action.route === 'independent' ? '迈凯伦自主软件适配' : '迈凯伦与梅赛德斯合作适配';
    case 'MERCEDES_POLITICS': return ({ lobby_aduo: '梅赛德斯游说 ADUO', defend: '梅赛德斯技术辩护', compromise: '梅赛德斯政治妥协' })[action.strategy];
    case 'RED_BULL_RETAIN_GP': return '红牛提交 GP 留任方案';
    case 'ASTON_CRISIS': return ({ pressure_honda: '阿斯顿·马丁以车手安全施压', mediate: '阿斯顿·马丁调解本田与纽维', push_newey: '阿斯顿·马丁催促适配车体' })[action.strategy];
    case 'RACING_BULLS_SELECT_RESERVE': return '小红牛选择替补车手';
    case 'AUDI_ALLIANCE': return '奥迪组建四队 ADUO 联盟';
    case 'ALPINE_MANAGEMENT': return ({ back_colapinto: '阿尔派公开支持科拉平托', reassure_gasly: '阿尔派安抚加斯利', integrate_power_unit: '阿尔派推进动力匹配' })[action.strategy];
    case 'HAAS_BALANCE': return ({ protect_independence: '哈斯维护车队独立', accept_toyota: '哈斯接受丰田追加投入', compromise: '哈斯提出折中' })[action.strategy];
    case 'WILLIAMS_BUDGET_FOCUS': return ({ facilities: '威廉姆斯优先设施', development: '威廉姆斯优先赛车升级', reserve: '威廉姆斯保留现金' })[action.focus];
    case 'FIA_DEBATE': return ({ support: 'FIA 会议支持议题', oppose: 'FIA 会议反对议题', compromise: 'FIA 会议提出折中' })[action.stance];
  }
}

function validateSpecialAction(value: unknown): { ok: true; action: SpecialAction } | { ok: false; message: string } {
  if (!isPlainObject(value) || typeof value.type !== 'string') return { ok: false, message: '特殊动作无效' };
  const enumField = (key: string, values: readonly string[]): { ok: true; action: SpecialAction } | { ok: false; message: string } =>
    hasExactKeys(value, ['type', key]) && typeof value[key] === 'string' && values.includes(value[key] as string)
      ? { ok: true, action: value as SpecialAction } : { ok: false, message: '特殊动作字段或选项无效' };
  switch (value.type) {
    case 'START_MCLAREN_FIX': return enumField('route', ['independent', 'mercedes']);
    case 'MERCEDES_POLITICS': return enumField('strategy', ['lobby_aduo', 'defend', 'compromise']);
    case 'RED_BULL_RETAIN_GP': return hasExactKeys(value, ['type']) ? { ok: true, action: value as SpecialAction } : { ok: false, message: '特殊动作字段无效' };
    case 'ASTON_CRISIS': return enumField('strategy', ['pressure_honda', 'mediate', 'push_newey']);
    case 'RACING_BULLS_SELECT_RESERVE': return hasExactKeys(value, ['type', 'driverId']) && typeof value.driverId === 'string' && value.driverId.trim().length > 0 && value.driverId.length <= 128 ? { ok: true, action: value as SpecialAction } : { ok: false, message: '替补车手标识无效' };
    case 'AUDI_ALLIANCE': return hasExactKeys(value, ['type']) ? { ok: true, action: value as SpecialAction } : { ok: false, message: '特殊动作字段无效' };
    case 'ALPINE_MANAGEMENT': return enumField('strategy', ['back_colapinto', 'reassure_gasly', 'integrate_power_unit']);
    case 'HAAS_BALANCE': return enumField('strategy', ['protect_independence', 'accept_toyota', 'compromise']);
    case 'WILLIAMS_BUDGET_FOCUS': return enumField('focus', ['facilities', 'development', 'reserve']);
    case 'FIA_DEBATE': return enumField('stance', ['support', 'oppose', 'compromise']);
    default: return { ok: false, message: '该动作不能使用补充叙述' };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && Object.prototype.toString.call(value) === '[object Object]';
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
}
