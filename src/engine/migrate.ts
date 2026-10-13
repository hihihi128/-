/**
 * 旧存档升级：补齐 2026 规则新增的字段，保证旧版本（2025 规则）的存档可以继续读取。
 *
 * - 规则：只补缺失的键（不覆盖存档里已有的值）。零件表、轮胎表不回填，只新增「能量回收系统」。
 * - 车队：补齐缺失的零件类型（按 70/80 的基础规格），并装到每台车上。
 * - 车手：按当前装车初始化动力单元配额计数。
 * - 法拉利：旧存档没有该字段时设为 null（不启用机制）。
 *
 * 判断依据：没有 rules.puAllocation 的存档是 2026 规则之前的存档。
 * 函数是幂等的，原地修改并返回同一个对象。
 */
import { DEFAULT_RULES } from './defaults';
import { resetPuUsage } from './powerunit';
import { ensureMarket, openMarket } from './market';
import type { GameState } from './types';
import { deepClone } from './util';

/** 玩家可以自由增删条目的规则表：不能按默认值回填，否则会恢复被有意删除的零件 / 轮胎 */
const OPEN_MAPS = new Set(['parts', 'tyres']);

function fillMissing(target: Record<string, unknown>, defaults: Record<string, unknown>, top = false): void {
  for (const [k, v] of Object.entries(defaults)) {
    if (top && OPEN_MAPS.has(k)) continue;
    if (!(k in target) || target[k] === undefined) target[k] = deepClone(v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      fillMissing(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    }
  }
}

export function migrateState(state: GameState): GameState {
  if (!state?.rules || !state.teams) return state;
  if (state.ferrari === undefined) state.ferrari = null;
  // Market rules are a closed map, unlike parts/tyres. Modern saves take the
  // puAllocation fast path below, so fill this before that return.
  state.rules.market ??= deepClone(DEFAULT_RULES.market);
  fillMissing(state.rules.market as unknown as Record<string, unknown>, DEFAULT_RULES.market as unknown as Record<string, unknown>);
  // Market migration intentionally precedes the modern-save early return below.
  // It derives stable IDs/preferences without changing funds, results, or RNG.
  const hadMarket = !!state.market;
  ensureMarket(state);
  if (!hadMarket && state.season?.phase === 'season_end') openMarket(state, state.season.year + 1);
  // Live race is additive and must be initialized before the legacy early return.
  // Never synthesize a session or consume RNG while loading an older save.
  if (state.weekend && state.weekend.liveRace === undefined) state.weekend.liveRace = null;
  if (state.weekend?.liveRace) {
    const live = state.weekend.liveRace;
    // Do not attempt to resume malformed or incompatible private simulation data.
    if (live.version !== 1 || !live.id || !Array.isArray(live.weatherTrajectory) || !live.cars || !Number.isFinite(live.rngState) || live.completedLaps < 0 || live.completedLaps > live.totalLaps) state.weekend.liveRace = null;
    else {
      live.strategistSkill ??= state.teams[state.meta.playerTeamId]?.staff.strategist.skill ?? 50;
      live.redFlags ??= 0;
      live.redFlag ??= null;
      for (const car of Object.values(live.cars)) {
        const driver = state.drivers[car.driverId];
        car.trust ??= driver?.trust ?? 50;
        car.ego ??= driver?.ego ?? 50;
        car.stayOutUntilLap ??= 0;
        car.pendingCompound ??= null;
        const team = state.teams[car.teamId];
        const engineer = car.slot === 2 ? (team?.staff.raceEngineer2 ?? team?.staff.raceEngineer) : team?.staff.raceEngineer;
        car.raceEngineerSkill ??= engineer?.skill ?? 50;
        car.raceEngineerReaction ??= engineer?.abilities?.reaction ?? engineer?.skill ?? 50;
        car.raceEngineerWeather ??= engineer?.abilities?.weather ?? engineer?.skill ?? 50;
      }
    }
  }
  // ADUO（2026-10 新增）：旧存档没有厂商车队信息，按「各车队自行研发」处理
  if (state.rules.puAllocation && !state.rules.aduo) state.rules.aduo = deepClone(DEFAULT_RULES.aduo);
  state.aduo ??= { evaluations: [] };
  for (const team of Object.values(state.teams)) {
    if (!team.staff.raceEngineer2) {
      const first = team.staff.raceEngineer;
      team.staff.raceEngineer2 = { ...deepClone(first), id: `${team.id}-raceEngineer2`, role: 'raceEngineer2', name: `${first.name || team.name}（二号车）` };
    }
    team.worksTeam ??= false;
    // 进行中的动力单元设计项目已经占用认证次数（取消时会返还）
    team.puHomologations ??= state.rules.aduo
      ? team.projects.filter(p => p.kind === 'design' && p.partType && state.rules.aduo.parts.includes(p.partType)).length
      : 0;
    team.aduoUpgrades ??= 0;
    team.aduoCapBonus ??= 0;
    team.aduoTier ??= 0;
  }
  // 已经是 2026 规则的存档（有 puAllocation）不再补规则：玩家可能在世界书里有意删掉了某些默认项
  if (state.rules.puAllocation) return state;
  fillMissing(state.rules as unknown as Record<string, unknown>, DEFAULT_RULES as unknown as Record<string, unknown>, true);
  // 2026 新增的零件类型只有能量回收系统
  state.rules.parts.ers ??= deepClone(DEFAULT_RULES.parts.ers);
  for (const pt of Object.keys(state.rules.puAllocation)) if (!state.rules.parts[pt]) delete state.rules.puAllocation[pt];

  for (const team of Object.values(state.teams)) {
    for (const pt of Object.keys(state.rules.parts)) {
      if (!team.parts[pt]) {
        const id = `${pt}-S${state.season?.number ?? 1}m`;
        team.parts[pt] = {
          specs: [{ id, type: pt, version: 1, perf: 70, rel: 80, verified: true, expected: null, introduced: '存档升级' }],
          stock: { [id]: 1 },
        };
      }
      for (const car of team.cars) car.fitted[pt] ??= team.parts[pt].specs[0].id;
    }
  }

  for (const d of Object.values(state.drivers ?? {})) {
    const car = d.teamId ? state.teams[d.teamId]?.cars.find(c => c.driverId === d.id) : undefined;
    resetPuUsage(state, d, car);
  }

  return state;
}
