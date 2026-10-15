/**
 * 研发、生产、设施、训练，以及升级件分配。
 *
 * 研发流程（玩家与 AI 车队使用同一套规则）：
 *   1. 选择零件 + 野心（保守/标准/激进）+ 是否加急 → 预览花费、周期、风洞时长、预期收益区间。
 *   2. 开工时扣款、扣风洞时长，并在后台抽取「真实收益」（玩家看不到）。
 *   3. 每过一周进度 -1，完工后生成新规格（v2、v3…），按野心交付 1~2 件进入库存。
 *   4. 领队决定把新件装到哪台车上（升级件分配）；不平均的分配会影响车手心态与信任。
 *   5. 新件在练习赛「新件测试」或正赛后才会验证真实性能。
 */
import { aduoWeeksMul, homologateUpgradePackage, homologationsLeft, isAduoPart, puDesignBlock, puFitBlock, supplyCustomers } from './aduo';
import { AMBITIONS, LABELS, TRACK_DEMANDS } from './defaults';
import { affordError, capRemaining, charge, income, payWeeklySalaries } from './finance';
import { addNews, addNarration, driverName } from './log';
import { managementActionBlocker } from './managementSpecials';
import { recordPuFit } from './powerunit';
import { advanceAiTeamSpecial, advanceSpecialWeeks } from './teamSpecials';
import { advanceAiNextTeamSpecial } from './nextTeamSpecials';
import { advanceAiManagementSpecial } from './managementSpecials';
import { bestDisclosedPerf, bestSpec, carRatings, disclosedPerf, driverOverall, findSpec } from './ratings';
import type { Rng } from './rng';
import type {
  Ambition,
  CarAttr,
  DriverAttr,
  FacilityType,
  GameState,
  PartSpec,
  PartType,
  PitCrewFocus,
  Project,
  Rules,
  TeamState,
  TrackDemand,
} from './types';
import { clamp, nextId, round1, round2, stamp } from './util';

export interface Outcome {
  ok: boolean;
  message: string;
}

const ok = (message: string): Outcome => ({ ok: true, message });
const fail = (message: string): Outcome => ({ ok: false, message });

// ───────────────────────────── 基础量 ─────────────────────────────

/** 按车队排名（0 = 第一名）计算一个比赛间隔的风洞时长 */
export function aeroAllowance(rules: Rules, positionIndex: number): number {
  const table = rules.aeroAllowanceByPosition;
  const idx = clamp(positionIndex, 0, Math.max(0, table.length - 1));
  const mul = table.length ? table[idx] : 1;
  return Math.round(rules.aeroAllowanceBase * mul);
}

export function rndSlots(team: TeamState, rules: Rules): number {
  return rules.rndSlotsBase + Math.floor((team.facilities.factory - 1) / 2);
}

const difficultyMul = (state: GameState, team: TeamState): number => {
  if (team.isPlayer) return 1;
  return state.meta.difficulty === 'easy' ? 0.85 : state.meta.difficulty === 'hard' ? 1.15 : 1;
};

function staffFactor(team: TeamState, aero: boolean): number {
  const td = team.staff.technicalDirector.skill;
  const ac = team.staff.aeroChief.skill;
  const moraleMod = 0.9 + (team.staffMorale / 100) * 0.2;
  return (aero ? 0.55 + td * 0.0025 + ac * 0.0035 : 0.6 + td * 0.004) * moraleMod;
}

function facilityGainFactor(team: TeamState, aero: boolean): number {
  const f = team.facilities;
  return aero ? 0.85 + (f.windTunnel + f.cfd) * 0.03 : 0.9 + f.factory * 0.02;
}

function facilitySpreadFactor(team: TeamState, aero: boolean): number {
  const f = team.facilities;
  return aero ? 1.25 - (f.windTunnel + f.cfd) * 0.05 : 1.1 - f.factory * 0.04;
}

function speedFactor(team: TeamState, aero: boolean): number {
  const f = team.facilities;
  return 0.8 + f.factory * 0.06 + (aero ? f.cfd * 0.04 : 0);
}

function headroom(rules: Rules, best: number): number {
  return clamp((rules.partCap - best) / 30, 0.2, 1.4);
}

// ───────────────────────────── 设计项目 ─────────────────────────────

export interface ProjectPreview {
  ok: boolean;
  blockers: string[];
  partType: PartType;
  partName: string;
  ambition: Ambition;
  ambitionName: string;
  rush: boolean;
  cost: number;
  weeks: number;
  aeroHours: number;
  /** 预期性能提升区间（零件性能点） */
  gain: [number, number];
  /** 当前最好规格的性能 */
  currentBest: number;
  relDelta: number;
  units: number;
}

export function previewProject(
  state: GameState,
  teamId: string,
  partType: PartType,
  ambition: Ambition,
  rush = false,
): ProjectPreview {
  const team = state.teams[teamId];
  const rules = state.rules;
  const def = rules.parts[partType];
  const amb = rules.ambition[ambition];
  const blockers: string[] = [];
  if (!team) throw new Error(`找不到车队 ${teamId}`);
  if (!def) {
    return {
      ok: false,
      blockers: [`未知零件类型「${partType}」`],
      partType,
      partName: partType,
      ambition,
      ambitionName: amb?.name ?? ambition,
      rush,
      cost: 0,
      weeks: 0,
      aeroHours: 0,
      gain: [0, 0],
      currentBest: 0,
      relDelta: 0,
      units: 0,
    };
  }
  // 用玩家已知的性能做基准：未验证新件的真实收益不能从研发预览里推算出来
  const best = bestDisclosedPerf(team, partType) ?? 50;
  const expected = amb.gain * headroom(rules, best) * staffFactor(team, def.aero) * facilityGainFactor(team, def.aero);
  const spread = amb.spread * facilitySpreadFactor(team, def.aero);
  const cost = round2(def.baseCost * amb.costMul * (rush ? 1.5 : 1));
  const weeks = Math.max(
    1,
    Math.round((def.baseWeeks * amb.weeksMul * (rush ? 0.65 : 1) * aduoWeeksMul(state, team, partType)) / speedFactor(team, def.aero)),
  );
  const aeroHours = def.aero ? Math.round(def.aeroHours * amb.hoursMul) : 0;
  const units = rush ? 1 : amb.units;
  const relDelta = round1(amb.relDelta + team.facilities.factory * 0.5);

  if (!def.developable) blockers.push(`规则禁止研发${def.name}`);
  const puBlock = puDesignBlock(state, team, partType);
  if (puBlock) blockers.push(puBlock);
  const designing = team.projects.filter(p => p.kind === 'design');
  if (designing.length >= rndSlots(team, rules)) blockers.push(`研发槽位已满（${designing.length}/${rndSlots(team, rules)}）`);
  if (designing.some(p => p.partType === partType)) blockers.push(`${def.name}已有在研项目`);
  if (aeroHours > team.aeroHours) blockers.push(`风洞/CFD 时长不足（需要 ${aeroHours}h，剩余 ${team.aeroHours}h）`);
  const money = affordError(team, cost, 'rnd', rules);
  if (money) blockers.push(money);
  if (state.season.phase === 'season_end') blockers.push('赛季已结束，请先开始新赛季');
  const managementBlocker = teamId === state.meta.playerTeamId ? managementActionBlocker(state, { type: 'START_PROJECT', partType, ambition, rush }) : null;
  if (managementBlocker) blockers.push(managementBlocker);

  return {
    ok: blockers.length === 0,
    blockers,
    partType,
    partName: def.name,
    ambition,
    ambitionName: amb.name,
    rush,
    cost,
    weeks,
    aeroHours,
    gain: [round1(expected * (1 - spread)), round1(expected * (1 + spread))],
    currentBest: best,
    relDelta,
    units,
  };
}

export function startProject(
  state: GameState,
  teamId: string,
  partType: PartType,
  ambition: Ambition,
  rush: boolean,
  rng: Rng,
): Outcome {
  if (!AMBITIONS.includes(ambition)) return fail(`未知研发方案「${ambition}」`);
  const pv = previewProject(state, teamId, partType, ambition, rush);
  if (!pv.ok) return fail(pv.blockers.join('；'));
  const team = state.teams[teamId];
  const [lo, hi] = pv.gain;
  const mid = (lo + hi) / 2;
  const sd = Math.max(0.05, (hi - lo) / 3.2);
  const trueGain = round1(clamp(rng.normal(mid, sd), lo - (hi - lo) * 0.2, hi + (hi - lo) * 0.1) * difficultyMul(state, team));
  charge(team, pv.cost, 'rnd', state.rules);
  team.aeroHours -= pv.aeroHours;
  const project: Project = {
    id: nextId(state, 'p'),
    kind: 'design',
    label: `${pv.partName}·${pv.ambitionName}${rush ? '·加急' : ''}`,
    partType,
    ambition,
    rush,
    cost: pv.cost,
    weeksTotal: pv.weeks,
    weeksLeft: pv.weeks,
    expected: [lo, hi],
    trueGain,
    relDelta: pv.relDelta,
    units: pv.units,
    startedAt: stamp(state),
  };
  team.projects.push(project);
  if (team.isPlayer) {
    addNews(state, '研发', `启动${project.label}项目：花费 $${pv.cost.toFixed(1)}M，预计 ${pv.weeks} 周，预期提升 +${lo}~+${hi}。`);
  }
  return ok(`已启动「${project.label}」，预计 ${pv.weeks} 周后交付`);
}

export function cancelProject(state: GameState, teamId: string, projectId: string): Outcome {
  const team = state.teams[teamId];
  const idx = team.projects.findIndex(p => p.id === projectId);
  if (idx < 0) return fail('找不到该项目');
  const p = team.projects[idx];
  team.projects.splice(idx, 1);
  // 取消只退还 30% 的现金（预算帽额度不退）
  const refund = round2(p.cost * 0.3);
  income(team, refund);
  if (team.isPlayer) addNews(state, '研发', `取消了「${p.label}」，回收 $${refund.toFixed(1)}M。`);
  return ok(`已取消「${p.label}」，回收 $${refund.toFixed(1)}M`);
}

// ───────────────────────────── 生产 ─────────────────────────────

export interface SimplePreview {
  ok: boolean;
  blockers: string[];
  cost: number;
  weeks: number;
  label: string;
}

export function previewManufacture(state: GameState, teamId: string, partType: PartType, specId: string, qty: number): SimplePreview {
  const team = state.teams[teamId];
  const def = state.rules.parts[partType];
  const blockers: string[] = [];
  const spec = def ? findSpec(team, partType, specId) : undefined;
  const n = Math.max(1, Math.min(5, Math.round(qty || 1)));
  if (!def || !spec) {
    return { ok: false, blockers: ['找不到该零件规格'], cost: 0, weeks: 0, label: '' };
  }
  const cost = round2(def.unitCost * n);
  const weeks = Math.max(1, Math.round((def.baseWeeks * 0.35 + (n - 1) * 0.5) / (0.8 + team.facilities.factory * 0.08)));
  if (team.projects.filter(p => p.kind === 'manufacture').length >= 3) blockers.push('生产线已满（最多 3 个生产订单）');
  const money = affordError(team, cost, 'manufacture', state.rules);
  if (money) blockers.push(money);
  return { ok: blockers.length === 0, blockers, cost, weeks, label: `生产 ${def.name} v${spec.version} ×${n}` };
}

export function orderUnits(state: GameState, teamId: string, partType: PartType, specId: string, qty: number): Outcome {
  const pv = previewManufacture(state, teamId, partType, specId, qty);
  if (!pv.ok) return fail(pv.blockers.join('；'));
  const team = state.teams[teamId];
  const n = Math.max(1, Math.min(5, Math.round(qty || 1)));
  charge(team, pv.cost, 'manufacture', state.rules);
  team.projects.push({
    id: nextId(state, 'p'),
    kind: 'manufacture',
    label: pv.label,
    partType,
    specId,
    qty: n,
    cost: pv.cost,
    weeksTotal: pv.weeks,
    weeksLeft: pv.weeks,
    startedAt: stamp(state),
  });
  return ok(`已下单「${pv.label}」，${pv.weeks} 周后到货`);
}

// ───────────────────────────── 设施 ─────────────────────────────

export function previewFacility(state: GameState, teamId: string, facility: FacilityType): SimplePreview & { nextLevel: number } {
  const team = state.teams[teamId];
  const def = state.rules.facilities[facility];
  const blockers: string[] = [];
  if (!def) return { ok: false, blockers: ['未知设施'], cost: 0, weeks: 0, label: '', nextLevel: 0 };
  const level = team.facilities[facility];
  const nextLevel = level + 1;
  const cost = def.upgradeCost[level - 1] ?? 0;
  const weeks = def.upgradeWeeks[level - 1] ?? 0;
  if (level >= def.maxLevel) blockers.push(`${def.name}已是最高等级`);
  if (team.projects.some(p => p.kind === 'facility' && p.facility === facility)) blockers.push(`${def.name}正在升级`);
  if (level < def.maxLevel) {
    const money = affordError(team, cost, 'facility', state.rules);
    if (money) blockers.push(money);
  }
  const managementBlocker = teamId === state.meta.playerTeamId ? managementActionBlocker(state, { type: 'UPGRADE_FACILITY', facility }) : null;
  if (managementBlocker) blockers.push(managementBlocker);
  return { ok: blockers.length === 0, blockers, cost, weeks, label: `${def.name}升级至 ${nextLevel} 级`, nextLevel };
}

export function upgradeFacility(state: GameState, teamId: string, facility: FacilityType): Outcome {
  const pv = previewFacility(state, teamId, facility);
  if (!pv.ok) return fail(pv.blockers.join('；'));
  const team = state.teams[teamId];
  charge(team, pv.cost, 'facility', state.rules);
  team.projects.push({
    id: nextId(state, 'p'),
    kind: 'facility',
    label: pv.label,
    facility,
    cost: pv.cost,
    weeksTotal: pv.weeks,
    weeksLeft: pv.weeks,
    startedAt: stamp(state),
  });
  if (team.isPlayer) addNews(state, '设施', `开始${pv.label}（$${pv.cost.toFixed(1)}M，${pv.weeks} 周）。`);
  return ok(`已开始「${pv.label}」`);
}

// ───────────────────────────── 训练 ─────────────────────────────

export function previewPitTraining(state: GameState, teamId: string, focus: PitCrewFocus = 'speed'): SimplePreview {
  const team = state.teams[teamId];
  const blockers: string[] = [];
  const cost = 0.4;
  if (team.projects.some(p => p.kind === 'pit_training')) blockers.push('维修组正在训练');
  if ((team.pitCrewTraining?.[focus] ?? team.staff.pitCrew.skill) >= 99) blockers.push('该专项已达极限');
  const money = affordError(team, cost, 'misc', state.rules);
  if (money) blockers.push(money);
  const labels: Record<PitCrewFocus, string> = { speed: '速度', consistency: '稳定性', error_control: '失误控制' };
  return { ok: blockers.length === 0, blockers, cost, weeks: 2, label: `维修组${labels[focus]}训练` };
}

export function startPitTraining(state: GameState, teamId: string, focus: PitCrewFocus = 'speed'): Outcome {
  if (!['speed', 'consistency', 'error_control'].includes(focus)) return fail('未知维修组训练专项');
  const pv = previewPitTraining(state, teamId, focus);
  if (!pv.ok) return fail(pv.blockers.join('；'));
  const team = state.teams[teamId];
  charge(team, pv.cost, 'misc', state.rules);
  team.projects.push({
    id: nextId(state, 'p'),
    kind: 'pit_training',
    label: pv.label,
    pitFocus: focus,
    cost: pv.cost,
    weeksTotal: pv.weeks,
    weeksLeft: pv.weeks,
    startedAt: stamp(state),
  });
  return ok(`维修组开始${pv.label}（2 周）`);
}

export function previewDriverTraining(state: GameState, teamId: string, driverId: string, attr: DriverAttr): SimplePreview & { gain: number } {
  const team = state.teams[teamId];
  const d = state.drivers[driverId];
  const blockers: string[] = [];
  if (!d || d.teamId !== teamId) return { ok: false, blockers: ['该车手不属于本车队'], cost: 0, weeks: 0, label: '', gain: 0 };
  const cost = round2(0.25 + team.facilities.simulator * 0.05);
  const ageMul = d.age < 25 ? 1.3 : d.age < 30 ? 1 : d.age < 34 ? 0.6 : 0.3;
  const potentialMul = driverOverall(d) >= d.potential ? 0.2 : 1;
  const gain = round1(1.2 * ageMul * potentialMul * (0.8 + team.facilities.simulator * 0.1));
  if (team.projects.some(p => p.kind === 'driver_training' && p.driverId === driverId)) blockers.push(`${d.name}已在训练中`);
  if (d.attrs[attr] >= 99) blockers.push('该能力已达上限');
  const money = affordError(team, cost, 'misc', state.rules);
  if (money) blockers.push(money);
  return {
    ok: blockers.length === 0,
    blockers,
    cost,
    weeks: 2,
    label: `${d.name}·${LABELS.driverAttr[attr]}模拟器训练`,
    gain,
  };
}

export function startDriverTraining(state: GameState, teamId: string, driverId: string, attr: DriverAttr): Outcome {
  const pv = previewDriverTraining(state, teamId, driverId, attr);
  if (!pv.ok) return fail(pv.blockers.join('；'));
  const team = state.teams[teamId];
  charge(team, pv.cost, 'misc', state.rules);
  team.projects.push({
    id: nextId(state, 'p'),
    kind: 'driver_training',
    label: pv.label,
    driverId,
    attr,
    cost: pv.cost,
    weeksTotal: pv.weeks,
    weeksLeft: pv.weeks,
    startedAt: stamp(state),
  });
  // 领队把资源投给谁，车手心里有数
  const d = state.drivers[driverId];
  d.morale = clamp(d.morale + 2, 0, 100);
  if (team.isPlayer) d.trust = clamp(d.trust + 1, 0, 100);
  return ok(`已安排「${pv.label}」，预计提升约 +${pv.gain}`);
}

// ───────────────────────────── 升级件分配 ─────────────────────────────

export function fittingLocked(state: GameState): string | null {
  const phase = state.season.phase;
  if (phase === 'season_end') return '赛季已结束';
  if (state.weekend?.parcFerme) return '封闭车辆规则生效中（排位赛后至正赛结束不能换件）';
  if (phase === 'sprint' || phase === 'race') return '封闭车辆规则生效中';
  return null;
}

/** 把某规格零件装到指定车号位上 */
export function fitPart(state: GameState, teamId: string, slot: number, partType: PartType, specId: string): Outcome {
  const team = state.teams[teamId];
  const car = team?.cars.find(c => c.slot === slot);
  if (!car) return fail('找不到该赛车');
  const def = state.rules.parts[partType];
  const spec = findSpec(team, partType, specId);
  if (!def || !spec) return fail('找不到该零件规格');
  const lock = fittingLocked(state);
  if (lock) return fail(lock);
  const current = car.fitted[partType];
  if (current === specId) return ok('该零件已经装在这台车上');
  const stock = team.parts[partType].stock;
  if ((stock[specId] ?? 0) < 1) return fail(`${def.name} v${spec.version} 没有可用备件`);
  const puBlock = puFitBlock(state, team, partType, spec);
  if (puBlock) return fail(puBlock);
  homologateUpgradePackage(state, team, spec);
  stock[specId] -= 1;
  if (current) stock[current] = (stock[current] ?? 0) + 1;
  car.fitted[partType] = specId;
  const penalty = recordPuFit(state, car.driverId, partType, specId);
  const who = car.driverId ? driverName(state, car.driverId) : `${slot} 号车`;
  return ok(`已为 ${who} 换上 ${def.name} v${spec.version}${penalty ? `；${penalty}` : ''}`);
}

/** 新件交付后的自动分配（AI 车队；玩家可在设置里开启） */
export function autoFit(state: GameState, team: TeamState, partType: PartType, specId: string): string[] {
  const fittedTo: string[] = [];
  const spec = findSpec(team, partType, specId);
  if (!spec) return fittedTo;
  // 优先车手先装
  const cars = [...team.cars].sort((a, b) => {
    const pa = a.driverId === team.driverPriority ? 0 : 1;
    const pb = b.driverId === team.driverPriority ? 0 : 1;
    return pa - pb || a.slot - b.slot;
  });
  for (const car of cars) {
    const cur = findSpec(team, partType, car.fitted[partType]);
    // 按玩家已知的性能比较（未验证的新件用预估值），避免自动分配泄露真实收益
    if (cur && disclosedPerf(cur) >= disclosedPerf(spec)) continue;
    const res = fitPart(state, team.id, car.slot, partType, specId);
    if (res.ok && car.driverId) fittedTo.push(car.driverId);
  }
  return fittedTo;
}

// ───────────────────────────── 时间推进 ─────────────────────────────

function completeProject(state: GameState, team: TeamState, p: Project, rng: Rng): void {
  const rules = state.rules;
  switch (p.kind) {
    case 'design': {
      const pt = p.partType!;
      const def = rules.parts[pt];
      const parts = team.parts[pt];
      const best = bestSpec(team, pt);
      const version = Math.max(...parts.specs.map(s => s.version)) + 1;
      // 与研发预览使用同一个基准（玩家已知的最好性能），预估区间才不会泄露旧件的真实性能
      const base = bestDisclosedPerf(team, pt) ?? 50;
      const spec: PartSpec = {
        id: `${pt}-${version}`,
        type: pt,
        version,
        perf: round1(clamp(base + (p.trueGain ?? 0), 1, 100)),
        rel: round1(clamp((best?.rel ?? 80) + (p.relDelta ?? 0) + rng.normal(0, 1.5), 30, 99)),
        verified: !team.isPlayer,
        expected: p.expected ? [round1(base + p.expected[0]), round1(base + p.expected[1])] : null,
        homologated: !rules.aduo.enabled || !rules.aduo.parts.includes(pt),
        introduced: stamp(state),
      };
      parts.specs.push(spec);
      parts.stock[spec.id] = (parts.stock[spec.id] ?? 0) + (p.units ?? 1);
      if (spec.homologated !== false) supplyCustomers(state, team, pt, spec);
      if (team.isPlayer) {
        const certification = spec.homologated === false ? '，需获得 ADUO 认证后才能装车' : '';
        addNews(state, '研发', `${def.name} v${version} 已交付 ×${p.units ?? 1}（预估性能 ${spec.expected?.[0]}~${spec.expected?.[1]}）${certification}。`);
        const allocation = spec.homologated === false
          ? '这是待认证动力单元升级批次的一部分。获得 ADUO 机会后，首次装车会认证当前批次中的全部待认证规格。'
          : '领队需要决定把它装到哪位车手的车上。';
        addNarration(
          state,
          'part_delivered',
          `${def.name} v${version} 交付`,
          `工厂交付了 ${p.units ?? 1} 件新的${def.name}（v${version}），真实表现需要在赛道上验证。${allocation}`,
        );
      } else {
        const fitted = autoFit(state, team, pt, spec.id);
        // AI：只有 1 件时再下单 1 件给另一台车
        if (fitted.length < team.cars.length && (parts.stock[spec.id] ?? 0) === 0) {
          orderUnits(state, team.id, pt, spec.id, 1);
        }
      }
      break;
    }
    case 'manufacture': {
      const parts = team.parts[p.partType!];
      parts.stock[p.specId!] = (parts.stock[p.specId!] ?? 0) + (p.qty ?? 1);
      if (team.isPlayer) addNews(state, '生产', `${p.label} 已到货。`);
      else autoFit(state, team, p.partType!, p.specId!);
      break;
    }
    case 'facility': {
      const f = p.facility!;
      team.facilities[f] = Math.min(rules.facilities[f].maxLevel, team.facilities[f] + 1);
      if (team.isPlayer) addNews(state, '设施', `${rules.facilities[f].name}升级完成，现为 ${team.facilities[f]} 级。`);
      break;
    }
    case 'pit_training': {
      const s = team.staff.pitCrew;
      const focus = p.pitFocus ?? 'speed';
      team.pitCrewTraining ??= { speed: s.skill, consistency: s.skill, error_control: s.skill };
      const current = team.pitCrewTraining[focus];
      const gain = Math.max(0.5, 3 * (1 - current / 110));
      team.pitCrewTraining[focus] = round1(clamp(current + gain, 1, 100));
      // Keep the legacy headline rating meaningful while specialists drive timing.
      s.skill = round1(clamp(s.skill + gain, 1, 100));
      if (team.isPlayer) addNews(state, '车队', `${p.label}结束，${focus === 'speed' ? '速度' : focus === 'consistency' ? '稳定性' : '失误控制'}提升至 ${team.pitCrewTraining[focus]}。`);
      break;
    }
    case 'driver_training': {
      const d = state.drivers[p.driverId!];
      if (d && p.attr) {
        const pv = previewDriverTraining(state, team.id, d.id, p.attr);
        const gain = pv.gain || 0.3;
        d.attrs[p.attr] = round1(clamp(d.attrs[p.attr] + gain, 1, 100));
        if (team.isPlayer) addNews(state, '车手', `${d.name} 完成模拟器训练：${LABELS.driverAttr[p.attr]} +${gain}。`);
      }
      break;
    }
  }
}

/** 推进 n 周：所有车队的项目进度、薪水、体能恢复，以及 AI 车队决策 */
export function advanceWeeks(state: GameState, weeks: number, rng: Rng): void {
  for (let w = 0; w < weeks; w++) {
    state.season.week += 1;
    advanceSpecialWeeks(state);
    for (const tid of state.teamOrder) {
      const team = state.teams[tid];
      if (!team.isPlayer) {
        advanceAiTeamSpecial(state, team);
        advanceAiNextTeamSpecial(state, team);
        advanceAiManagementSpecial(state, team);
        aiTeamWeek(state, team, rng);
      }
      for (const p of [...team.projects]) {
        p.weeksLeft -= 1;
        if (p.weeksLeft <= 0) {
          team.projects = team.projects.filter(x => x.id !== p.id);
          completeProject(state, team, p, rng);
        }
      }
      payWeeklySalaries(state, team);
    }
    for (const d of Object.values(state.drivers)) {
      d.fitness = clamp(d.fitness + 8, 0, 100);
    }
  }
}

// ───────────────────────────── AI 车队 ─────────────────────────────

/** 剩余赛历的平均赛道需求 */
export function upcomingDemands(state: GameState): Record<TrackDemand, number> {
  const out: Record<TrackDemand, number> = { downforce: 0, efficiency: 0, power: 0, mechanical: 0 };
  const rounds = state.calendar.slice(state.season.roundIndex);
  const list = rounds.length ? rounds : state.calendar;
  for (const r of list) {
    const t = state.tracks[r.trackId];
    if (!t) continue;
    for (const k of TRACK_DEMANDS) out[k] += t.weights[k] / list.length;
  }
  return out;
}

/** 零件对当前赛历的重要性 */
export function partImportance(rules: Rules, demands: Record<TrackDemand, number>): Record<PartType, number> {
  const attrTotals: Partial<Record<CarAttr, number>> = {};
  for (const def of Object.values(rules.parts)) {
    for (const [a, w] of Object.entries(def.weights) as Array<[CarAttr, number]>) attrTotals[a] = (attrTotals[a] ?? 0) + w;
  }
  const demandOf = (a: CarAttr) => (a === 'tyre' ? 0.2 : demands[a as TrackDemand]);
  const out: Record<PartType, number> = {};
  for (const [pt, def] of Object.entries(rules.parts)) {
    let s = 0;
    for (const [a, w] of Object.entries(def.weights) as Array<[CarAttr, number]>) {
      const tot = attrTotals[a] ?? 1;
      s += (w / tot) * demandOf(a);
    }
    out[pt] = s;
  }
  return out;
}

function aiTeamWeek(state: GameState, team: TeamState, rng: Rng): void {
  const rules = state.rules;
  // 1) 研发：有空槽、钱和预算帽都够就开新项目
  const slots = rndSlots(team, rules);
  const designing = team.projects.filter(p => p.kind === 'design');
  if (designing.length < slots && team.funds > 8 && capRemaining(team, rules) > 6) {
    const imp = partImportance(rules, upcomingDemands(state));
    const candidates = Object.keys(rules.parts)
      .filter(pt => {
        if (!rules.parts[pt].developable || designing.some(p => p.partType === pt) || puDesignBlock(state, team, pt)) return false;
        const pendingSameType = team.parts[pt]?.specs.some(spec => spec.homologated === false);
        return !(isAduoPart(state, pt) && homologationsLeft(state, team) <= 0 && pendingSameType);
      })
      .map(pt => {
        const best = bestSpec(team, pt)?.perf ?? 50;
        const score = (imp[pt] * headroom(rules, best)) / Math.max(0.5, rules.parts[pt].baseCost);
        return { pt, score: score * rng.range(0.7, 1.3) };
      })
      .sort((a, b) => b.score - a.score);
    const standing = state.standings.teams[team.id];
    const behind = standing ? rankOfTeam(state, team.id) > team.targetPosition : false;
    const ambition: Ambition = capRemaining(team, rules) < 20 ? 'conservative' : behind && rng.chance(0.4) ? 'aggressive' : 'standard';
    for (const c of candidates.slice(0, 3)) {
      const res = startProject(state, team.id, c.pt, ambition, false, rng);
      if (res.ok) break;
    }
  }
  // 2) 设施：资金充裕时偶尔升级最弱的设施
  if (team.funds > 35 && rng.chance(0.06) && !team.projects.some(p => p.kind === 'facility')) {
    const weakest = (Object.keys(team.facilities) as FacilityType[]).sort((a, b) => team.facilities[a] - team.facilities[b])[0];
    upgradeFacility(state, team.id, weakest);
  }
}

/** 车队当前积分排名（1 起） */
export function rankOfTeam(state: GameState, teamId: string): number {
  const sorted = [...state.teamOrder].sort((a, b) => {
    const pa = state.standings.teams[a]?.points ?? 0;
    const pb = state.standings.teams[b]?.points ?? 0;
    return pb - pa;
  });
  return sorted.indexOf(teamId) + 1;
}

/** 刷新所有车队的风洞时长（每个比赛间隔一次） */
export function refreshAeroAllowance(state: GameState): void {
  for (const tid of state.teamOrder) {
    const team = state.teams[tid];
    team.aeroHours = aeroAllowance(state.rules, rankOfTeam(state, tid) - 1);
  }
}

/** 两台车之间的性能差（overall），用于界面提示 */
export function allocationGap(state: GameState, team: TeamState): number {
  if (team.cars.length < 2) return 0;
  const scores = team.cars.map(c => carRatings(team, c, state.rules, 'disclosed').overall);
  return round1(Math.max(...scores) - Math.min(...scores));
}
