/** Strict, deliberately small contract for the opt-in secondary-API review. */

export type StrategyReviewVerdict = 'sound' | 'changes_recommended';
export type StrategyReviewIssueCode = 'legality' | 'tyre_life' | 'temperature' | 'track_fit' | 'pace' | 'pit_window' | 'weather' | 'other';
export type StrategyReviewSeverity = 'info' | 'warning' | 'error';

export interface RacePlanFields {
  tyrePlan: string[];
  paceMode: 'conserve' | 'balanced' | 'push';
  pitTiming: 'early' | 'standard' | 'late';
  scReaction: boolean;
}

export interface StrategyReviewIssue {
  code: StrategyReviewIssueCode;
  severity: StrategyReviewSeverity;
  message: string;
}

export interface StrategyReview {
  schemaVersion: 1;
  driverId: string;
  verdict: StrategyReviewVerdict;
  summary: string;
  issues: StrategyReviewIssue[];
  correctedPlan: RacePlanFields | null;
}

export interface StrategyReviewPromptContext {
  teamName: string;
  driverName: string;
  driverId: string;
  trackName: string;
  laps: number;
  gridPosition: number | null;
  rainChance: number;
  rainWindow: [number, number] | null;
  originalPlan: RacePlanFields;
  originalPrediction: { stints: number[]; cost: number; stops: number; delta: number };
  dryCompounds: string[];
  mandatoryCompounds: number;
  availableTyres: Record<string, number>;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) if (DANGEROUS_KEYS.has(key)) throw new Error(`${label} 含有危险字段`);
  return row;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).some(key => !expected.has(key)) || keys.some(key => !(key in value))) {
    throw new Error(`${label} 字段不符合契约`);
  }
}

function stringValue(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 必须是 1–${max} 字符的文本`);
  return value.trim();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label} 无效`);
  return value as T;
}

function parsePlan(value: unknown): RacePlanFields {
  const row = plainRecord(value, 'correctedPlan');
  exactKeys(row, ['tyrePlan', 'paceMode', 'pitTiming', 'scReaction'], 'correctedPlan');
  if (!Array.isArray(row.tyrePlan) || row.tyrePlan.length < 2 || row.tyrePlan.length > 5 || row.tyrePlan.some(compound => typeof compound !== 'string' || !compound || compound.length > 64)) {
    throw new Error('correctedPlan.tyrePlan 必须为 2–5 个配方');
  }
  if (typeof row.scReaction !== 'boolean') throw new Error('correctedPlan.scReaction 必须为布尔值');
  return {
    tyrePlan: [...row.tyrePlan],
    paceMode: enumValue(row.paceMode, ['conserve', 'balanced', 'push'], 'correctedPlan.paceMode'),
    pitTiming: enumValue(row.pitTiming, ['early', 'standard', 'late'], 'correctedPlan.pitTiming'),
    scReaction: row.scReaction,
  };
}

/** Accept one JSON object, or one complete JSON code fence containing that object. */
export function parseStrategyReview(text: unknown, expectedDriverId: string): StrategyReview {
  if (typeof text !== 'string') throw new Error('副 API 没有返回文本');
  if (new TextEncoder().encode(text).byteLength > 16 * 1024) throw new Error('副 API 返回超过 16 KiB');
  const fenced = text.match(/^\s*```json\s*\n([\s\S]*?)\n```\s*$/i);
  const source = fenced ? fenced[1] : text.trim();
  if (!source.startsWith('{') || !source.endsWith('}')) throw new Error('副 API 必须只返回一个 JSON 对象');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('副 API 返回的 JSON 无效或不完整');
  }
  const row = plainRecord(parsed, '点评');
  exactKeys(row, ['schemaVersion', 'driverId', 'verdict', 'summary', 'issues', 'correctedPlan'], '点评');
  if (row.schemaVersion !== 1) throw new Error('点评 schemaVersion 不受支持');
  if (stringValue(row.driverId, 'driverId', 128) !== expectedDriverId) throw new Error('点评车手与请求车手不一致');
  const verdict = enumValue(row.verdict, ['sound', 'changes_recommended'], 'verdict');
  const summary = stringValue(row.summary, 'summary', 800);
  if (!Array.isArray(row.issues) || row.issues.length > 8) throw new Error('issues 必须为至多 8 条的问题列表');
  const issues = row.issues.map((value, index) => {
    const issue = plainRecord(value, `issues[${index}]`);
    exactKeys(issue, ['code', 'severity', 'message'], `issues[${index}]`);
    return {
      code: enumValue(issue.code, ['legality', 'tyre_life', 'temperature', 'track_fit', 'pace', 'pit_window', 'weather', 'other'], `issues[${index}].code`),
      severity: enumValue(issue.severity, ['info', 'warning', 'error'], `issues[${index}].severity`),
      message: stringValue(issue.message, `issues[${index}].message`, 400),
    };
  });
  const correctedPlan = row.correctedPlan === null ? null : parsePlan(row.correctedPlan);
  const hasWarning = issues.some(issue => issue.severity === 'warning' || issue.severity === 'error');
  if (verdict === 'sound' && (correctedPlan !== null || hasWarning)) throw new Error('sound 点评不能包含更正方案或 warning/error');
  if (verdict === 'changes_recommended' && (!correctedPlan || !hasWarning)) throw new Error('changes_recommended 必须包含更正方案及 warning/error');
  return { schemaVersion: 1, driverId: expectedDriverId, verdict, summary, issues, correctedPlan };
}

export function strategyReviewPrompt(context: StrategyReviewPromptContext): string {
  const plan = context.originalPlan;
  const grid = context.gridPosition === null ? '未确定' : `P${context.gridPosition}`;
  const rain = context.rainWindow ? `公开窗口第 ${context.rainWindow[0]}–${context.rainWindow[1]} 圈` : '无明确公开窗口';
  return [
    '你是 F1 策略点评助手。只点评当前工程师赛前正赛策略；不要预测私有天气、事故或比赛结果。',
    `车队=${context.teamName}；车手=${context.driverName}；driverId=${context.driverId}；赛道=${context.trackName}；圈数=${context.laps}；发车=${grid}。`,
    `公开降雨概率=${Math.round(context.rainChance * 100)}%；${rain}。干胎可用=${context.dryCompounds.join('|')}；至少 ${context.mandatoryCompounds} 种不同干胎；可用于正赛的实体胎组数=${JSON.stringify(context.availableTyres)}。同一胎组可在穿插其他配方后复用；仅连续相同配方的每一段需要不同胎组。`,
    `当前工程师策略：配方=${plan.tyrePlan.join('→')}；驾驶=${plan.paceMode}；进站=${plan.pitTiming}；安全车=${plan.scReaction ? '积极' : '保守'}。`,
    `本地预测：${context.originalPrediction.stints.join('/')} 圈，${context.originalPrediction.stops} 停，轮胎加进站成本 ${context.originalPrediction.cost.toFixed(1)} 秒。`,
    '只输出一个 JSON 对象，或完整单一 ```json 代码围栏；不要输出任何额外文本。',
    '{"schemaVersion":1,"driverId":"请求的 driverId","verdict":"sound|changes_recommended","summary":"不超过800字的中文结论","issues":[{"code":"legality|tyre_life|temperature|track_fit|pace|pit_window|weather|other","severity":"info|warning|error","message":"不超过400字"}],"correctedPlan":null}',
    'sound 时 correctedPlan 必须是 null，且 issues 不得有 warning/error。changes_recommended 时必须给出 correctedPlan（tyrePlan 2–5 个可用干胎；paceMode 为 conserve|balanced|push；pitTiming 为 early|standard|late；scReaction 为布尔值）并至少有一个 warning/error。',
  ].join('\n');
}
