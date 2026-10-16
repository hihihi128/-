/**
 * 动作分发：前端/适配层修改存档的唯一入口。
 *
 * dispatch 是纯函数：输入旧存档，返回新存档（深拷贝），失败时返回原存档与错误原因。
 */
import { DEFAULT_PLAN, DRIVER_ATTRS, FACILITIES, LABELS } from './defaults';
import {
  cancelProject,
  fitPart,
  orderUnits,
  startDriverTraining,
  startPitTraining,
  startProject,
  upgradeFacility,
  type Outcome,
} from './development';
import { ferrariOnPriority } from './ferrari';
import { teammateRelationship, willDisobeyStrategy } from './driverBehavior';
import { dismissalReason, mercedesPolitics, retainGp, startMcLarenFix } from './teamSpecials';
import { astonCrisis, astonOnPriority, audiAlliance, fiaDebate, selectRacingBullsReserve, specialDecisionBlocker } from './nextTeamSpecials';
import { alpineManagement, alpineOnPriority, haasBalance, managementActionBlocker, recordManagementInvestment, williamsBudgetFocus } from './managementSpecials';
import { addNews, driverName } from './log';
import { offerDriverContract, offerStaffContract, releasePerson } from './market';
import { resolveAiMarket } from './market-ai';
import { Rng } from './rng';
import {
  advanceCalendarWeek,
  doPractice,
  doQualifying,
  doRace,
  finishRound,
  nextActionFor,
  startNextSeason,
  startSeason,
  startWeekend,
  startLiveRace,
  advanceLiveRace,
  pauseLiveRace,
  resolveLiveRaceDecision,
  returnPracticeTyres,
  swapDriver,
} from './season';
import { validatePlan } from './strategy';
import { completedPracticeSessions, practiceSessionCount } from './weekend';
import { ENERGY_MODES, PACE_MODES, PIT_TIMINGS, validOrders } from './raceDecisions';
import type { Action, ActionResult, DriverPlan, GameState, StrategyReviewMetadata } from './types';
import { clamp, deepClone, hashString, round1 } from './util';

export interface DispatchOptions {
  now?: number;
}

const ok = (message: string): Outcome => ({ ok: true, message });
const fail = (message: string): Outcome => ({ ok: false, message });

const PROGRAMS = ['setup', 'longrun', 'quali_sim', 'parts'];
const SETUP_FOCUSES = ['balanced', 'aero_balance', 'mechanical', 'ride_height', 'tyre_prep'];
const APPROACHES = ['safe', 'standard', 'aggressive'];
const PACE = ['conserve', 'balanced', 'push'];
const TIMING = ['early', 'standard', 'late'];
const REVIEW_CODES = ['legality', 'tyre_life', 'temperature', 'track_fit', 'pace', 'pit_window', 'weather', 'other'];
const REVIEW_CAPABILITY = Symbol('strategy-review');

export interface InternalReviewedPlanAction {
  type: 'APPLY_STRATEGY_REVIEW';
  driverId: string;
  plan: Partial<DriverPlan>;
  review: StrategyReviewMetadata;
  capability: typeof REVIEW_CAPABILITY;
}

/** Only the controller can create an action carrying this private capability. */
export function createReviewedPlanAction(driverId: string, plan: Partial<DriverPlan>, review: StrategyReviewMetadata): InternalReviewedPlanAction {
  return { type: 'APPLY_STRATEGY_REVIEW', driverId, plan, review, capability: REVIEW_CAPABILITY };
}

function validReviewMetadata(review: StrategyReviewMetadata, rules: GameState['rules']): boolean {
  return review.source === 'secondary'
    && Array.isArray(review.originalPlan.tyrePlan)
    && review.originalPlan.tyrePlan.length >= 2 && review.originalPlan.tyrePlan.length <= 5
    && !validatePlan(rules, review.originalPlan.tyrePlan, false)
    && PACE.includes(review.originalPlan.paceMode)
    && TIMING.includes(review.originalPlan.pitTiming)
    && typeof review.originalPlan.scReaction === 'boolean'
    && typeof review.summary === 'string' && review.summary.trim().length > 0 && review.summary.length <= 800
    && typeof review.modelLabel === 'string' && review.modelLabel.length > 0 && review.modelLabel.length <= 64
    && typeof review.roundKey === 'string' && /^\d{4}:r\d{1,2}$/.test(review.roundKey)
    && Array.isArray(review.issues) && review.issues.length <= 8
    && review.issues.every(issue => typeof issue.code === 'string' && REVIEW_CODES.includes(issue.code)
      && ['low', 'medium', 'high'].includes(issue.severity)
      && typeof issue.message === 'string' && issue.message.trim().length > 0 && issue.message.length <= 400);
}

function setPlan(state: GameState, driverId: string, patch: Partial<DriverPlan>, trustedReview?: StrategyReviewMetadata): Outcome {
  if (state.weekend?.liveRace) return fail('比赛进行中，请使用实时策略指令');
  const team = state.teams[state.meta.playerTeamId];
  if (!team.cars.some(c => c.driverId === driverId)) return fail('只能为本队正式车手设置策略');
  if (!state.weekend) return fail('比赛周末开始后才能设置本站策略');
  const plan = state.weekend.plans[driverId] ?? deepClone(DEFAULT_PLAN);
  const rules = state.rules;
  if (patch.strategySource !== undefined) {
    if (patch.strategySource !== 'player' && patch.strategySource !== 'engineer' && patch.strategySource !== 'perfect') return fail('未知策略来源');
    plan.strategySource = patch.strategySource;
  }
  if (patch.practiceProgram !== undefined) {
    if (!PROGRAMS.includes(patch.practiceProgram)) return fail('未知练习赛项目');
    if (state.season.phase !== 'practice' || completedPracticeSessions(state.weekend).length >= practiceSessionCount(state)) return fail('练习赛已经结束');
    plan.practiceProgram = patch.practiceProgram;
  }
  if (patch.practiceTyre !== undefined) {
    if (state.season.phase !== 'practice' || completedPracticeSessions(state.weekend).length >= practiceSessionCount(state)) return fail('练习赛已经结束');
    if (patch.practiceTyre !== 'auto' && !rules.tyres[patch.practiceTyre]) return fail('未知练习赛轮胎');
    if (patch.practiceTyre !== 'auto' && rules.tyres[patch.practiceTyre].wet && state.weekend.weather.practice !== 'wet') return fail('赛道未宣布为湿地，练习赛不能使用半雨胎或全雨胎');
    plan.practiceTyre = patch.practiceTyre;
  }
  if (patch.practiceSetupFocus !== undefined) {
    if (!SETUP_FOCUSES.includes(patch.practiceSetupFocus)) return fail('未知练习赛调校方向');
    if (state.season.phase !== 'practice' || completedPracticeSessions(state.weekend).length >= practiceSessionCount(state)) return fail('练习赛已经结束');
    plan.practiceSetupFocus = patch.practiceSetupFocus;
  }
  if (patch.qualiApproach !== undefined) {
    if (!APPROACHES.includes(patch.qualiApproach)) return fail('未知排位方案');
    plan.qualiApproach = patch.qualiApproach;
  }
  if (patch.paceMode !== undefined) {
    if (!PACE.includes(patch.paceMode)) return fail('未知驾驶模式');
    plan.paceMode = patch.paceMode;
  }
  if (patch.pitTiming !== undefined) {
    if (!TIMING.includes(patch.pitTiming)) return fail('未知进站时机');
    plan.pitTiming = patch.pitTiming;
  }
  if (patch.scReaction !== undefined) plan.scReaction = !!patch.scReaction;
  if (patch.tyrePlan !== undefined) {
    if (patch.tyrePlan === 'auto') plan.tyrePlan = 'auto';
    else if (Array.isArray(patch.tyrePlan)) {
      const err = validatePlan(rules, patch.tyrePlan, false);
      if (err) return fail(err);
      plan.tyrePlan = [...patch.tyrePlan];
    } else return fail('轮胎策略格式错误');
  }
  if (patch.sprintTyre !== undefined) {
    if (patch.sprintTyre !== 'auto' && (!rules.tyres[patch.sprintTyre] || rules.tyres[patch.sprintTyre].wet)) return fail('冲刺赛配方无效');
    plan.sprintTyre = patch.sprintTyre;
  }
  const changesRaceStrategy = patch.strategySource !== undefined || patch.tyrePlan !== undefined || patch.paceMode !== undefined || patch.pitTiming !== undefined || patch.scReaction !== undefined;
  if (patch.strategyReview !== undefined) return fail('策略点评来源只能由受控点评流程写入');
  if (trustedReview !== undefined) {
    const review = trustedReview;
    if (!validReviewMetadata(review, rules)) return fail('策略点评来源信息无效');
    plan.strategyReview = {
      source: 'secondary',
      originalPlan: {
        tyrePlan: [...review.originalPlan.tyrePlan],
        paceMode: review.originalPlan.paceMode,
        pitTiming: review.originalPlan.pitTiming,
        scReaction: review.originalPlan.scReaction,
      },
      summary: review.summary,
      issues: review.issues.map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message })),
      modelLabel: review.modelLabel,
      roundKey: review.roundKey,
    };
  } else if (changesRaceStrategy) {
    // A player/engineer/perfect replacement is newer than any prior review.
    delete plan.strategyReview;
  }
  state.weekend.plans[driverId] = plan;
  return ok(`已更新 ${driverName(state, driverId)} 的策略`);
}

function setPriority(state: GameState, driverId: string | null): Outcome {
  const team = state.teams[state.meta.playerTeamId];
  if (driverId !== null && state.drivers[driverId]?.teamId !== team.id) return fail('只能指定本队车手');
  if (team.driverPriority === driverId) return ok('优先车手没有变化');
  const key = `${state.season.number}-w${state.season.week}`;
  if (state.flags.priorityChanged === key) return fail('每周只能调整一次优先车手');
  state.flags.priorityChanged = key;
  team.driverPriority = driverId;
  const mates = Object.values(state.drivers).filter(d => d.teamId === team.id);
  for (const d of mates) {
    if (driverId === null) {
      d.morale = round1(clamp(d.morale + 1, 0, 100));
    } else if (d.id === driverId) {
      d.morale = round1(clamp(d.morale + 3, 0, 100));
      d.trust = round1(clamp(d.trust + 2, 0, 100));
    } else {
      d.morale = round1(clamp(d.morale - (2 + d.ego / 25), 0, 100));
      d.trust = round1(clamp(d.trust - (1 + d.ego / 30), 0, 100));
    }
  }
  const msg = driverId ? `${driverName(state, driverId)} 被确立为车队优先车手` : '车队取消了优先车手，两位车手平等对待';
  addNews(state, '车队', `${msg}。`);
  ferrariOnPriority(state, driverId);
  astonOnPriority(state, driverId);
  alpineOnPriority(state, driverId);
  return ok(msg);
}

function setTeamOrders(state: GameState, mode: string, favor: string | null): Outcome {
  if (state.weekend?.liveRace) return fail('比赛进行中，请使用实时策略指令');
  if (!state.weekend) return fail('比赛周末开始后才能下达车队指令');
  const team = state.teams[state.meta.playerTeamId];
  if (mode !== 'free' && mode !== 'hold' && mode !== 'favor') return fail('未知车队指令');
  if (mode === 'favor' && (!favor || !team.cars.some(c => c.driverId === favor))) return fail('请选择要偏向的本队车手');
  state.weekend.teamOrders = { mode, favorDriverId: mode === 'favor' ? favor : null };
  const label = mode === 'favor' ? `偏向 ${driverName(state, favor)}` : LABELS.orders[mode];
  return ok(`车队指令：${label}`);
}

/** 法拉利撤职后仍允许的操作（只读 / 清理） */
const ALLOWED_AFTER_DISMISSAL = new Set(['CLEAR_NARRATION']);

function run(state: GameState, action: Action | InternalReviewedPlanAction, rng: Rng, depth = 0): Outcome {
  const tid = state.meta.playerTeamId;
  const dismissed = dismissalReason(state);
  if (dismissed && !ALLOWED_AFTER_DISMISSAL.has(action?.type)) {
    return fail(`你已被解除领队职务（${dismissed}），本局结束。请在「存档」中读档或开始新游戏。`);
  }
  const specialBlocker = specialDecisionBlocker(state, action?.type);
  if (specialBlocker) return fail(specialBlocker);
  const managementBlocker = managementActionBlocker(state, action as Action);
  if (managementBlocker) return fail(managementBlocker);
  switch (action.type) {
    case 'ADVANCE': {
      const next = nextActionFor(state);
      if (!next || depth > 0) return fail('没有可推进的步骤');
      const nextAction = next.action.type === 'RUN_RACE' && action.aiPlans
        ? { ...next.action, aiPlans: action.aiPlans }
        : next.action;
      return run(state, nextAction, rng, depth + 1);
    }
    case 'START_SEASON':
      return startSeason(state, rng);
    case 'ADVANCE_WEEK':
      return advanceCalendarWeek(state, rng);
    case 'START_WEEKEND':
      return startWeekend(state, rng);
    case 'RUN_PRACTICE':
      return doPractice(state, rng);
    case 'RETURN_PRACTICE_TYRES':
      return returnPracticeTyres(state, action.driverId, action.setIds);
    case 'RUN_SPRINT_QUALIFYING':
      return doQualifying(state, rng, 'sprint_qualifying');
    case 'RUN_SPRINT':
      return doRace(state, rng, 'sprint');
    case 'RUN_QUALIFYING':
      return doQualifying(state, rng, 'qualifying');
    case 'RUN_RACE':
      return doRace(state, rng, 'race', action.aiPlans);
    case 'START_RACE':
      return startLiveRace(state, rng, action.kind, action.aiPlans);
    case 'ADVANCE_RACE':
      return advanceLiveRace(state, rng, action.sessionId, action.expectedRevision, action.until);
    case 'PAUSE_RACE':
      return pauseLiveRace(state, action.sessionId, action.expectedRevision);
    case 'SET_RACE_TACTICS': {
      const live = state.weekend?.liveRace;
      if (!live || live.id !== action.sessionId || live.revision !== action.expectedRevision || live.pendingDecision) return fail('比赛状态已更新，请刷新后重试');
      const ids = new Set<string>();
      for (const patch of action.drivers) {
        const car = live.cars[patch.driverId];
        if (!car || !car.player || car.status !== 'running' || ids.has(patch.driverId)) return fail('实时策略包含无效车手');
        ids.add(patch.driverId);
        if (patch.paceMode && !PACE_MODES.includes(patch.paceMode)) return fail('未知驾驶模式');
        if (patch.energyMode && !ENERGY_MODES.includes(patch.energyMode)) return fail('未知能量模式');
        if (patch.pitTiming && !PIT_TIMINGS.includes(patch.pitTiming)) return fail('未知进站时机');
      }
      const relationship = teammateRelationship(state, state.meta.playerTeamId);
      const refused = new Set<string>();
      for (const patch of action.drivers) {
        const car = live.cars[patch.driverId];
        const changed = (patch.paceMode !== undefined && patch.paceMode !== car.plan.paceMode) || (patch.energyMode !== undefined && patch.energyMode !== car.energyMode) || (patch.pitTiming !== undefined && patch.pitTiming !== car.plan.pitTiming);
        const driver = state.drivers[patch.driverId];
        if (changed && driver && willDisobeyStrategy(driver, relationship, `${live.id}:tactics:lap-${live.lap}:${driver.id}`)) refused.add(driver.id);
      }
      if (action.orders) { if (!validOrders(action.orders, Object.values(live.cars).filter(c => c.player && c.status === 'running').map(c => c.driverId))) return fail('无效车队指令'); live.teamOrders = { ...action.orders }; }
      for (const patch of action.drivers) {
        const car = live.cars[patch.driverId];
        if (refused.has(patch.driverId)) {
          live.events.push({ id: `${live.id}:e${live.events.length + 1}`, lap: live.lap, type: 'order', text: `${patch.driverId} 拒绝实时策略调整`, drivers: [patch.driverId], key: true });
          continue;
        }
        if (patch.paceMode) car.plan.paceMode = patch.paceMode;
        if (patch.energyMode) car.energyMode = patch.energyMode;
        if (patch.pitTiming) car.plan.pitTiming = patch.pitTiming;
      }
      live.revision++;
      return ok(refused.size ? `${[...refused].map(id => driverName(state, id)).join('、')} 拒绝调整，其余实时策略将从下一圈生效` : '实时策略已更新，将从下一圈生效');
    }
    case 'RESOLVE_RACE_DECISION':
      return resolveLiveRaceDecision(state, rng, action.sessionId, action.expectedRevision, action.windowId, action.drivers, action.orders);
    case 'FINISH_ROUND':
      return finishRound(state, rng);
    case 'START_NEXT_SEASON':
      return startNextSeason(state, rng);
    case 'OFFER_DRIVER_CONTRACT':
      return offerDriverContract(state, tid, {
        windowId: action.windowId,
        marketRevision: action.marketRevision,
        personId: action.driverId,
        annualSalary: action.annualSalary,
        years: action.years,
        role: action.role,
        slot: action.slot,
        replacePersonId: action.replaceDriverId,
      });
    case 'OFFER_STAFF_CONTRACT':
      return offerStaffContract(state, tid, {
        windowId: action.windowId,
        marketRevision: action.marketRevision,
        personId: action.candidateId,
        annualSalary: action.annualSalary,
        years: action.years,
        replacePersonId: action.replaceStaffId,
      }, action.role);
    case 'RELEASE_PERSON':
      return releasePerson(state, tid, action.windowId, action.marketRevision, action.personKind, action.personId);
    case 'RESOLVE_AI_MARKET': {
      const market = state.market;
      if (!market?.window || market.window.id !== action.windowId || market.revision !== action.marketRevision) return fail('市场状态已更新，请刷新');
      return resolveAiMarket(state, tid);
    }
    case 'SET_PLAN':
      return setPlan(state, action.driverId, action.plan ?? {});
    case 'APPLY_STRATEGY_REVIEW':
      if (action.capability !== REVIEW_CAPABILITY) return fail('策略点评来源只能由受控点评流程写入');
      return setPlan(state, action.driverId, action.plan, action.review);
    case 'SET_TEAM_ORDERS':
      return setTeamOrders(state, action.orders?.mode, action.orders?.favorDriverId ?? null);
    case 'SET_PRIORITY':
      return setPriority(state, action.driverId ?? null);
    case 'START_PROJECT': {
      const result = startProject(state, tid, action.partType, action.ambition, !!action.rush, rng);
      recordManagementInvestment(state, action, result.ok);
      return result;
    }
    case 'CANCEL_PROJECT':
      return cancelProject(state, tid, action.projectId);
    case 'ORDER_UNITS':
      return orderUnits(state, tid, action.partType, action.specId, action.qty);
    case 'FIT_PART':
      return fitPart(state, tid, action.slot, action.partType, action.specId);
    case 'UPGRADE_FACILITY': {
      if (!FACILITIES.includes(action.facility)) return fail('未知设施');
      const result = upgradeFacility(state, tid, action.facility);
      recordManagementInvestment(state, action, result.ok);
      return result;
    }
    case 'TRAIN_PIT_CREW':
      return startPitTraining(state, tid, action.focus);
    case 'TRAIN_DRIVER':
      if (!DRIVER_ATTRS.includes(action.attr)) return fail('未知能力项');
      return startDriverTraining(state, tid, action.driverId, action.attr);
    case 'SET_NEXT_SEASON_FOCUS': {
      const v = Math.round(clamp(Number(action.value) || 0, 0, 100));
      state.teams[tid].nextSeasonFocus = v;
      return ok(`下赛季研发投入比例设为 ${v}%`);
    }
    case 'START_MCLAREN_FIX':
      if (action.route !== 'independent' && action.route !== 'mercedes') return fail('未知的软件适配路线');
      return startMcLarenFix(state, action.route);
    case 'MERCEDES_POLITICS':
      if (!['lobby_aduo', 'defend', 'compromise'].includes(action.strategy)) return fail('未知的政治行动');
      return mercedesPolitics(state, action.strategy);
    case 'RED_BULL_RETAIN_GP':
      return retainGp(state);
    case 'ASTON_CRISIS':
      if (!['pressure_honda', 'mediate', 'push_newey'].includes(action.strategy)) return fail('未知的阿斯顿·马丁危机行动');
      return astonCrisis(state, action.strategy);
    case 'RACING_BULLS_SELECT_RESERVE':
      return selectRacingBullsReserve(state, action.driverId);
    case 'AUDI_ALLIANCE':
      return audiAlliance(state);
    case 'ALPINE_MANAGEMENT':
      if (!['back_colapinto', 'reassure_gasly', 'integrate_power_unit'].includes(action.strategy)) return fail('未知的阿尔派管理行动');
      return alpineManagement(state, action.strategy);
    case 'HAAS_BALANCE':
      if (!['protect_independence', 'accept_toyota', 'compromise'].includes(action.strategy)) return fail('未知的哈斯股东行动');
      return haasBalance(state, action.strategy);
    case 'WILLIAMS_BUDGET_FOCUS':
      if (!['facilities', 'development', 'reserve'].includes(action.focus)) return fail('未知的威廉姆斯预算方向');
      return williamsBudgetFocus(state, action.focus);
    case 'FIA_DEBATE':
      if (!['support', 'oppose', 'compromise'].includes(action.stance)) return fail('未知的 FIA 辩论立场');
      return fiaDebate(state, action.stance);
    case 'SWAP_DRIVER':
      return swapDriver(state, tid, action.slot, action.driverId);
    case 'CLEAR_NARRATION':
      state.narration = [];
      return ok('已清空待叙述事件');
    default:
      return fail(`未知动作「${(action as { type?: string }).type ?? ''}」`);
  }
}

/** 会产生随机结果的动作（用于「每次重新随机」模式） */
const RANDOM_ACTIONS = new Set(['ADVANCE', 'START_SEASON', 'ADVANCE_WEEK', 'START_WEEKEND', 'RUN_PRACTICE', 'RUN_SPRINT_QUALIFYING', 'RUN_SPRINT', 'RUN_QUALIFYING', 'RUN_RACE', 'START_RACE', 'FINISH_ROUND', 'START_NEXT_SEASON', 'START_PROJECT']);

export function dispatch(input: GameState, action: Action | InternalReviewedPlanAction, opts: DispatchOptions = {}): ActionResult {
  const state = deepClone(input);
  let seed = state.rng;
  // An in-progress race owns its persisted RNG stream. Fresh randomness applies
  // only when launching it, never when resuming or auto-finishing a checkpoint.
  const resumesLiveRace = !!state.weekend?.liveRace && (action.type === 'RUN_RACE' || action.type === 'RUN_SPRINT');
  if (state.meta.randomness === 'fresh' && RANDOM_ACTIONS.has(action?.type) && !resumesLiveRace) {
    seed = (seed ^ parseInt(hashString(String(opts.now ?? Date.now())), 16)) >>> 0;
  }
  const rng = new Rng(seed);
  let out: Outcome;
  try {
    out = run(state, action, rng);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, state: input, message: `内部错误：${msg}`, error: msg };
  }
  if (!out.ok) return { ok: false, state: input, message: out.message, error: out.message };
  state.rng = rng.state;
  return { ok: true, state, message: out.message };
}
