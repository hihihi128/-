/**
 * ADUO（Additional Development and Upgrade Opportunities）：2026 动力单元追赶机制。
 *
 * 规则见 types.ts 中的 AduoRules。要点：
 * - 动力单元按 engine 分组。组内有厂商车队（worksTeam）时，只有厂商车队能研发动力单元零件，
 *   新规格完成认证后交付给同组的客户车队；没有厂商车队时，组内每支车队各自研发（兼容旧数据）。
 * - 研发和生产不消耗认证机会；首次装上未认证规格时，一次机会批准当前待认证升级批次。
 * - 评估：evalRounds 中的站次正赛后，比较各厂商 measurePart 的真实性能。
 */
import { addNarration, addNews } from './log';
import { applyAlpinePuPenalty } from './managementSpecials';
import { autoFit } from './development';
import type { AduoEvaluation, AduoResult, GameState, PartSpec, PartType, TeamState } from './types';
import { round1, stamp } from './util';

/** 动力单元分组键：没有填写 engine 的车队自成一组 */
export function engineKey(team: TeamState): string {
  return team.engine || `#${team.id}`;
}

export function engineLabel(team: TeamState): string {
  return team.engine || team.name;
}

/** 同一动力单元的所有车队（按 teamOrder） */
export function engineGroup(state: GameState, key: string): TeamState[] {
  return state.teamOrder.map(id => state.teams[id]).filter(t => t && engineKey(t) === key);
}

export function worksTeamFor(state: GameState, team: TeamState): TeamState | undefined {
  return engineGroup(state, engineKey(team)).find(t => t.worksTeam);
}

/** 客户车队：同组有厂商车队、自己不是厂商车队 */
export function isPuCustomer(state: GameState, team: TeamState): boolean {
  return !team.worksTeam && !!worksTeamFor(state, team);
}

export function isAduoPart(state: GameState, partType: PartType): boolean {
  return state.rules.aduo.parts.includes(partType);
}

export function homologationsTotal(state: GameState, team: TeamState): number {
  return state.rules.aduo.baseUpgrades + (team.aduoUpgrades ?? 0);
}

export function homologationsLeft(state: GameState, team: TeamState): number {
  return Math.max(0, homologationsTotal(state, team) - (team.puHomologations ?? 0));
}

/** 动力单元零件的研发限制（ADUO 不限制研发，只限制客户车队自行研发） */
export function puDesignBlock(state: GameState, team: TeamState, partType: PartType): string | null {
  if (!isAduoPart(state, partType)) return null;
  const works = worksTeamFor(state, team);
  if (works && works.id !== team.id) return `动力单元由厂商车队 ${works.name} 研发并供应，客户车队不能自行研发`;
  return null;
}

/** 动力单元研发周期倍率（ADUO 档位带来的额外台架时间） */
export function aduoWeeksMul(state: GameState, team: TeamState, partType: PartType): number {
  const r = state.rules.aduo;
  if (!r.enabled || !isAduoPart(state, partType)) return 1;
  const tier = team.aduoTier ?? 0;
  return tier >= 2 ? r.tier2WeeksMul : tier === 1 ? r.tier1WeeksMul : 1;
}

/** 未认证动力单元规格的装车限制（没有限制时返回 null） */
export function puFitBlock(state: GameState, team: TeamState, partType: PartType, spec: PartSpec): string | null {
  if (!state.rules.aduo.enabled || !isAduoPart(state, partType) || spec.homologated !== false) return null;
  const works = worksTeamFor(state, team);
  if (works && works.id !== team.id) return `该动力单元规格尚未由供应商 ${works.name} 完成认证`;
  if (homologationsLeft(state, team) <= 0) {
    return `该动力单元规格尚未认证；当前没有可用 ADUO 认证机会（${team.puHomologations ?? 0}/${homologationsTotal(state, team)}）`;
  }
  return null;
}

/** 预算帽 ADUO 追加额度 */
export function capBonus(team: TeamState): number {
  return team.aduoCapBonus ?? 0;
}

/** 厂商完成认证后，把同样的规格交付给客户车队 */
export function supplyCustomers(state: GameState, works: TeamState, partType: PartType, spec: PartSpec): void {
  if (!works.worksTeam || !isAduoPart(state, partType)) return;
  const name = state.rules.parts[partType]?.name ?? partType;
  for (const c of engineGroup(state, engineKey(works))) {
    if (c.id === works.id || c.worksTeam) continue;
    const parts = c.parts[partType];
    if (!parts) continue;
    const version = Math.max(0, ...parts.specs.map(s => s.version)) + 1;
    let id = `${partType}-${version}`;
    while (parts.specs.some(s => s.id === id)) id += 'c';
    const copy: PartSpec = {
      id,
      type: partType,
      version,
      perf: spec.perf,
      rel: spec.rel,
      verified: true,
      expected: null,
      homologated: true,
      introduced: stamp(state),
    };
    parts.specs.push(copy);
    applyAlpinePuPenalty(state, c, partType, copy);
    const units = Math.max(1, c.cars.length);
    parts.stock[id] = (parts.stock[id] ?? 0) + units;
    if (c.isPlayer) {
      addNews(state, '动力单元', `供应商 ${works.name} 交付了新版${name}（v${version}，性能 ${copy.perf}）×${units}，可以在「赛车」页装车。`);
    } else {
      autoFit(state, c, partType, id);
    }
  }
}

/**
 * 首次装上未认证规格时，消耗一次机会并批准当前全部已交付待认证动力单元规格。
 * 这些规格组成同一升级批次；同批规格以后装车不再消耗机会。
 */
export function homologateUpgradePackage(state: GameState, team: TeamState, requested: PartSpec): PartSpec[] {
  if (!state.rules.aduo.enabled || requested.homologated !== false) return [];
  if (homologationsLeft(state, team) <= 0) return [];
  const pending = state.rules.aduo.parts.flatMap(partType =>
    (team.parts[partType]?.specs ?? []).filter(spec => spec.homologated === false),
  );
  if (!pending.some(spec => spec === requested)) return [];
  for (const spec of pending) spec.homologated = true;
  team.puHomologations = (team.puHomologations ?? 0) + 1;
  for (const spec of pending) supplyCustomers(state, team, spec.type, spec);
  if (team.isPlayer) {
    const names = [...new Set(pending.map(spec => state.rules.parts[spec.type]?.name ?? spec.type))];
    addNews(state, 'ADUO', `动力单元升级批次完成认证：${names.join('、')}。已消耗 1 次 ADUO 认证机会。`);
  }
  return pending;
}

/** AI 厂商在获得机会后，为已完成的待认证批次自动申请认证并装车。 */
function autoHomologatePending(state: GameState, team: TeamState): void {
  if (team.isPlayer || homologationsLeft(state, team) <= 0) return;
  const pending = state.rules.aduo.parts.flatMap(partType =>
    (team.parts[partType]?.specs ?? [])
      .filter(spec => spec.homologated === false)
      .map(spec => ({ partType, spec })),
  );
  if (!pending.length) return;
  pending.sort((a, b) => b.spec.version - a.spec.version);
  for (const { partType, spec } of pending) autoFit(state, team, partType, spec.id);
}

/** 新赛季：客户车队的动力单元零件与厂商车队保持一致 */
export function syncCustomerPu(state: GameState): void {
  for (const tid of state.teamOrder) {
    const team = state.teams[tid];
    if (!isPuCustomer(state, team)) continue;
    const works = worksTeamFor(state, team)!;
    for (const pt of state.rules.aduo.parts) {
      const src = works.parts[pt]?.specs[0];
      const dst = team.parts[pt]?.specs[0];
      if (!src || !dst || team.parts[pt].specs.length !== 1) continue;
      dst.perf = src.perf;
      dst.rel = src.rel;
      applyAlpinePuPenalty(state, team, pt, dst);
    }
  }
}

/** 新赛季重置认证升级次数与 ADUO 状态 */
export function resetAduoSeason(state: GameState): void {
  for (const tid of state.teamOrder) {
    const t = state.teams[tid];
    t.puHomologations = 0;
    t.aduoUpgrades = 0;
    t.aduoCapBonus = 0;
    t.aduoTier = 0;
  }
  state.aduo = { evaluations: [] };
  recordAduoBaseline(state);
}

/** 季前基准：记录各厂商差距（round = 0），不产生任何效果。赛季开始时所有零件都已验证，不会泄露未验证新件的性能。 */
export function recordAduoBaseline(state: GameState): void {
  if (!state.rules.aduo.enabled) return;
  const results = measureManufacturers(state);
  if (!results.length) return;
  state.aduo ??= { evaluations: [] };
  state.aduo.evaluations.push({ year: state.season.year, round: 0, results });
}

/** 下一次评估在第几站后（1 起）；本赛季没有了返回 null */
export function nextEvalRound(state: GameState): number | null {
  const r = state.rules.aduo;
  if (!r.enabled) return null;
  if (state.season.phase === 'season_end') return null;
  // 评估在 finishRound 中执行：post_race 时本站还没有评估，所以只算 roundIndex 之前的站。
  // 最后一站之后直接进入赛季结束，补偿会被重置，所以不评估最后一站。
  const done = state.season.roundIndex;
  const next = [...r.evalRounds].sort((a, b) => a - b).find(n => n > done && n < state.calendar.length);
  return next ?? null;
}

/** 计算各厂商的性能差距（不修改状态） */
export function measureManufacturers(state: GameState): AduoResult[] {
  const r = state.rules.aduo;
  const pt = r.measurePart;
  if (!state.rules.parts[pt]) return [];
  const seen = new Set<string>();
  const rows: AduoResult[] = [];
  for (const tid of state.teamOrder) {
    const team = state.teams[tid];
    const key = engineKey(team);
    if (seen.has(key)) continue;
    seen.add(key);
    const group = engineGroup(state, key);
    const works = group.find(t => t.worksTeam);
    const perf = Math.max(...(works ? [works] : group).map(t => {
      const homologated = (t.parts[pt]?.specs ?? []).filter(spec => spec.homologated !== false);
      return homologated.reduce((best, spec) => Math.max(best, spec.perf), 0);
    }));
    rows.push({ engine: engineLabel(team), worksTeamId: works?.id ?? null, perf, deficitPct: 0, tier: 0, upgrades: 0, capBonus: 0 });
  }
  const best = Math.max(...rows.map(x => x.perf));
  for (const row of rows) {
    // 档位按未取整的差距判断；只在显示/存档时取一位小数
    const deficit = Math.max(0, best - row.perf) * r.pctPerPoint;
    row.deficitPct = round1(deficit);
    row.tier = deficit >= r.tier2Deficit ? 2 : deficit >= r.tier1Deficit ? 1 : 0;
    row.upgrades = row.tier === 2 ? r.tier2Upgrades : row.tier === 1 ? r.tier1Upgrades : 0;
    row.capBonus = row.tier === 2 ? r.tier2CapBonus : row.tier === 1 ? r.tier1CapBonus : 0;
  }
  rows.sort((a, b) => b.perf - a.perf);
  for (const row of rows) row.perf = round1(row.perf);
  return rows;
}

/** 研发动力单元的车队：厂商车队；没有厂商车队时组内所有车队 */
function developers(state: GameState, row: AduoResult): TeamState[] {
  if (row.worksTeamId) return [state.teams[row.worksTeamId]];
  return state.teamOrder.map(id => state.teams[id]).filter(t => engineLabel(t) === row.engine && !worksTeamFor(state, t));
}

/** 第 completedRound 站（1 起）正赛后调用：到评估站次时执行 ADUO 评估 */
export function maybeEvaluateAduo(state: GameState, completedRound: number): AduoEvaluation | null {
  const r = state.rules.aduo;
  if (!r.enabled || !r.evalRounds.includes(completedRound)) return null;
  const results = measureManufacturers(state);
  if (!results.length) return null;
  const evaluation: AduoEvaluation = { year: state.season.year, round: completedRound, results };
  state.aduo ??= { evaluations: [] };
  state.aduo.evaluations.push(evaluation);

  const player = state.teams[state.meta.playerTeamId];
  let playerRow: AduoResult | undefined;
  for (const row of results) {
    for (const t of developers(state, row)) {
      t.aduoTier = row.tier;
      t.aduoUpgrades = (t.aduoUpgrades ?? 0) + row.upgrades;
      t.aduoCapBonus = round1((t.aduoCapBonus ?? 0) + row.capBonus);
      if (row.upgrades > 0) autoHomologatePending(state, t);
    }
    if (player && engineLabel(player) === row.engine) playerRow = row;
  }

  const eligible = results.filter(x => x.tier > 0);
  const summary = eligible.length
    ? eligible.map(x => `${x.engine}（落后 ${x.deficitPct}%，${tierName(x.tier)}）`).join('、')
    : '没有厂商达到门槛';
  addNews(state, 'ADUO', `FIA 完成第 ${completedRound} 站后的动力单元性能评估：${summary}。`);
  if (player && playerRow) {
    const works = player.worksTeam || !worksTeamFor(state, player);
    const owner = works ? '车队' : `供应商 ${worksTeamFor(state, player)!.name}`;
    if (playerRow.tier > 0) {
      const text = `${owner}的动力单元（${playerRow.engine}）落后最好厂商 ${playerRow.deficitPct}%，获得 ADUO ${tierName(playerRow.tier)}：认证升级次数 +${playerRow.upgrades}，预算帽 +$${playerRow.capBonus}M，动力单元研发周期缩短。`;
      addNews(state, 'ADUO', text);
      addNarration(state, 'aduo', `ADUO 评估：${tierName(playerRow.tier)}`, text);
    } else {
      addNews(state, 'ADUO', `${owner}的动力单元（${playerRow.engine}）落后 ${playerRow.deficitPct}%，没有获得 ADUO 补偿。`);
    }
  }
  return evaluation;
}

export function tierName(tier: number): string {
  return tier >= 2 ? '二档' : tier === 1 ? '一档' : '无';
}

/** 给 AI 的一行动力单元 / ADUO 状态（没有内容时返回空字符串） */
export function aduoLine(state: GameState): string {
  const team = state.teams[state.meta.playerTeamId];
  if (!team) return '';
  const supplier = isPuCustomer(state, team) ? worksTeamFor(state, team)! : null;
  const dev = supplier ?? team;
  const role = supplier ? `客户车队（供应商 ${supplier.name}）` : team.worksTeam ? '厂商车队' : '自行研发';
  const bits = [`动力单元：${engineLabel(team)}，${role}`];
  if (state.rules.aduo.enabled) {
    bits.push(`本赛季认证升级 ${dev.puHomologations ?? 0}/${homologationsTotal(state, dev)}`);
    if ((dev.aduoTier ?? 0) > 0) bits.push(`ADUO ${tierName(dev.aduoTier ?? 0)}（预算帽 +$${dev.aduoCapBonus ?? 0}M）`);
  }
  return bits.join(' · ');
}
