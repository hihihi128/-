import { dismissalReason } from './teamSpecials';
import { staffAbility } from './staff';
import type { AiLogEntry, DriverAttr, GameState, SetupState, StaffAbility } from './types';
import { clamp, pushCapped, round1, round2, stamp } from './util';

export const SUPERNATURAL_LIMITS = {
  morale: 10,
  trust: 10,
  fitness: 20,
  board: 8,
  media: 10,
  staff: 10,
  driverAttr: 1,
  staffSkill: 1,
  funds: 3,
  researchWeeks: 1,
  weatherTendency: 0.1,
  weatherPending: 0.2,
  carSetup: 10,
  carSetupOffset: 15,
  maxCommands: 8,
} as const;

export type SupernaturalCommand =
  | { op: 'morale' | 'trust' | 'fitness'; driver: string; delta: number; reason: string }
  | { op: 'board' | 'media' | 'staff' | 'funds' | 'weather_tendency'; delta: number; reason: string }
  | { op: 'driver_attr'; driver: string; attr: DriverAttr; delta: number; reason: string }
  | { op: 'staff_skill'; staffId: string; field: 'skill' | StaffAbility; delta: number; reason: string }
  | { op: 'research_progress'; projectId: string; weeks: number; reason: string }
  | { op: 'car_setup'; driver: string; field: 'confidence' | 'tyreKnowledge'; delta: number; reason: string };

const DRIVER_ATTRS = new Set<DriverAttr>(['pace', 'racecraft', 'consistency', 'tyre', 'wet', 'feedback']);
const STAFF_FIELDS = new Set<string>(['skill', 'setup', 'communication', 'reaction', 'strategy', 'weather', 'risk']);
const BLOCK = /<F1M_UPDATE>\s*([\s\S]*?)\s*<\/F1M_UPDATE>/gi;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function bounded(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  // The panel always renders plain text; remove control characters before save.
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}

function noUnknownKeys(row: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(row).every(key => allowed.includes(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
}

function commandFrom(value: unknown): SupernaturalCommand | string {
  if (!isPlainObject(value)) return '指令必须是普通 JSON 对象';
  const op = value.op;
  if (typeof op !== 'string') return '缺少有效 op';
  const reason = value.reason === undefined ? '' : bounded(value.reason);
  if (reason === null) return 'reason 必须是文本';
  const exact = (keys: string[]) => noUnknownKeys(value, ['op', ...keys, 'reason']);
  const delta = value.delta;
  const driver = value.driver;
  if (op === 'morale' || op === 'trust' || op === 'fitness') {
    if (!exact(['driver', 'delta']) || typeof driver !== 'string' || typeof delta !== 'number' || !Number.isFinite(delta)) return '车手指令字段或数值无效';
    return { op, driver, delta, reason };
  }
  if (op === 'board' || op === 'media' || op === 'staff' || op === 'funds' || op === 'weather_tendency') {
    if (!exact(['delta']) || typeof delta !== 'number' || !Number.isFinite(delta)) return '车队指令字段或数值无效';
    return { op, delta, reason };
  }
  if (op === 'driver_attr') {
    if (!exact(['driver', 'attr', 'delta']) || typeof driver !== 'string' || typeof value.attr !== 'string' || !DRIVER_ATTRS.has(value.attr as DriverAttr) || typeof delta !== 'number' || !Number.isFinite(delta)) return '车手属性指令字段或数值无效';
    return { op, driver, attr: value.attr as DriverAttr, delta, reason };
  }
  if (op === 'staff_skill') {
    if (!exact(['staffId', 'field', 'delta']) || typeof value.staffId !== 'string' || typeof value.field !== 'string' || !STAFF_FIELDS.has(value.field) || typeof delta !== 'number' || !Number.isFinite(delta)) return '员工技能指令字段或数值无效';
    return { op, staffId: value.staffId, field: value.field as 'skill' | StaffAbility, delta, reason };
  }
  if (op === 'research_progress') {
    if (!exact(['projectId', 'weeks']) || typeof value.projectId !== 'string' || typeof value.weeks !== 'number' || !Number.isInteger(value.weeks) || value.weeks <= 0) return '研发指令字段或周数无效';
    return { op, projectId: value.projectId, weeks: value.weeks, reason };
  }
  if (op === 'car_setup') {
    if (!exact(['driver', 'field', 'delta']) || typeof driver !== 'string' || (value.field !== 'confidence' && value.field !== 'tyreKnowledge') || typeof delta !== 'number' || !Number.isFinite(delta)) return '调校指令字段或数值无效';
    return { op, driver, field: value.field, delta, reason };
  }
  return '不在超自然白名单中的操作';
}

/** Strictly accepts one normal JSON array in one familiar update envelope. */
export function parseSupernaturalCommands(text: unknown): { commands: unknown[]; error: string | null } {
  if (typeof text !== 'string') return { commands: [], error: 'API 返回不是文本' };
  const blocks = [...text.matchAll(BLOCK)];
  if (blocks.length !== 1) return { commands: [], error: '必须返回恰好一个 <F1M_UPDATE> 指令块' };
  let parsed: unknown;
  try { parsed = JSON.parse(blocks[0][1].trim()); } catch { return { commands: [], error: '指令块不是有效 JSON 数组' }; }
  if (!Array.isArray(parsed)) return { commands: [], error: '指令块必须是 JSON 数组' };
  if (parsed.length > SUPERNATURAL_LIMITS.maxCommands) return { commands: [], error: `单次最多 ${SUPERNATURAL_LIMITS.maxCommands} 条指令` };
  return { commands: parsed, error: null };
}

function setupEffect(state: GameState, driverId: string) {
  return state.weekend?.supernaturalCarEffects?.[driverId] ?? { confidence: 0, tyreKnowledge: 0 };
}

/** Natural setup stays stored untouched; this projection is used by every future calculation. */
export function effectiveSetup(state: GameState, driverId: string, natural: SetupState): SetupState {
  const effect = setupEffect(state, driverId);
  return {
    ...natural,
    confidence: round1(clamp(natural.confidence + effect.confidence, 0, 100)),
    tyreKnowledge: round1(clamp(natural.tyreKnowledge + effect.tyreKnowledge, 0, 100)),
  };
}

export interface SupernaturalApplyResult { logs: AiLogEntry[]; changed: boolean }

export function applySupernaturalCommands(state: GameState, rows: unknown[], invocationId: string): SupernaturalApplyResult {
  const logs: AiLogEntry[] = [];
  const team = state.teams[state.meta.playerTeamId];
  const at = stamp(state);
  const used: Record<string, number> = {};
  let researchProject: string | null = null;
  let changed = false;
  const log = (entry: Omit<AiLogEntry, 'at' | 'messageId' | 'source' | 'invocationId'>) => logs.push({ at, messageId: null, source: 'supernatural', invocationId, ...entry });
  const reject = (op: string, target: string, requested: number | string | null, reason: string, note: string) => log({ op, target, requested, applied: null, reason, ok: false, note });
  const apply = (key: string, requested: number, limit: number): number => {
    const remaining = Math.max(0, limit - (used[key] ?? 0));
    const allowed = Math.min(Math.abs(requested), remaining);
    used[key] = (used[key] ?? 0) + allowed;
    return Math.sign(requested) * allowed;
  };
  const numeric = (value: number, delta: number, min: number, max: number) => round1(clamp(value + delta, min, max));
  const inRequestedDirection = (requested: number, min: number, max: number) => requested > 0
    ? Math.max(0, Math.min(requested, max))
    : Math.min(0, Math.max(requested, min));

  for (const raw of rows) {
    const command = commandFrom(raw);
    if (typeof command === 'string') { reject(isPlainObject(raw) && typeof raw.op === 'string' ? raw.op : 'invalid', '', null, '', command); continue; }
    if (!team || !state.meta.supernaturalMode || dismissalReason(state) || state.weekend?.liveRace) {
      reject(command.op, 'driver' in command ? command.driver : team?.id ?? '', 'delta' in command ? command.delta : null, command.reason, '当前状态不能执行超自然干预');
      continue;
    }
    if (command.op === 'morale' || command.op === 'trust' || command.op === 'fitness') {
      const driver = state.drivers[command.driver];
      if (!driver || driver.teamId !== team.id || (driver.role !== 'race' && driver.role !== 'reserve')) { reject(command.op, command.driver, command.delta, command.reason, '目标必须是当前玩家车队车手'); continue; }
      const limit = SUPERNATURAL_LIMITS[command.op];
      const before = driver[command.op];
      const allowed = apply(`${command.op}:${driver.id}`, clamp(command.delta, -before, 100 - before), limit);
      const after = numeric(before, allowed, 0, 100);
      const actual = round1(after - before);
      driver[command.op] = after;
      if (!actual) reject(command.op, driver.id, command.delta, command.reason, '数值已饱和或本次额度已用尽');
      else { changed = true; log({ op: command.op, target: driver.id, requested: command.delta, applied: actual, reason: command.reason, ok: true, note: actual !== command.delta ? '已按上限或边界裁剪' : '' }); }
      continue;
    }
    if (command.op === 'board' || command.op === 'media' || command.op === 'staff') {
      const field = command.op === 'board' ? 'boardConfidence' : command.op === 'media' ? 'mediaReputation' : 'staffMorale';
      const before = team[field];
      const allowed = apply(command.op, clamp(command.delta, -before, 100 - before), SUPERNATURAL_LIMITS[command.op]);
      const after = numeric(before, allowed, 0, 100); const actual = round1(after - before);
      team[field] = after;
      if (!actual) reject(command.op, team.id, command.delta, command.reason, '数值已饱和或本次额度已用尽');
      else { changed = true; log({ op: command.op, target: team.id, requested: command.delta, applied: actual, reason: command.reason, ok: true, note: actual !== command.delta ? '已按上限或边界裁剪' : '' }); }
      continue;
    }
    if (command.op === 'funds') {
      if ((team.funds <= 0 && command.delta < 0) || (team.funds >= 500 && command.delta > 0)) { reject(command.op, team.id, command.delta, command.reason, '当前资金只能向合法范围改善'); continue; }
      // Legacy saves can legitimately contain debt or an over-cap balance.
      // Move those by the requested bounded delta; do not snap them to a bound.
      const bounded = team.funds >= 0 && team.funds <= 500
        ? inRequestedDirection(command.delta, -team.funds, 500 - team.funds)
        : command.delta;
      const allowed = apply('funds', bounded, SUPERNATURAL_LIMITS.funds);
      const after = round2(team.funds + allowed); const actual = round2(after - team.funds); team.funds = after;
      if (!actual) reject(command.op, team.id, command.delta, command.reason, '资金已饱和或本次额度已用尽');
      else { changed = true; log({ op: command.op, target: team.id, requested: command.delta, applied: actual, reason: command.reason, ok: true, note: actual !== command.delta ? '已按上限或边界裁剪' : '' }); }
      continue;
    }
    if (command.op === 'driver_attr') {
      const driver = state.drivers[command.driver];
      if (!driver || driver.teamId !== team.id || (driver.role !== 'race' && driver.role !== 'reserve')) { reject(command.op, command.driver, command.delta, command.reason, '目标必须是当前玩家车队车手'); continue; }
      const before = driver.attrs[command.attr]; const allowed = apply(`driver_attr:${driver.id}`, clamp(command.delta, 1 - before, 100 - before), SUPERNATURAL_LIMITS.driverAttr); const after = numeric(before, allowed, 1, 100); const actual = round1(after - before); driver.attrs[command.attr] = after;
      if (!actual) reject(command.op, driver.id, command.delta, command.reason, '属性已饱和或本次额度已用尽');
      else { changed = true; log({ op: command.op, target: `${driver.id}.${command.attr}`, requested: command.delta, applied: actual, reason: command.reason, ok: true, note: actual !== command.delta ? '已按上限或边界裁剪' : '' }); }
      continue;
    }
    if (command.op === 'staff_skill') {
      const member = Object.values(team.staff).find(staff => staff.id === command.staffId);
      if (!member) { reject(command.op, command.staffId, command.delta, command.reason, '目标必须是当前受雇员工'); continue; }
      const before = command.field === 'skill' ? member.skill : staffAbility(member, command.field);
      const allowed = apply(`staff_skill:${command.staffId}`, clamp(command.delta, 1 - before, 100 - before), SUPERNATURAL_LIMITS.staffSkill);
      const after = numeric(before, allowed, 1, 100); const actual = round1(after - before);
      if (command.field === 'skill') member.skill = after;
      else member.abilities = { ...member.abilities, [command.field]: after };
      if (!actual) reject(command.op, `${command.staffId}.${command.field}`, command.delta, command.reason, '技能已饱和或本次额度已用尽');
      else { changed = true; log({ op: command.op, target: `${command.staffId}.${command.field}`, requested: command.delta, applied: actual, reason: command.reason, ok: true, note: actual !== command.delta ? '已按上限或边界裁剪' : '' }); }
      continue;
    }
    if (command.op === 'research_progress') {
      if (!['preseason', 'pre_race', 'post_race'].includes(state.season.phase)) { reject(command.op, command.projectId, command.weeks, command.reason, '此阶段不能加速研发'); continue; }
      const project = team.projects.find(item => item.id === command.projectId && item.kind === 'design');
      if (!project || researchProject && researchProject !== project.id) { reject(command.op, command.projectId, command.weeks, command.reason, '只能推进当前车队的一项设计项目'); continue; }
      researchProject = project.id;
      const potential = Math.min(command.weeks, Math.max(0, project.weeksLeft - 1));
      const allowed = apply('research_progress', potential, SUPERNATURAL_LIMITS.researchWeeks);
      if (!allowed) { reject(command.op, project.id, command.weeks, command.reason, '项目已到最后一周，不能提前交付'); continue; }
      project.weeksLeft -= allowed; changed = true;
      log({ op: command.op, target: project.id, requested: command.weeks, applied: allowed, reason: command.reason, ok: true, note: allowed !== command.weeks ? '已按一周和最后一周边界裁剪' : '' });
      continue;
    }
    if (command.op === 'weather_tendency') {
      if ((state.season.phase !== 'preseason' && state.season.phase !== 'pre_race') || state.weekend?.roundIndex === state.season.roundIndex) { reject(command.op, '', command.delta, command.reason, '只能在进入本站周末前调整公开降雨倾向'); continue; }
      const pending = state.supernatural.pendingWeather;
      const old = pending && pending.year === state.season.year && pending.roundIndex === state.season.roundIndex ? pending.rainBias : 0;
      const allowed = apply('weather_tendency', clamp(command.delta, -SUPERNATURAL_LIMITS.weatherPending - old, SUPERNATURAL_LIMITS.weatherPending - old), SUPERNATURAL_LIMITS.weatherTendency);
      const next = round2(clamp(old + allowed, -SUPERNATURAL_LIMITS.weatherPending, SUPERNATURAL_LIMITS.weatherPending)); const actual = round2(next - old);
      if (!actual) { reject(command.op, '', command.delta, command.reason, '公开降雨倾向已饱和或本次额度已用尽'); continue; }
      state.supernatural.pendingWeather = { year: state.season.year, roundIndex: state.season.roundIndex, rainBias: next }; changed = true;
      log({ op: command.op, target: `${state.season.year}:${state.season.roundIndex}`, requested: command.delta, applied: actual, reason: command.reason, ok: true, note: actual !== command.delta ? '已按上限或边界裁剪' : '' });
      continue;
    }
    if (command.op === 'car_setup') {
      const weekend = state.weekend;
      const car = team.cars.find(item => item.driverId === command.driver);
      const natural = weekend?.setup[command.driver];
      if (!weekend || weekend.roundIndex !== state.season.roundIndex || state.season.phase === 'post_race' || state.season.phase === 'season_end' || !car || !natural) { reject(command.op, command.driver, command.delta, command.reason, '只可调整当前未完成周末中玩家赛车的调校'); continue; }
      const effect = setupEffect(state, command.driver);
      const before = effect[command.field];
      const minOffset = Math.max(-SUPERNATURAL_LIMITS.carSetupOffset, -natural[command.field]);
      const maxOffset = Math.min(SUPERNATURAL_LIMITS.carSetupOffset, 100 - natural[command.field]);
      const allowed = apply(`car_setup:${command.driver}:${command.field}`, inRequestedDirection(command.delta, minOffset - before, maxOffset - before), SUPERNATURAL_LIMITS.carSetup);
      const offset = round1(before + allowed);
      const actual = round1(offset - before);
      if (!actual) { reject(command.op, `${command.driver}.${command.field}`, command.delta, command.reason, '调校偏移已饱和或本次额度已用尽'); continue; }
      weekend.supernaturalCarEffects ??= {};
      weekend.supernaturalCarEffects[command.driver] = { ...effect, [command.field]: offset };
      changed = true; log({ op: command.op, target: `${command.driver}.${command.field}`, requested: command.delta, applied: actual, reason: command.reason, ok: true, note: actual !== command.delta ? '已按上限或边界裁剪' : '' });
    }
  }
  if (changed) for (const entry of logs) pushCapped(state.aiLog, entry, 30);
  return { logs, changed };
}
