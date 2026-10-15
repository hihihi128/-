import { addNarration, addNews, playerTeam } from './log';
import { adjustPitCrewTraining } from './pitstop';
import { Rng } from './rng';
import type { GameState, RandomEventEffect, RandomEventKind, RandomEventRecord } from './types';
import { clamp, pushCapped, round1 } from './util';

export interface RandomEventContent {
  title: string;
  prompt: string;
  answerOptions: string[];
}

export const RANDOM_EVENT_EFFECT_CAPS: Record<RandomEventEffect['op'], [number, number]> = {
  driver_fitness: [-12, 12],
  driver_morale: [-12, 12],
  funds: [-5, 5],
  project_weeks: [-2, 2],
  part_reliability: [-8, 8],
  staff_skill: [-3, 3],
  aero_hours: [-8, 8],
  affinity: [-0.1, 0.1],
};

function weightedKind(state: GameState, rng: Rng): RandomEventKind {
  const r = state.rules.randomEvents;
  const routineKinds: RandomEventKind[] = ['routine_social', 'routine_factory', 'routine_team'];
  const rows: Array<[RandomEventKind, number]> = [
    [routineKinds[rng.int(0, routineKinds.length - 1)], r.routineWeight ?? 0],
    ['driver_injury', r.driverInjuryWeight],
    ['wind_tunnel_data', r.windTunnelWeight],
    ['part_issue', r.partIssueWeight],
  ];
  let roll = rng.next() * rows.reduce((sum, row) => sum + Math.max(0, row[1]), 0);
  for (const [kind, weight] of rows) { roll -= Math.max(0, weight); if (roll <= 0) return kind; }
  return routineKinds[rng.int(0, routineKinds.length - 1)];
}

function fallbackContent(state: GameState, kind: RandomEventKind, rng: Rng): RandomEventContent {
  const team = playerTeam(state);
  if (kind === 'routine_social') {
    const people = [...team.cars.map(car => state.drivers[car.driverId ?? '']).filter(Boolean), ...Object.values(team.staff)];
    const person = people[rng.int(0, Math.max(0, people.length - 1))];
    return {
      title: `${person?.name ?? '一名工程师'}的晚餐邀请`,
      prompt: `${person?.name ?? '一名工程师'}邀请你在工作结束后一起吃饭或喝一杯。这不是危机，只是一次了解彼此近况的轻松机会。你准备如何回应？`,
      answerOptions: ['接受邀请并聊聊近况', '短暂参加后早点离开', '礼貌婉拒并另约时间'],
    };
  }
  if (kind === 'routine_factory') return {
    title: '工厂例行视察',
    prompt: `你在 ${team.base} 的工厂进行例行视察。员工希望领队看看近期的工作，也有人想借机提出小建议。你准备把注意力放在哪里？`,
    answerOptions: ['与一线员工交流', '查看研发与生产流程', '听取部门主管简报'],
  };
  if (kind === 'routine_team') return {
    title: '车队里的普通一天',
    prompt: '今天没有危机。车手、工程师和后勤人员正在处理日常工作，你有一点时间参与其中。你准备做什么？',
    answerOptions: ['加入车手和工程师的复盘', '去维修区看看准备工作', '与后勤人员简单交流'],
  };
  if (kind === 'driver_injury') {
    const drivers = team.cars.map(car => state.drivers[car.driverId ?? '']).filter(Boolean);
    const driver = drivers[rng.int(0, Math.max(0, drivers.length - 1))];
    return {
      title: '车手训练中出现身体不适',
      prompt: `${driver?.name ?? '一名正式车手'}在赛前训练后报告身体不适。医疗组、车手本人和比赛工程师对是否调整训练与比赛计划意见不一。你如何处理？`,
      answerOptions: ['立即降低训练与比赛负荷', '安排复查后再决定', '维持计划并加强监测'],
    };
  }
  if (kind === 'wind_tunnel_data') return {
    title: '风洞相关性数据出现异常',
    prompt: '空气动力部门发现风洞数据与模拟器结果不一致。继续开发可能浪费资源，全面复核又会影响项目进度。你如何安排？',
    answerOptions: ['暂停项目并全面复核', '保留项目并追加交叉验证', '采用模拟器数据继续推进'],
  };
  return {
    title: '赛车部件检查出现争议',
    prompt: '赛前检查发现一批已装车部件存在轻微异常。工程组认为可以继续使用，可靠性团队要求立即更换。你如何决定？',
    answerOptions: ['立即更换并追查供应链', '完成无损检测后决定', '继续使用并缩短检查周期'],
  };
}

export function beginRandomEventWeek(state: GameState, _rng: Rng): void {
  const key = `${state.season.number}-w${state.season.week}-r${state.season.roundIndex}`;
  state.randomEvents ??= { lastRoundKey: null, weekKey: null, weeklyQuota: 0, weeklyStarted: 0, current: null, history: [] };
  const weeklyQuota = state.rules.randomEvents.maxPerWeek === 0 ? 0 : 1;
  if (state.randomEvents.weekKey === key) {
    state.randomEvents.weeklyQuota = weeklyQuota;
    return;
  }
  closeUnansweredRandomEvent(state, '本周结束前没有完成该事件，因此没有产生额外效果。');
  state.randomEvents.weekKey = key;
  state.randomEvents.lastRoundKey = key;
  state.randomEvents.weeklyQuota = weeklyQuota;
  state.randomEvents.weeklyStarted = 0;
  state.randomEvents.current = null;
}

export function triggerNextWeeklyRandomEvent(state: GameState, rng: Rng): RandomEventRecord | null {
  beginRandomEventWeek(state, rng);
  const weekly = state.randomEvents!;
  if (weekly.weeklyStarted >= weekly.weeklyQuota) return null;
  const active = weekly.current;
  if (active && !['none', 'resolved', 'unresolved'].includes(active.status)) return null;
  const key = `${weekly.weekKey}-${weekly.weeklyStarted + 1}`;
  const kind = weightedKind(state, rng);
  const local = fallbackContent(state, kind, rng);
  const category = kind.startsWith('routine_') ? 'routine' : 'problem';
  const record: RandomEventRecord = {
    id: `random-event-${state.season.number}-w${state.season.week}-${weekly.weeklyStarted + 1}-${++state.seq}`,
    roundKey: key,
    kind,
    category,
    status: 'pending_generation',
    title: local.title,
    detail: local.prompt,
    prompt: local.prompt,
    answerOptions: local.answerOptions,
    playerAnswer: null,
    mainReply: null,
    outcomeSummary: null,
    effects: [],
    generationError: null,
    totalDialogueTurns: rng.int(state.rules.randomEvents.minDialogueTurns ?? 2, state.rules.randomEvents.maxDialogueTurns ?? 3),
    completedDialogueTurns: 0,
    dialogue: [],
  };
  weekly.weeklyStarted += 1;
  weekly.current = record;
  pushCapped(weekly.history, record, 24);
  return record;
}

/** Compatibility helper for older callers and tests. */
export function triggerWeekendRandomEvent(state: GameState, rng: Rng): void {
  beginRandomEventWeek(state, rng);
  if (state.randomEvents!.weeklyStarted === 0) triggerNextWeeklyRandomEvent(state, rng);
}

export function setRandomEventContent(state: GameState, eventId: string, content: RandomEventContent, generationError: string | null = null): boolean {
  const event = state.randomEvents?.current;
  if (!event || event.id !== eventId || event.status !== 'pending_generation') return false;
  event.title = content.title;
  event.prompt = content.prompt;
  event.detail = content.prompt;
  event.answerOptions = [...content.answerOptions];
  event.generationError = generationError;
  event.status = 'awaiting_player';
  const history = state.randomEvents?.history.find(record => record.id === eventId);
  if (history && history !== event) Object.assign(history, { ...event, answerOptions: [...event.answerOptions], effects: event.effects.map(effect => ({ ...effect })) });
  return true;
}

export function randomEventContext(state: GameState): Record<string, unknown> {
  const team = playerTeam(state);
  const staffLevel = (skill: number): string => skill >= 88 ? '顶尖' : skill >= 80 ? '资深' : skill >= 70 ? '成熟' : '尚在成长';
  const relationship = (affinity: number): string => affinity >= 70 ? '信任领队' : affinity >= 45 ? '关系正常' : '关系紧张';
  return {
    team: { id: team.id, name: team.name, funds: round1(team.funds), aeroHours: round1(team.aeroHours) },
    drivers: Object.values(state.drivers).filter(driver => driver.teamId === team.id).map(driver => ({ id: driver.id, name: driver.name, role: driver.role, fitness: round1(driver.fitness), morale: round1(driver.morale) })),
    staff: Object.values(team.staff).map(staff => ({ id: staff.id, name: staff.name, role: staff.role, experience: staffLevel(staff.skill), relationship: relationship(staff.affinity ?? 50) })),
    relationships: {
      drivers: Object.values(state.drivers).filter(driver => driver.teamId === team.id).map(driver => ({ id: driver.id, name: driver.name, affinity: round1(driver.affinity ?? 50) })),
    },
    projects: team.projects.map(project => ({ id: project.id, label: project.label, kind: project.kind, weeksLeft: project.weeksLeft })),
    parts: Object.entries(team.parts).flatMap(([partType, inventory]) => inventory.specs.map(spec => ({ id: spec.id, partType, name: state.rules.parts[partType]?.name ?? partType, reliability: round1(spec.rel) }))),
  };
}

function validateEffect(state: GameState, effect: RandomEventEffect): string | null {
  const team = playerTeam(state);
  const cap = RANDOM_EVENT_EFFECT_CAPS[effect.op];
  if (!cap || !Number.isFinite(effect.delta) || effect.delta < cap[0] || effect.delta > cap[1] || effect.delta === 0) return `效果 ${effect.op} 的数值越界`;
  if (effect.op === 'project_weeks' && !Number.isInteger(effect.delta)) return '研发周期效果必须使用整数周';
  if (!effect.reason.trim() || effect.reason.length > 160) return `效果 ${effect.op} 的原因无效`;
  if (effect.op === 'funds' || effect.op === 'aero_hours') return effect.targetId === null ? null : `效果 ${effect.op} 不接受目标 ID`;
  if (!effect.targetId) return `效果 ${effect.op} 缺少目标 ID`;
  if (effect.op === 'affinity') {
    const driver = state.drivers[effect.targetId];
    const staff = Object.values(team.staff).find(person => person.id === effect.targetId);
    return driver?.teamId === team.id || staff ? null : '好感度目标不属于玩家车队';
  }
  if (effect.op === 'driver_fitness' || effect.op === 'driver_morale') return state.drivers[effect.targetId]?.teamId === team.id ? null : '车手目标不属于玩家车队';
  if (effect.op === 'staff_skill') return Object.values(team.staff).some(staff => staff.id === effect.targetId) ? null : '员工目标不属于玩家车队';
  if (effect.op === 'project_weeks') return team.projects.some(project => project.id === effect.targetId) ? null : '研发项目目标不存在';
  if (effect.op === 'part_reliability') return Object.values(team.parts).some(inventory => inventory.specs.some(spec => spec.id === effect.targetId)) ? null : '零件目标不存在';
  return '未知随机事件效果';
}

export function applyRandomEventResolution(
  state: GameState,
  eventId: string,
  outcome: 'resolved' | 'unresolved',
  summary: string,
  effects: RandomEventEffect[],
): { ok: boolean; message: string } {
  const event = state.randomEvents?.current;
  if (!event || event.id !== eventId || !['awaiting_player', 'awaiting_narration'].includes(event.status)) return { ok: false, message: '随机事件已经变化或完成' };
  if (!summary.trim() || summary.length > 500) return { ok: false, message: '随机事件结论无效' };
  if (effects.length > 3) return { ok: false, message: '随机事件最多应用三个效果' };
  if (event.category === 'routine' && (effects.length > 1 || effects.some(effect => effect.op !== 'affinity'))) {
    return { ok: false, message: '日常事件最多只能应用一项好感度效果' };
  }
  if (event.category === 'routine' && effects.some(effect => Math.abs(effect.delta) < 0.05 || Math.abs(effect.delta) > 0.1)) {
    return { ok: false, message: '日常事件好感度变化必须在 0.05–0.1 之间' };
  }
  const totals = new Map<string, number>();
  for (const effect of effects) {
    const key = `${effect.op}:${effect.targetId ?? ''}`;
    totals.set(key, (totals.get(key) ?? 0) + effect.delta);
  }
  for (const [key, delta] of totals) {
    const op = key.slice(0, key.indexOf(':')) as RandomEventEffect['op'];
    const cap = RANDOM_EVENT_EFFECT_CAPS[op];
    if (!cap || delta < cap[0] || delta > cap[1]) return { ok: false, message: `效果 ${op} 的累计数值越界` };
  }
  for (const effect of effects) {
    const error = validateEffect(state, effect);
    if (error) return { ok: false, message: error };
  }
  const team = playerTeam(state);
  for (const effect of effects) {
    if (effect.op === 'funds') team.funds = round1(Math.max(0, team.funds + effect.delta));
    else if (effect.op === 'aero_hours') team.aeroHours = round1(Math.max(0, team.aeroHours + effect.delta));
    else if (effect.op === 'driver_fitness') {
      const driver = state.drivers[effect.targetId!];
      driver.fitness = round1(clamp(driver.fitness + effect.delta, 0, 100));
    } else if (effect.op === 'driver_morale') {
      const driver = state.drivers[effect.targetId!];
      driver.morale = round1(clamp(driver.morale + effect.delta, 0, 100));
    } else if (effect.op === 'staff_skill') {
      const staff = Object.values(team.staff).find(value => value.id === effect.targetId)!;
      const before = staff.skill;
      staff.skill = round1(clamp(staff.skill + effect.delta, 1, 99));
      if (staff.role === 'pitCrew') adjustPitCrewTraining(team, staff.skill - before);
    } else if (effect.op === 'project_weeks') {
      const project = team.projects.find(value => value.id === effect.targetId)!;
      const delta = Math.trunc(effect.delta);
      if (delta > 0) {
        project.weeksLeft += delta;
        project.weeksTotal += delta;
      } else project.weeksLeft = Math.max(1, project.weeksLeft + delta);
    } else if (effect.op === 'part_reliability') {
      const spec = Object.values(team.parts).flatMap(inventory => inventory.specs).find(value => value.id === effect.targetId)!;
      spec.rel = round1(clamp(spec.rel + effect.delta, 1, 100));
    } else if (effect.op === 'affinity') {
      const driver = state.drivers[effect.targetId!];
      if (driver?.teamId === team.id) driver.affinity = Math.round(clamp((driver.affinity ?? 50) + effect.delta, 0, 100) * 100) / 100;
      else {
        const staff = Object.values(team.staff).find(person => person.id === effect.targetId)!;
        staff.affinity = Math.round(clamp((staff.affinity ?? 50) + effect.delta, 0, 100) * 100) / 100;
      }
    }
  }
  event.status = outcome;
  event.outcomeSummary = summary.trim();
  event.effects = effects.map(effect => ({ ...effect, reason: effect.reason.trim() }));
  event.detail = summary.trim();
  const history = state.randomEvents?.history.find(record => record.id === eventId);
  if (history && history !== event) Object.assign(history, { ...event, answerOptions: [...event.answerOptions], effects: event.effects.map(effect => ({ ...effect })) });
  addNews(state, outcome === 'resolved' ? '随机事件已解决' : '随机事件未解决', event.detail);
  addNarration(state, 'random_event', event.title, `${event.prompt} ${event.detail}`);
  return { ok: true, message: event.detail };
}

/** Close non-blocking fallback events before the game leaves their round. */
export function closeUnansweredRandomEvent(state: GameState, summary = '本站结束前未处理该事件，因此没有产生额外效果。'): void {
  const event = state.randomEvents?.current;
  if (!event || !['awaiting_player', 'awaiting_narration'].includes(event.status)) return;
  applyRandomEventResolution(state, event.id, 'unresolved', summary, []);
}
