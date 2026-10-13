import { addNarration, addNews, playerTeam } from './log';
import { Rng } from './rng';
import type { GameState, RandomEventEffect, RandomEventKind, RandomEventRecord } from './types';
import { clamp, pushCapped, round1 } from './util';

export interface RandomEventContent {
  title: string;
  prompt: string;
  answerOptions: string[];
}

const EFFECT_CAPS: Record<RandomEventEffect['op'], [number, number]> = {
  driver_fitness: [-12, 12],
  driver_morale: [-12, 12],
  funds: [-5, 5],
  project_weeks: [-2, 2],
  part_reliability: [-8, 8],
  staff_skill: [-3, 3],
  aero_hours: [-8, 8],
};

function weightedKind(state: GameState, rng: Rng): RandomEventKind {
  const r = state.rules.randomEvents;
  const rows: Array<[RandomEventKind, number]> = [['none', r.noneWeight], ['driver_injury', r.driverInjuryWeight], ['wind_tunnel_data', r.windTunnelWeight], ['part_issue', r.partIssueWeight]];
  let roll = rng.next() * rows.reduce((sum, row) => sum + Math.max(0, row[1]), 0);
  for (const [kind, weight] of rows) { roll -= Math.max(0, weight); if (roll <= 0) return kind; }
  return 'none';
}

function fallbackContent(state: GameState, kind: RandomEventKind, rng: Rng): RandomEventContent {
  const team = playerTeam(state);
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

export function triggerWeekendRandomEvent(state: GameState, rng: Rng): void {
  const key = `${state.season.number}-${state.season.roundIndex}`;
  state.randomEvents ??= { lastRoundKey: null, current: null, history: [] };
  if (state.randomEvents.lastRoundKey === key) return;
  const kind = weightedKind(state, rng);
  const local = kind === 'none'
    ? { title: '平静的比赛周', prompt: '本周没有发生需要领队处理的额外事件。', answerOptions: [] }
    : fallbackContent(state, kind, rng);
  const record: RandomEventRecord = {
    id: `random-event-${state.season.number}-${state.season.roundIndex}-${++state.seq}`,
    roundKey: key,
    kind,
    status: kind === 'none' ? 'none' : 'pending_generation',
    title: local.title,
    detail: local.prompt,
    prompt: local.prompt,
    answerOptions: local.answerOptions,
    playerAnswer: null,
    mainReply: null,
    outcomeSummary: null,
    effects: [],
    generationError: null,
  };
  state.randomEvents.lastRoundKey = key;
  state.randomEvents.current = record;
  pushCapped(state.randomEvents.history, record, 12);
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
  return true;
}

export function randomEventContext(state: GameState): Record<string, unknown> {
  const team = playerTeam(state);
  return {
    team: { id: team.id, name: team.name, funds: round1(team.funds), aeroHours: round1(team.aeroHours) },
    drivers: Object.values(state.drivers).filter(driver => driver.teamId === team.id).map(driver => ({ id: driver.id, name: driver.name, role: driver.role, fitness: round1(driver.fitness), morale: round1(driver.morale) })),
    staff: Object.values(team.staff).map(staff => ({ id: staff.id, name: staff.name, role: staff.role, skill: round1(staff.skill) })),
    projects: team.projects.map(project => ({ id: project.id, label: project.label, kind: project.kind, weeksLeft: project.weeksLeft })),
    parts: Object.entries(team.parts).flatMap(([partType, inventory]) => inventory.specs.map(spec => ({ id: spec.id, partType, name: state.rules.parts[partType]?.name ?? partType, reliability: round1(spec.rel) }))),
  };
}

function validateEffect(state: GameState, effect: RandomEventEffect): string | null {
  const team = playerTeam(state);
  const cap = EFFECT_CAPS[effect.op];
  if (!cap || !Number.isFinite(effect.delta) || effect.delta < cap[0] || effect.delta > cap[1] || effect.delta === 0) return `效果 ${effect.op} 的数值越界`;
  if (!effect.reason.trim() || effect.reason.length > 160) return `效果 ${effect.op} 的原因无效`;
  if (effect.op === 'funds' || effect.op === 'aero_hours') return effect.targetId === null ? null : `效果 ${effect.op} 不接受目标 ID`;
  if (!effect.targetId) return `效果 ${effect.op} 缺少目标 ID`;
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
  if (!event || event.id !== eventId || event.status !== 'awaiting_player') return { ok: false, message: '随机事件已经变化或完成' };
  if (!summary.trim() || summary.length > 500) return { ok: false, message: '随机事件结论无效' };
  if (effects.length > 3) return { ok: false, message: '随机事件最多应用三个效果' };
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
      staff.skill = round1(clamp(staff.skill + effect.delta, 1, 99));
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
    }
  }
  event.status = outcome;
  event.outcomeSummary = summary.trim();
  event.effects = effects.map(effect => ({ ...effect, reason: effect.reason.trim() }));
  event.detail = summary.trim();
  addNews(state, outcome === 'resolved' ? '随机事件已解决' : '随机事件未解决', event.detail);
  addNarration(state, 'random_event', event.title, `${event.prompt} ${event.detail}`);
  return { ok: true, message: event.detail };
}
