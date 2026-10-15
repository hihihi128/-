/**
 * 数据库解析与校验。
 *
 * 数据来自世界书里名字以「[F1M数据]」开头的条目（YAML）。每个条目可以包含以下任意顶层键：
 *   rules / 规则、teams / 车队、drivers / 车手、tracks / 赛道、calendar / 赛历
 * 多个条目会被合并：列表按 id 拼接（同 id 后者覆盖前者），rules 深度合并。
 *
 * 本模块只接收「已经解析好的 JS 对象」，YAML 解析由酒馆适配层完成，方便在 Node 中测试。
 */
import { DEFAULT_RULES, DRIVER_ATTRS, FACILITIES, STAFF_ROLES, TRACK_DEMANDS } from './defaults';
import type {
  Database,
  DataIssue,
  DriverAttr,
  DriverDef,
  FacilityType,
  PartDef,
  RoundDef,
  Rules,
  StaffAbility,
  StaffMember,
  StaffRole,
  TeamDef,
  TeamSelectionDifficulty,
  TrackDef,
  TrackDemand,
  TyreDef,
} from './types';
import { clamp, deepClone, hashString, isPlainObject, round1 } from './util';

export interface RawSource {
  name: string;
  data: unknown;
}

export interface NormalizeResult {
  db: Database | null;
  issues: DataIssue[];
}

const TOP_KEYS: Record<string, 'rules' | 'teams' | 'drivers' | 'staffCandidates' | 'tracks' | 'calendar'> = {
  rules: 'rules',
  规则: 'rules',
  teams: 'teams',
  车队: 'teams',
  drivers: 'drivers',
  车手: 'drivers',
  staffCandidates: 'staffCandidates',
  staff: 'staffCandidates',
  自由员工: 'staffCandidates',
  tracks: 'tracks',
  赛道: 'tracks',
  calendar: 'calendar',
  赛历: 'calendar',
};

class Ctx {
  issues: DataIssue[] = [];
  source = '';

  err(path: string, message: string): void {
    this.issues.push({ level: 'error', source: this.source, path, message });
  }

  warn(path: string, message: string): void {
    this.issues.push({ level: 'warning', source: this.source, path, message });
  }

  num(
    obj: Record<string, unknown>,
    key: string,
    path: string,
    opt: { def?: number; min?: number; max?: number; required?: boolean } = {},
  ): number {
    const raw = obj[key];
    if (raw === undefined || raw === null || raw === '') {
      if (opt.required) this.err(`${path}.${key}`, '缺少必填数值');
      else if (opt.def === undefined) this.warn(`${path}.${key}`, '缺少数值，已使用 0');
      return opt.def ?? 0;
    }
    const v = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(v)) {
      this.err(`${path}.${key}`, `「${String(raw)}」不是有效数字`);
      return opt.def ?? 0;
    }
    let out = v;
    if (opt.min !== undefined && out < opt.min) {
      this.warn(`${path}.${key}`, `数值 ${v} 小于下限 ${opt.min}，已修正`);
      out = opt.min;
    }
    if (opt.max !== undefined && out > opt.max) {
      this.warn(`${path}.${key}`, `数值 ${v} 大于上限 ${opt.max}，已修正`);
      out = opt.max;
    }
    return out;
  }

  str(obj: Record<string, unknown>, key: string, path: string, opt: { def?: string; required?: boolean } = {}): string {
    const raw = obj[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      if (opt.required) this.err(`${path}.${key}`, '缺少必填文本');
      return opt.def ?? '';
    }
    return String(raw).trim();
  }

  bool(obj: Record<string, unknown>, key: string, def: boolean): boolean {
    const raw = obj[key];
    if (raw === undefined || raw === null) return def;
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === '是' || raw === 1) return true;
    if (raw === 'false' || raw === '否' || raw === 0) return false;
    return def;
  }

  strArr(obj: Record<string, unknown>, key: string): string[] {
    const raw = obj[key];
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) return raw.map(v => String(v).trim()).filter(Boolean);
    return String(raw)
      .split(/[,，、]/)
      .map(s => s.trim())
      .filter(Boolean);
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

/** 深度合并：对象递归合并，数组与原始值直接替换，值为 null 表示删除该键 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) {
    return (patch === undefined ? base : (patch as T)) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = deepClone(v);
    }
  }
  return out as T;
}

const GENERIC_PART: PartDef = {
  name: '零件',
  aero: false,
  developable: true,
  weights: {},
  reliabilityWeight: 0.5,
  baseCost: 2,
  baseWeeks: 4,
  aeroHours: 0,
  unitCost: 0.5,
  crashDamage: 0.1,
};

const GENERIC_TYRE: TyreDef = {
  name: '轮胎',
  short: '?',
  pace: 0,
  deg: 0.06,
  cliff: 27,
  wet: false,
  color: '#888888',
  temperatureWindow: [80, 105],
  warmupRate: 0.32,
};

/** 允许为负数的规则字段（路径里的通配符 * 代表任意零件 / 配方 / 方案） */
const SIGNED_RULE_PATHS = new Set(['tyres.*.pace', 'ambition.*.relDelta', 'seasonYear']);
/** 取值必须在 [min, max] 内的规则字段 */
const RULE_RANGES: Record<string, { min?: number; max?: number; int?: boolean }> = {
  carryOver: { max: 1 },
  'parts.*.crashDamage': { max: 1 },
  'ambition.*.units': { min: 1, int: true },
  'facilities.*.maxLevel': { min: 1, int: true },
  'aiLimits.maxCommands': { int: true },
  mandatoryCompounds: { min: 1, int: true },
  sprintLapsFactor: { max: 1 },
  qualiFinalists: { min: 1, int: true },
  'puAllocation.*': { min: 1, int: true },
  puPenaltyFirst: { int: true },
  puPenaltyNext: { int: true },
  'ferrari.graceRounds': { int: true },
  'ferrari.startMedia': { max: 100 },
  'ferrari.startFans': { max: 100 },
  'ferrari.minMedia': { max: 100 },
  'ferrari.warnMedia': { max: 100 },
  'ferrari.maxFanGap': { max: 100 },
  'ferrari.warnFanGap': { max: 100 },
  'mclaren.failureChance': { min: 0, max: 1 },
  'mclaren.independentWeeks': { min: 1, int: true },
  'mclaren.cooperationWeeks': { min: 1, int: true },
  'mclaren.mercedesDevelopmentBuff': { min: 0, max: 20 },
  'mercedes.failureChance': { min: 0, max: 1 },
  'mercedes.startTotoSatisfaction': { min: 0, max: 100 },
  'mercedes.dismissTotoSatisfaction': { min: 0, max: 100 },
  'mercedes.startPoliticalPressure': { min: 0, max: 120 },
  'mercedes.banPoliticalPressure': { min: 1, max: 120 },
  'mercedes.pressurePerRace': { min: 0, max: 120 },
  'mercedes.aduoProgressPerLobby': { min: 1, max: 100 },
  'ferrari.turboStartGainMin': { min: 0, max: 10, int: true },
  'ferrari.turboStartGainMax': { min: 0, max: 10, int: true },
  'ferrari.turboSpoolSeconds': { min: 0, max: 30 },
  'performance.qualiSetupMax': { min: 0, max: 2 },
  'performance.raceSetupMax': { min: 0, max: 2 },
  'performance.qualiBonusMax': { min: 0, max: 1 },
  'performance.practiceWearKnowledgeMax': { min: 0, max: .5 },
  'performance.temperatureLapMax': { min: 0, max: 3 },
  'performance.overheatWearMax': { min: 0, max: 1 },
  'performance.trackFitMax': { min: 0, max: .5 },
  'redBull.mistakeMultiplier': { min: 1, max: 5 },
  'redBull.startGpRetention': { min: 0, max: 100 },
  'redBull.gpLossPerRace': { min: 0, max: 100 },
  'redBull.gpNegotiationGain': { min: 0, max: 100 },
  'redBull.gpNegotiationCost': { min: 0 },
  'astonMartin.vibrationInterval': { min: 1, int: true },
  'astonMartin.vibrationRetireChance': { min: 0, max: 1 },
  'astonMartin.startHondaConflict': { min: 0, max: 100 },
  'astonMartin.startMediaPressure': { min: 0, max: 100 },
  'astonMartin.mediaConfidenceLoss': { min: 0, max: 20 },
  'astonMartin.aduoPressureGain': { min: 1, max: 100 },
  'astonMartin.mediationGain': { min: 1, max: 100 },
  'astonMartin.neweyProgressGain': { min: 1, max: 100 },
  'astonMartin.aduoPuBuff': { min: 0, max: 30 },
  'astonMartin.chassisBuff': { min: 0, max: 20 },
  'racingBulls.recallChance': { min: 0, max: 1 },
  'audi.startDropMin': { min: 0, max: 10, int: true },
  'audi.startDropMax': { min: 0, max: 10, int: true },
  'audi.allianceProgress': { min: 1, max: 100 },
  'audi.progressPerRace': { min: 0, max: 100 },
  'fiaMeeting.interval': { min: 1, int: true },
  'fiaMeeting.startPoliticalCapital': { min: 0, max: 100 },
  'alpine.startBriatoreSatisfaction': { min: 0, max: 100 },
  'alpine.dismissBriatoreSatisfaction': { min: 0, max: 100 },
  'alpine.startFanPressure': { min: 0, max: 100 },
  'alpine.startGaslyCommitment': { min: 0, max: 100 },
  'alpine.startPuIntegration': { min: 0, max: 100 },
  'alpine.integrationGain': { min: 1, max: 100 },
  'haas.startGeneSupport': { min: 0, max: 100 },
  'haas.startToyotaSupport': { min: 0, max: 100 },
  'haas.startToyotaInfluence': { min: 0, max: 100 },
  'haas.influencePerRace': { min: 0, max: 100 },
  'haas.interferenceThreshold': { min: 0, max: 100 },
  'haas.dismissGeneSupport': { min: 0, max: 100 },
  'williams.startVowlesConfidence': { min: 0, max: 100 },
  'williams.startSuccessionReadiness': { min: 0, max: 100 },
  'williams.successionThreshold': { min: 0, max: 100 },
  'williams.dismissVowlesConfidence': { min: 0, max: 100 },
  'randomEvents.noneWeight': { min: 0 },
  'randomEvents.minPerWeek': { min: 0, max: 10, int: true },
  'randomEvents.maxPerWeek': { min: 0, max: 10, int: true },
  'randomEvents.routineWeight': { min: 0 },
  'randomEvents.driverInjuryWeight': { min: 0 },
  'randomEvents.windTunnelWeight': { min: 0 },
  'randomEvents.partIssueWeight': { min: 0 },
  'randomEvents.minDialogueTurns': { min: 1, max: 6, int: true },
  'randomEvents.maxDialogueTurns': { min: 1, max: 6, int: true },
  'aduo.baseUpgrades': { int: true },
  'aduo.tier1Upgrades': { int: true },
  'aduo.tier2Upgrades': { int: true },
  'aduo.tier1WeeksMul': { min: 0.1, max: 2 },
  'aduo.tier2WeeksMul': { min: 0.1, max: 2 },
};

/**
 * 按模板逐字段检查合并后的规则：类型不对、不是有限数、超出范围时报错并恢复成模板值。
 * 规则来自玩家可编辑的世界书，所以这里不能信任任何结构。
 */
function sanitizeRuleValue(ctx: Ctx, value: unknown, template: unknown, path: string, pattern: string): unknown {
  if (value === undefined) {
    ctx.warn(`rules.${path}`, '字段被删除或缺失，已使用默认值');
    return deepClone(template);
  }
  if (typeof template === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      ctx.err(`rules.${path}`, `「${String(value)}」不是有效数字`);
      return template;
    }
    // ambition / facilities 的键是固定的，但规则表里统一用通配符书写
    const wild = pattern.replace(/^(ambition|facilities)\.[^.]+\./, '$1.*.').replace(/^puAllocation\.[^.]+$/, 'puAllocation.*');
    const range = RULE_RANGES[wild] ?? {};
    const min = range.min ?? (SIGNED_RULE_PATHS.has(wild) ? -Infinity : 0);
    if (value < min || (range.max !== undefined && value > range.max) || (range.int && !Number.isInteger(value))) {
      const bounds = `${min === -Infinity ? '' : `≥ ${min}`}${range.max !== undefined ? ` 且 ≤ ${range.max}` : ''}${range.int ? '（整数）' : ''}`;
      ctx.err(`rules.${path}`, `数值 ${value} 不合法，应为 ${bounds}`);
      return template;
    }
    return value;
  }
  if (typeof template === 'boolean' || typeof template === 'string') {
    if (typeof value !== typeof template) {
      ctx.err(`rules.${path}`, `应为${typeof template === 'boolean' ? '是/否' : '文本'}`);
      return template;
    }
    return value;
  }
  if (Array.isArray(template)) {
    const wantString = typeof template[0] === 'string';
    const ok =
      Array.isArray(value) &&
      value.every(v => (wantString ? typeof v === 'string' : typeof v === 'number' && Number.isFinite(v) && v >= 0));
    if (!ok) {
      ctx.err(`rules.${path}`, wantString ? '应为文本列表' : '应为非负数字列表');
      return deepClone(template);
    }
    return value;
  }
  if (isPlainObject(template)) {
    if (!isPlainObject(value)) {
      ctx.err(path ? `rules.${path}` : 'rules', '应为键值对象');
      return deepClone(template);
    }
    const out: Record<string, unknown> = { ...value };
    if (FIXED_RULE_MAPS.has(pattern)) {
      // 键名固定的映射（设施、研发激进程度）：未知条目（多半是拼写错误）忽略并提示
      for (const k of Object.keys(value)) {
        if (!(k in template)) {
          ctx.warn(`rules.${path}.${k}`, `未知条目，已忽略（可用：${Object.keys(template).join('、')}）`);
          delete out[k];
        }
      }
    }
    for (const [k, t] of Object.entries(template)) {
      const sub = (prefix: string) => (prefix ? `${prefix}.${k}` : k);
      out[k] = sanitizeRuleValue(ctx, value[k], t, sub(path), sub(pattern));
    }
    return out;
  }
  return value;
}

/** 键名固定的规则映射 */
const FIXED_RULE_MAPS = new Set(['facilities', 'ambition']);

/** 检查一个「名字由用户决定」的映射（零件、轮胎），每一项按同一个模板检查 */
function sanitizeRuleMap<T>(ctx: Ctx, value: unknown, generic: T, key: 'parts' | 'tyres'): Record<string, T> {
  if (!isPlainObject(value)) {
    ctx.err(`rules.${key}`, '应为键值对象');
    return {};
  }
  const out: Record<string, T> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      ctx.err(`rules.${key}.${name}`, '应为键值对象');
      continue;
    }
    // 默认规则里有的条目，非法值恢复成该条目的默认值；新增条目恢复成通用默认值
    const builtin = (DEFAULT_RULES[key] as Record<string, unknown>)[name];
    const template = builtin ? deepMerge(generic, builtin) : generic;
    out[name] = sanitizeRuleValue(ctx, deepMerge(template, entry), template, `${key}.${name}`, `${key}.*`) as T;
  }
  return out;
}

function normalizeRules(ctx: Ctx, patches: Array<{ source: string; data: unknown }>): Rules {
  let merged: Record<string, unknown> = deepClone(DEFAULT_RULES) as unknown as Record<string, unknown>;
  for (const p of patches) {
    ctx.source = p.source;
    if (!isPlainObject(p.data)) {
      ctx.err('rules', '规则必须是键值对象');
      continue;
    }
    merged = deepMerge(merged, p.data);
  }
  ctx.source = '规则（合并后）';
  const { parts: rawParts, tyres: rawTyres, ...rest } = merged;
  const { parts: _p, tyres: _t, ...restTemplate } = DEFAULT_RULES;
  const rules = {
    ...(sanitizeRuleValue(ctx, rest, restTemplate, '', '') as Omit<Rules, 'parts' | 'tyres'>),
    parts: sanitizeRuleMap(ctx, rawParts, GENERIC_PART, 'parts'),
    tyres: sanitizeRuleMap(ctx, rawTyres, GENERIC_TYRE, 'tyres'),
  } as Rules;
  if (rules.audi.startDropMin > rules.audi.startDropMax) {
    ctx.err('rules.audi.startDropMin', '奥迪起步掉位下限不能大于上限');
  }
  if (rules.ferrari.turboStartGainMin > rules.ferrari.turboStartGainMax) {
    ctx.err('rules.ferrari.turboStartGainMin', '法拉利起步提升下限不能大于上限');
  }

  for (const [key, def] of Object.entries(rules.parts)) {
    for (const [attr, w] of Object.entries(def.weights)) {
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
        ctx.err(`rules.parts.${key}.weights.${attr}`, '权重应为非负数字');
        delete (def.weights as Record<string, unknown>)[attr];
      }
    }
  }
  if (Object.keys(rules.parts).length === 0) {
    ctx.err('rules.parts', '至少需要定义一种零件');
  }
  // 轮胎
  if (rules.dryCompounds.length === 0) {
    ctx.err('rules.dryCompounds', '至少需要一种干地配方');
    rules.dryCompounds = [...DEFAULT_RULES.dryCompounds];
  }
  for (const c of rules.dryCompounds) {
    if (!rules.tyres[c]) ctx.err('rules.dryCompounds', `干地配方「${c}」未在 rules.tyres 中定义`);
  }
  for (const [key, tyre] of Object.entries(rules.tyres)) {
    const raw = tyre.temperatureWindow;
    const fallback: [number, number] = tyre.wet ? [58, 78] : [80, 105];
    if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(value => typeof value === 'number' && Number.isFinite(value)) || raw[0] < 20 || raw[1] > 140 || raw[0] >= raw[1]) {
      ctx.warn(`rules.tyres.${key}.temperatureWindow`, '胎温窗口无效，已使用安全默认值');
      tyre.temperatureWindow = fallback;
    } else tyre.temperatureWindow = [raw[0], raw[1]];
    if (!Number.isFinite(tyre.warmupRate) || tyre.warmupRate! < .05 || tyre.warmupRate! > 1) {
      ctx.warn(`rules.tyres.${key}.warmupRate`, '暖胎率无效，已使用安全默认值');
      tyre.warmupRate = tyre.wet ? .4 : .32;
    }
  }
  const dryWindows: Record<string, [number, number]> = { soft: [80, 100], medium: [85, 105], hard: [90, 110] };
  const namedDry = ['soft', 'medium', 'hard'].map(key => rules.tyres[key]);
  if (namedDry.every(Boolean) && !(namedDry[0].temperatureWindow![0] < namedDry[1].temperatureWindow![0] && namedDry[1].temperatureWindow![0] < namedDry[2].temperatureWindow![0])) {
    ctx.warn('rules.tyres', '软、中、硬胎最低温窗必须依次升高，已恢复平衡默认值');
    for (const [key, window] of Object.entries(dryWindows)) rules.tyres[key].temperatureWindow = window;
  }
  if (!rules.tyres[rules.wetCompound]) ctx.err('rules.wetCompound', `雨地配方「${rules.wetCompound}」未定义`);
  if (!rules.tyres[rules.fullWetCompound]) ctx.err('rules.fullWetCompound', `全雨胎配方「${rules.fullWetCompound}」未定义`);
  if (rules.fullWetCompound === rules.wetCompound) ctx.warn('rules.fullWetCompound', '全雨胎与半雨胎使用了同一配方，大雨策略不会产生差异');
  if (rules.tyres[rules.wetCompound] && !rules.tyres[rules.wetCompound].wet) ctx.warn('rules.wetCompound', '半雨胎配方未标记为雨胎');
  if (rules.tyres[rules.fullWetCompound] && !rules.tyres[rules.fullWetCompound].wet) ctx.warn('rules.fullWetCompound', '全雨胎配方未标记为雨胎');
  if (rules.aeroAllowanceByPosition.length === 0) {
    ctx.err('rules.aeroAllowanceByPosition', '风洞时长倍率表不能为空');
    rules.aeroAllowanceByPosition = [...DEFAULT_RULES.aeroAllowanceByPosition];
  }
  for (const [key, f] of Object.entries(rules.facilities)) {
    for (const list of ['upgradeCost', 'upgradeWeeks'] as const) {
      if (f[list].length < f.maxLevel - 1) {
        ctx.err(`rules.facilities.${key}.${list}`, `最高 ${f.maxLevel} 级需要 ${f.maxLevel - 1} 个数值（当前 ${f[list].length} 个）`);
      }
    }
  }
  rules.mandatoryCompounds = Math.min(rules.mandatoryCompounds, rules.dryCompounds.length);
  for (const [pt, n] of Object.entries(rules.puAllocation)) {
    if (!rules.parts[pt]) {
      ctx.warn(`rules.puAllocation.${pt}`, `规则中没有零件类型「${pt}」，已忽略`);
      delete rules.puAllocation[pt];
    } else if (!Number.isInteger(n) || n < 1) {
      ctx.err(`rules.puAllocation.${pt}`, '配额应为 ≥ 1 的整数');
      delete rules.puAllocation[pt];
    }
  }
  rules.aduo.parts = rules.aduo.parts.filter(pt => {
    if (rules.parts[pt]) return true;
    ctx.warn('rules.aduo.parts', `规则中没有零件类型「${pt}」，已忽略`);
    return false;
  });
  if (!rules.parts[rules.aduo.measurePart]) ctx.warn('rules.aduo.measurePart', `规则中没有零件类型「${rules.aduo.measurePart}」，ADUO 不会评估`);
  if (rules.aduo.tier2Deficit < rules.aduo.tier1Deficit) ctx.warn('rules.aduo.tier2Deficit', '二档门槛低于一档门槛，二档会覆盖一档');
  return rules;
}

const STAFF_ABILITIES: StaffAbility[] = ['setup', 'communication', 'reaction', 'strategy', 'weather', 'risk'];

function normalizeStaffAbilities(ctx: Ctx, raw: unknown, path: string): StaffMember['abilities'] {
  const obj = asObject(raw);
  const abilities: StaffMember['abilities'] = {};
  for (const ability of STAFF_ABILITIES) {
    if (obj[ability] !== undefined) abilities[ability] = ctx.num(obj, ability, path, { def: 60, min: 1, max: 100 });
  }
  return Object.keys(abilities).length ? abilities : undefined;
}

function normalizeStaff(ctx: Ctx, raw: unknown, path: string): Record<StaffRole, StaffMember> {
  const obj = asObject(raw);
  const out = {} as Record<StaffRole, StaffMember>;
  for (const role of STAFF_ROLES) {
    const r = obj[role];
    if (typeof r === 'number') {
      out[role] = { id: '', role, name: '', skill: clamp(r, 1, 100), salary: 1 };
      continue;
    }
    const m = asObject(r);
    if (role === 'raceEngineer2' && r === undefined && out.raceEngineer) {
      out[role] = { ...deepClone(out.raceEngineer), id: '', role, name: `${out.raceEngineer.name || '比赛工程师'}（二号车）` };
      continue;
    }
    if (r === undefined) ctx.warn(`${path}.${role}`, '未填写，已使用默认能力 60');
    out[role] = {
      id: ctx.str(m, 'id', `${path}.${role}`),
      role,
      name: ctx.str(m, 'name', `${path}.${role}`),
      skill: ctx.num(m, 'skill', `${path}.${role}`, { def: 60, min: 1, max: 100 }),
      abilities: normalizeStaffAbilities(ctx, m.abilities, `${path}.${role}.abilities`),
      salary: ctx.num(m, 'salary', `${path}.${role}`, { def: 1, min: 0 }),
      contractStart: Math.round(ctx.num(m, 'contractStart', `${path}.${role}`, { def: 0 })),
      contractEnd: Math.round(ctx.num(m, 'contractEnd', `${path}.${role}`, { def: 0 })),
      series: ctx.str(m, 'series', `${path}.${role}`),
      description: ctx.str(m, 'description', `${path}.${role}`),
    };
  }
  return out;
}

function normalizeTeam(ctx: Ctx, raw: unknown, index: number, rules: Rules): TeamDef | null {
  const path = `teams[${index}]`;
  if (!isPlainObject(raw)) {
    ctx.err(path, '车队条目必须是对象');
    return null;
  }
  const id = ctx.str(raw, 'id', path, { required: true });
  if (!id) return null;
  const facilitiesRaw = asObject(raw.facilities);
  const facilities = {} as Record<FacilityType, number>;
  for (const f of FACILITIES) {
    facilities[f] = Math.round(
      ctx.num(facilitiesRaw, f, `${path}.facilities`, { def: 2, min: 1, max: rules.facilities[f]?.maxLevel ?? 5 }),
    );
  }
  const carBase = asObject(raw.carBase);
  const basePerf = ctx.num(carBase, 'perf', `${path}.carBase`, { def: 70, min: 1, max: 100 });
  const baseRel = ctx.num(carBase, 'rel', `${path}.carBase`, { def: 80, min: 1, max: 100 });
  const partsRaw = asObject(raw.parts);
  const parts: TeamDef['parts'] = {};
  for (const pt of Object.keys(rules.parts)) {
    const p = partsRaw[pt];
    if (typeof p === 'number') {
      parts[pt] = { perf: clamp(p, 1, 100), rel: baseRel };
      continue;
    }
    const po = asObject(p);
    if (p === undefined && raw.carBase === undefined) {
      ctx.warn(`${path}.parts.${pt}`, '未填写零件性能，已使用 carBase 或默认值 70/80');
    }
    parts[pt] = {
      perf: ctx.num(po, 'perf', `${path}.parts.${pt}`, { def: basePerf, min: 1, max: 100 }),
      rel: ctx.num(po, 'rel', `${path}.parts.${pt}`, { def: baseRel, min: 1, max: 100 }),
    };
  }
  for (const k of Object.keys(partsRaw)) {
    if (!rules.parts[k]) ctx.warn(`${path}.parts.${k}`, `规则中没有零件类型「${k}」，已忽略`);
  }
  const name = ctx.str(raw, 'name', path, { def: id });
  return {
    id,
    name,
    short: ctx.str(raw, 'short', path, { def: name.slice(0, 3).toUpperCase() }),
    color: ctx.str(raw, 'color', path, { def: '#888888' }),
    principal: ctx.str(raw, 'principal', path),
    engine: ctx.str(raw, 'engine', path),
    worksTeam: ctx.bool(raw, 'worksTeam', false),
    base: ctx.str(raw, 'base', path),
    funds: ctx.num(raw, 'funds', path, { def: 50 }),
    sponsorIncome: ctx.num(raw, 'sponsorIncome', path, { def: 4, min: 0 }),
    operatingCost: ctx.num(raw, 'operatingCost', path, { def: 2, min: 0 }),
    facilities,
    staff: normalizeStaff(ctx, raw.staff, `${path}.staff`),
    parts,
    targetPosition: Math.round(ctx.num(raw, 'targetPosition', path, { def: 5, min: 1 })),
    selectionDifficulty: normalizeSelectionDifficulty(ctx, raw, path),
    description: ctx.str(raw, 'description', path),
    special: normalizeSpecial(ctx, raw, path),
  };
}

const SELECTION_DIFFICULTIES: readonly TeamSelectionDifficulty[] = ['easy', 'medium', 'hard'];

function normalizeSelectionDifficulty(ctx: Ctx, raw: Record<string, unknown>, path: string): TeamSelectionDifficulty {
  const v = ctx.str(raw, 'selectionDifficulty', path).toLowerCase();
  if (!v) return 'medium';
  if ((SELECTION_DIFFICULTIES as readonly string[]).includes(v)) return v as TeamSelectionDifficulty;
  ctx.warn(`${path}.selectionDifficulty`, `未知的选队难度「${v}」，已视为 medium（可用：${SELECTION_DIFFICULTIES.join('、')}）`);
  return 'medium';
}

/** 目前支持的特殊机制 */
export const SPECIAL_MECHANICS = ['ferrari', 'mclaren', 'mercedes', 'red_bull', 'aston_martin', 'racing_bulls', 'audi', 'alpine', 'haas', 'williams'] as const;

function normalizeSpecial(ctx: Ctx, raw: Record<string, unknown>, path: string): string {
  const v = ctx.str(raw, 'special', path).toLowerCase();
  if (!v) return '';
  if (!(SPECIAL_MECHANICS as readonly string[]).includes(v)) {
    ctx.warn(`${path}.special`, `未知的特殊机制「${v}」，已忽略（可用：${SPECIAL_MECHANICS.join('、')}）`);
    return '';
  }
  return v;
}

function normalizeDriver(ctx: Ctx, raw: unknown, index: number): DriverDef | null {
  const path = `drivers[${index}]`;
  if (!isPlainObject(raw)) {
    ctx.err(path, '车手条目必须是对象');
    return null;
  }
  const id = ctx.str(raw, 'id', path, { required: true });
  if (!id) return null;
  const attrsRaw = asObject(raw.attrs);
  const attrs = {} as Record<DriverAttr, number>;
  for (const a of DRIVER_ATTRS) {
    attrs[a] = round1(ctx.num(attrsRaw, a, `${path}.attrs`, { def: 70, min: 1, max: 100 }));
  }
  const teamRaw = raw.team ?? raw.teamId;
  const role = ctx.str(raw, 'role', path, { def: 'race' });
  if (role !== 'race' && role !== 'reserve') ctx.warn(`${path}.role`, `未知角色「${role}」，已视为 race`);
  const name = ctx.str(raw, 'name', path, { def: id });
  const overall = DRIVER_ATTRS.reduce((s, a) => s + attrs[a], 0) / DRIVER_ATTRS.length;
  return {
    id,
    name,
    short: ctx.str(raw, 'short', path, { def: name.slice(0, 3).toUpperCase() }),
    number: Math.round(ctx.num(raw, 'number', path, { def: index + 1, min: 0, max: 999 })),
    nationality: ctx.str(raw, 'nationality', path),
    age: Math.round(ctx.num(raw, 'age', path, { def: 25, min: 14, max: 60 })),
    teamId: teamRaw === undefined || teamRaw === null || teamRaw === '' ? null : String(teamRaw).trim(),
    role: role === 'reserve' ? 'reserve' : 'race',
    attrs,
    potential: ctx.num(raw, 'potential', path, { def: Math.min(100, round1(overall + 5)), min: 1, max: 100 }),
    morale: ctx.num(raw, 'morale', path, { def: 65, min: 0, max: 100 }),
    fitness: ctx.num(raw, 'fitness', path, { def: 100, min: 0, max: 100 }),
    ego: ctx.num(raw, 'ego', path, { def: 50, min: 0, max: 100 }),
    salary: ctx.num(raw, 'salary', path, { def: 2, min: 0 }),
    contractStart: Math.round(ctx.num(raw, 'contractStart', path, { def: 0 })),
    contractEnd: Math.round(ctx.num(raw, 'contractEnd', path, { def: 0 })),
    traits: ctx.strArr(raw, 'traits'),
    series: ctx.str(raw, 'series', path),
    description: ctx.str(raw, 'description', path),
  };
}

function normalizeTrack(ctx: Ctx, raw: unknown, index: number): TrackDef | null {
  const path = `tracks[${index}]`;
  if (!isPlainObject(raw)) {
    ctx.err(path, '赛道条目必须是对象');
    return null;
  }
  const id = ctx.str(raw, 'id', path, { required: true });
  if (!id) return null;
  const wRaw = asObject(raw.weights);
  const weights = {} as Record<TrackDemand, number>;
  let total = 0;
  for (const k of TRACK_DEMANDS) {
    weights[k] = ctx.num(wRaw, k, `${path}.weights`, { def: 0.25, min: 0 });
    total += weights[k];
  }
  if (total <= 0) {
    ctx.warn(`${path}.weights`, '权重总和为 0，已改为平均分配');
    for (const k of TRACK_DEMANDS) weights[k] = 0.25;
    total = 1;
  }
  for (const k of TRACK_DEMANDS) weights[k] = Math.round((weights[k] / total) * 1000) / 1000;
  const name = ctx.str(raw, 'name', path, { def: id });
  return {
    id,
    name,
    country: ctx.str(raw, 'country', path),
    type: ctx.str(raw, 'type', path, { def: '均衡' }),
    laps: Math.round(ctx.num(raw, 'laps', path, { def: 50, min: 3, max: 120 })),
    baseLap: ctx.num(raw, 'baseLap', path, { def: 85, min: 30, max: 300 }),
    pitLoss: ctx.num(raw, 'pitLoss', path, { def: 21, min: 5, max: 60 }),
    weights,
    overtaking: ctx.num(raw, 'overtaking', path, { def: 55, min: 0, max: 100 }),
    tyreStress: ctx.num(raw, 'tyreStress', path, { def: 50, min: 0, max: 100 }),
    surfaceTemperature: ctx.num(raw, 'surfaceTemperature', path, { def: 32, min: 10, max: 65 }),
    thermalDemand: ctx.num(raw, 'thermalDemand', path, { def: ctx.num(raw, 'tyreStress', path, { def: 50, min: 0, max: 100 }), min: 0, max: 100 }),
    rainChance: ctx.num(raw, 'rainChance', path, { def: 0.15, min: 0, max: 1 }),
    scChance: ctx.num(raw, 'scChance', path, { def: 0.5, min: 0, max: 1 }),
    description: ctx.str(raw, 'description', path),
  };
}

function normalizeRound(ctx: Ctx, raw: unknown, index: number): RoundDef | null {
  const path = `calendar[${index}]`;
  if (typeof raw === 'string') {
    return { id: `r${index + 1}`, trackId: raw, name: '', sprint: false, weeksGap: 2, dateLabel: '' };
  }
  if (!isPlainObject(raw)) {
    ctx.err(path, '赛历条目必须是对象或赛道 id');
    return null;
  }
  const trackId = ctx.str(raw, 'track', path) || ctx.str(raw, 'trackId', path, { required: true });
  if (!trackId) return null;
  return {
    id: ctx.str(raw, 'id', path, { def: `r${index + 1}` }),
    trackId,
    name: ctx.str(raw, 'name', path),
    sprint: ctx.bool(raw, 'sprint', false),
    weeksGap: Math.round(ctx.num(raw, 'weeksGap', path, { def: 2, min: 0, max: 20 })),
    dateLabel: ctx.str(raw, 'date', path) || ctx.str(raw, 'dateLabel', path),
  };
}

function mergeById<T extends { id: string }>(ctx: Ctx, list: Array<{ item: T; source: string }>, label: string): T[] {
  const map = new Map<string, T>();
  const order: string[] = [];
  for (const { item, source } of list) {
    if (map.has(item.id)) {
      ctx.source = source;
      ctx.warn(`${label}.${item.id}`, `重复的 id，后出现的定义覆盖了前面的`);
    } else {
      order.push(item.id);
    }
    map.set(item.id, item);
  }
  return order.map(id => map.get(id)!);
}

/**
 * 把多个世界书条目的原始数据合并、补全、校验成数据库。
 * 有任何 error 时 db 仍会尽量返回，但 canStart 会是 false（调用方应阻止开局）。
 */
export function normalizeDatabase(sources: RawSource[]): NormalizeResult & { canStart: boolean } {
  const ctx = new Ctx();
  const rulePatches: Array<{ source: string; data: unknown }> = [];
  const rawLists: Record<'teams' | 'drivers' | 'staffCandidates' | 'tracks' | 'calendar', Array<{ raw: unknown; source: string }>> = {
    teams: [],
    drivers: [],
    staffCandidates: [],
    tracks: [],
    calendar: [],
  };

  for (const src of sources) {
    ctx.source = src.name;
    if (!isPlainObject(src.data)) {
      ctx.err('(根)', '内容不是 YAML 键值对象，已跳过');
      continue;
    }
    let recognized = false;
    for (const [key, value] of Object.entries(src.data)) {
      const k = TOP_KEYS[key];
      if (!k) {
        ctx.warn(key, '无法识别的顶层键（应为 rules/teams/drivers/tracks/calendar 或对应中文），已忽略');
        continue;
      }
      recognized = true;
      if (k === 'rules') {
        rulePatches.push({ source: src.name, data: value });
      } else if (Array.isArray(value)) {
        for (const item of value) rawLists[k].push({ raw: item, source: src.name });
      } else if (value !== null && value !== undefined) {
        ctx.err(key, '应为列表（YAML 中以「- 」开头的多项）');
      }
    }
    if (!recognized) ctx.warn('(根)', '条目中没有任何可识别的数据');
  }

  const rules = normalizeRules(ctx, rulePatches);

  const teamItems: Array<{ item: TeamDef; source: string }> = [];
  rawLists.teams.forEach((r, i) => {
    ctx.source = r.source;
    const t = normalizeTeam(ctx, r.raw, i, rules);
    if (t) teamItems.push({ item: t, source: r.source });
  });
  const driverItems: Array<{ item: DriverDef; source: string }> = [];
  rawLists.drivers.forEach((r, i) => {
    ctx.source = r.source;
    const d = normalizeDriver(ctx, r.raw, i);
    if (d) driverItems.push({ item: d, source: r.source });
  });
  const staffCandidates: StaffMember[] = [];
  rawLists.staffCandidates.forEach((r, i) => {
    ctx.source = r.source;
    const raw = asObject(r.raw);
    const role = ctx.str(raw, 'role', `staffCandidates[${i}]`);
    if (!(STAFF_ROLES as readonly string[]).includes(role)) { ctx.err(`staffCandidates[${i}].role`, '员工岗位无效'); return; }
    const id = ctx.str(raw, 'id', `staffCandidates[${i}]`, { required: true });
    if (!id) return;
    staffCandidates.push({ id, role: role as StaffRole, name: ctx.str(raw, 'name', `staffCandidates[${i}]`, { def: id }), skill: ctx.num(raw, 'skill', `staffCandidates[${i}]`, { def: 60, min: 1, max: 100 }), abilities: normalizeStaffAbilities(ctx, raw.abilities, `staffCandidates[${i}].abilities`), salary: ctx.num(raw, 'salary', `staffCandidates[${i}]`, { def: 1, min: 0 }), contractStart: 0, contractEnd: 0, series: ctx.str(raw, 'series', `staffCandidates[${i}]`), description: ctx.str(raw, 'description', `staffCandidates[${i}]`) });
  });
  const trackItems: Array<{ item: TrackDef; source: string }> = [];
  rawLists.tracks.forEach((r, i) => {
    ctx.source = r.source;
    const t = normalizeTrack(ctx, r.raw, i);
    if (t) trackItems.push({ item: t, source: r.source });
  });
  const rounds: RoundDef[] = [];
  rawLists.calendar.forEach((r, i) => {
    ctx.source = r.source;
    const rd = normalizeRound(ctx, r.raw, i);
    if (rd) rounds.push(rd);
  });

  const teams = mergeById(ctx, teamItems, 'teams');
  // 每个动力单元厂商只能有一支厂商车队
  const worksByEngine = new Map<string, string>();
  for (const t of teams) {
    if (!t.worksTeam) continue;
    if (!t.engine) {
      ctx.source = '车队（合并后）';
      ctx.warn(`teams.${t.id}.worksTeam`, '没有填写 engine，不能作为厂商车队，已忽略');
      t.worksTeam = false;
    } else if (worksByEngine.has(t.engine)) {
      ctx.source = '车队（合并后）';
      ctx.warn(`teams.${t.id}.worksTeam`, `动力单元「${t.engine}」已有厂商车队 ${worksByEngine.get(t.engine)}，已忽略`);
      t.worksTeam = false;
    } else worksByEngine.set(t.engine, t.id);
  }
  const drivers = mergeById(ctx, driverItems, 'drivers');
  const tracks = mergeById(ctx, trackItems, 'tracks');
  // 赛历 id 去重
  const seenRound = new Set<string>();
  rounds.forEach((r, i) => {
    if (seenRound.has(r.id)) r.id = `${r.id}_${i + 1}`;
    seenRound.add(r.id);
  });

  // ── 交叉校验 ──
  ctx.source = '交叉校验';
  const teamIds = new Set(teams.map(t => t.id));
  const trackIds = new Set(tracks.map(t => t.id));
  if (teams.length < 2) ctx.err('teams', `至少需要 2 支车队（当前 ${teams.length} 支）`);
  if (tracks.length < 1) ctx.err('tracks', '至少需要 1 条赛道');
  if (rounds.length < 1) ctx.err('calendar', '赛历至少需要 1 站');
  for (const d of drivers) {
    if (d.teamId && !teamIds.has(d.teamId)) ctx.err(`drivers.${d.id}.team`, `引用了不存在的车队「${d.teamId}」`);
  }
  for (const t of teams) {
    const raceDrivers = drivers.filter(d => d.teamId === t.id && d.role === 'race');
    if (raceDrivers.length === 0) ctx.err(`teams.${t.id}`, '没有任何正式车手（role: race）');
    if (raceDrivers.length > 3) ctx.err(`teams.${t.id}`, `正式车手超过 3 名（${raceDrivers.length} 名）`);
  }
  for (const r of rounds) {
    if (!trackIds.has(r.trackId)) ctx.err(`calendar.${r.id}`, `引用了不存在的赛道「${r.trackId}」`);
  }
  const numbers = new Map<number, string>();
  for (const d of drivers.filter(x => x.teamId)) {
    if (numbers.has(d.number)) ctx.warn(`drivers.${d.id}.number`, `车号 ${d.number} 与 ${numbers.get(d.number)} 重复`);
    numbers.set(d.number, d.id);
  }

  const sourceNames = sources.map(s => s.name);
  const body = { rules, teams, drivers, staffCandidates, tracks, calendar: rounds };
  const db: Database = { ...body, sources: sourceNames, signature: hashString(JSON.stringify(body)) };
  const canStart = !ctx.issues.some(i => i.level === 'error');
  return { db, issues: ctx.issues, canStart };
}
