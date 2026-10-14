/**
 * 2026 动力单元配额（简化版）。
 *
 * rules.puAllocation 中列出的零件类型（默认：内燃机 4、能量回收系统 3）按车手按赛季计数：
 * - 开局 / 新赛季装上的第一件计为 1 件；
 * - 换上本赛季没用过的新规格 +1（换回用过的旧规格不计，相当于轮换池中的旧件）；
 * - 事故损毁后换上的备件 +1，被损毁的规格从池中移除。
 * 超出配额：第一次罚退 puPenaltyFirst 位，之后每次 puPenaltyNext 位。
 */
import { addNews, driverName } from './log';
import type { CarState, DriverState, GameState, PartType, PowerUnitPartType } from './types';
import { addGridPenalty } from './weekend';

export const PU_PART_TYPES: readonly PowerUnitPartType[] = ['ice', 'turbocharger', 'mgu_k', 'energy_store', 'control_electronics', 'exhaust'];
export const PU_COMBUSTION_PARTS: readonly PowerUnitPartType[] = ['ice', 'turbocharger', 'exhaust'];
export const PU_ELECTRICAL_PARTS: readonly PowerUnitPartType[] = ['mgu_k', 'energy_store', 'control_electronics'];

export function isPowerUnitPart(type: PartType): type is PowerUnitPartType {
  return PU_PART_TYPES.includes(type as PowerUnitPartType);
}

/** 本赛季最后一场正赛已经开始：配额将在新赛季重置，超额不再罚退到下一站（即下赛季首站） */
function seasonOver(state: GameState): boolean {
  const { phase, roundIndex } = state.season;
  return phase === 'season_end' || (roundIndex >= state.calendar.length - 1 && (phase === 'race' || phase === 'post_race'));
}

/** 是否计入配额 */
export function isPuPart(state: GameState, partType: PartType): boolean {
  return (state.rules.puAllocation[partType] ?? 0) > 0;
}

/** 按当前装车给车手初始化配额计数（开局 / 新赛季 / 换车手时调用） */
export function resetPuUsage(state: GameState, driver: DriverState, car: CarState | undefined): void {
  driver.puUsed = {};
  driver.puPool = {};
  for (const pt of Object.keys(state.rules.puAllocation)) {
    const spec = car?.fitted[pt];
    driver.puUsed[pt] = spec ? 1 : 0;
    driver.puPool[pt] = spec ? [spec] : [];
  }
}

function ensure(driver: DriverState, pt: PartType): void {
  driver.puUsed ??= {};
  driver.puPool ??= {};
  driver.puPool[pt] ??= [];
  driver.puUsed[pt] ??= driver.puPool[pt].length;
}

/**
 * 记录一次装车。fresh = true 表示新的物理件（事故后换上的备件），总是计数。
 * 返回罚退说明（没有罚退时为空字符串）。
 */
export function recordPuFit(
  state: GameState,
  driverId: string | null,
  partType: PartType,
  specId: string,
  opts: { fresh?: boolean; replaced?: string } = {},
): string {
  if (!driverId || !isPuPart(state, partType)) return '';
  const driver = state.drivers[driverId];
  if (!driver) return '';
  ensure(driver, partType);
  const pool = driver.puPool![partType];
  const car = driver.teamId ? state.teams[driver.teamId]?.cars.find(candidate => candidate.driverId === driverId) : undefined;
  if (isPowerUnitPart(partType) && car) {
    car.puWear ??= {};
    car.puWearPool ??= {};
    const wearPool = car.puWearPool[partType] ??= {};
    if (opts.fresh) wearPool[specId] = 0;
    car.puWear[partType] = { specId, wear: wearPool[specId] ?? 0 };
  }
  if (opts.replaced) {
    const i = pool.indexOf(opts.replaced);
    if (i >= 0) pool.splice(i, 1);
  }
  if (!opts.fresh && pool.includes(specId)) return '';
  if (!pool.includes(specId)) pool.push(specId);
  const used = (driver.puUsed![partType] += 1);
  const limit = state.rules.puAllocation[partType];
  if (used <= limit) return '';
  const grid = used === limit + 1 ? state.rules.puPenaltyFirst : state.rules.puPenaltyNext;
  if (grid <= 0 || seasonOver(state)) return '';
  const { added, thisRound } = addGridPenalty(state, driverId, grid, 99);
  const name = state.rules.parts[partType]?.name ?? partType;
  const text = `${driverName(state, driverId)} 启用本赛季第 ${used} 件${name}（配额 ${limit}），罚退 ${added} 位（${thisRound ? '本站' : '下一站'}生效）`;
  const team = state.teams[driver.teamId ?? ''];
  if (team?.isPlayer) addNews(state, '罚退', `${text}。`);
  return text;
}
