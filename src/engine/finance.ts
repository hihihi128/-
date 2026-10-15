/**
 * 财务与预算帽。
 *
 * - funds：车队现金（M$）。
 * - costCapSpent：本赛季计入预算帽的支出（研发、生产、维修、运营；薪水/设施按规则开关决定）。
 * - 薪水按周发放（年薪 / 52），运营成本与赞助收入按站结算，奖金在赛季末结算。
 */
import type { GameState, Rules, TeamState } from './types';

/** 车队本赛季的预算帽（规则上限 + ADUO 追加额度） */
export function costCapOf(team: TeamState, rules: Rules): number {
  return round2(rules.costCap + (team.aduoCapBonus ?? 0));
}
import { round2 } from './util';

export type ChargeCategory = 'rnd' | 'manufacture' | 'repair' | 'operating' | 'salary' | 'facility' | 'buyout' | 'severance' | 'misc';

export function isCapped(category: ChargeCategory, rules: Rules): boolean {
  switch (category) {
    case 'rnd':
    case 'manufacture':
    case 'repair':
    case 'operating':
      return true;
    case 'salary':
    case 'buyout':
    case 'severance':
      return rules.costCapIncludesSalaries;
    case 'facility':
      return rules.costCapIncludesFacilities;
    default:
      return false;
  }
}

export function capRemaining(team: TeamState, rules: Rules): number {
  return round2(costCapOf(team, rules) - team.costCapSpent);
}

/** 检查能否支付；返回错误原因或 null */
export function affordError(team: TeamState, amount: number, category: ChargeCategory, rules: Rules): string | null {
  if (amount <= 0) return null;
  if (team.funds < amount) return `资金不足（需要 $${amount.toFixed(1)}M，现有 $${team.funds.toFixed(1)}M）`;
  if (isCapped(category, rules) && team.costCapSpent + amount > costCapOf(team, rules) + 1e-9) {
    return `会超出预算帽（剩余 $${capRemaining(team, rules).toFixed(1)}M，需要 $${amount.toFixed(1)}M）`;
  }
  return null;
}

/** 扣款（不做校验，强制支出如维修可能让资金为负） */
export function charge(team: TeamState, amount: number, category: ChargeCategory, rules: Rules): void {
  team.funds = round2(team.funds - amount);
  if (isCapped(category, rules)) team.costCapSpent = round2(team.costCapSpent + amount);
}

export function income(team: TeamState, amount: number): void {
  team.funds = round2(team.funds + amount);
}

export function annualSalaries(state: GameState, team: TeamState): number {
  let total = 0;
  for (const d of Object.values(state.drivers)) if (d.teamId === team.id) total += d.salary;
  for (const s of Object.values(team.staff)) total += s.salary;
  return total;
}

/** 每周薪水 */
export function payWeeklySalaries(state: GameState, team: TeamState): void {
  const weekly = annualSalaries(state, team) / 52;
  charge(team, weekly, 'salary', state.rules);
}

/** 正赛后结算：赞助 + 积分奖金 - 运营成本 */
export function settleRace(state: GameState, team: TeamState, pointsScored: number): { income: number; expense: number } {
  const inc = team.sponsorIncome + pointsScored * state.rules.pointBonus;
  income(team, inc);
  charge(team, team.operatingCost, 'operating', state.rules);
  return { income: round2(inc), expense: round2(team.operatingCost) };
}

export function prizeFor(rules: Rules, position: number): number {
  if (position < 1) return 0;
  return rules.prizeMoney[position - 1] ?? rules.prizeMoney[rules.prizeMoney.length - 1] ?? 0;
}
