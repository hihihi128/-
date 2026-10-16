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
import { PU_COMBUSTION_PARTS, PU_ELECTRICAL_PARTS, PU_PART_TYPES, resetPuUsage } from './powerunit';
import { ensureMarket, openMarket } from './market';
import { migrateTyreInventory } from './tyres';
import { requiresWetGridTyreChoice } from './race';
import type { GameState, LiveQualifyingState, QualiSession, RaceEvent, StaffRole } from './types';
import { deepClone } from './util';
import { initFerrari } from './ferrari';
import { initTeamSpecials } from './teamSpecials';
import { initNextTeamSpecials } from './nextTeamSpecials';
import { initManagementSpecials, settleLegacyAlpinePenalty } from './managementSpecials';
import { fallbackQualifyingSectors, isValidQualifyingSectors } from './data';
import { qualifyingDurationTicks } from './qualifyingRules';
import { hashString, isPlainObject } from './util';

/** 玩家可以自由增删条目的规则表：不能按默认值回填，否则会恢复被有意删除的零件 / 轮胎 */
const OPEN_MAPS = new Set(['parts', 'tyres']);

const LEGACY_PU_MAP = {
  power_unit: PU_COMBUSTION_PARTS,
  ers: PU_ELECTRICAL_PARTS,
} as const;

type LegacyLiveQualifying = {
  version: 1;
  kind: 'qualifying' | 'sprint_qualifying';
  segmentIndex: number;
  segmentCount: number;
  alive: string[];
  finalOrder: string[];
  sessions: unknown[];
  events: unknown[];
};

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function qualifyingCheckpointHistory(state: GameState, value: unknown): LegacyLiveQualifying | null {
  if (!isPlainObject(value)
    || (value.kind !== 'qualifying' && value.kind !== 'sprint_qualifying')
    || typeof value.segmentIndex !== 'number' || !Number.isInteger(value.segmentIndex)
    || typeof value.segmentCount !== 'number' || !Number.isInteger(value.segmentCount)
    || value.segmentCount < 1
    || value.segmentIndex < 0
    || value.segmentIndex >= value.segmentCount
    || !Array.isArray(value.alive)
    || !Array.isArray(value.finalOrder)
    || !Array.isArray(value.sessions)
    || !Array.isArray(value.events)
    || value.sessions.length !== value.segmentIndex) return null;
  const participantIds = new Set(Object.values(state.teams).flatMap(team => team.cars.map(car => car.driverId).filter((id): id is string => !!id)));
  const hasKnownUniqueIds = (ids: unknown[]): ids is string[] => ids.every(id => typeof id === 'string' && participantIds.has(id)) && new Set(ids).size === ids.length;
  const alive = value.alive;
  const finalOrder = value.finalOrder;
  if (!hasKnownUniqueIds(alive) || !hasKnownUniqueIds(finalOrder) || alive.some(id => finalOrder.includes(id))) return null;
  if (alive.length + finalOrder.length !== participantIds.size) return null;
  for (const session of value.sessions) {
    if (!isPlainObject(session) || typeof session.name !== 'string' || !Array.isArray(session.entries) || !session.entries.length) return null;
    const ids = session.entries.map(entry => isPlainObject(entry) ? entry.driverId : null);
    if (!hasKnownUniqueIds(ids)) return null;
  }
  return value as unknown as LegacyLiveQualifying;
}

function qualifyingRecoverySeed(state: GameState, kind: LegacyLiveQualifying['kind'], segmentIndex: number): number {
  return Number.parseInt(hashString(`${state.gameId}:qualifying:${kind}:${state.season.number}:${state.season.roundIndex}:${segmentIndex}`), 16);
}

function qualifyingRunAllowance(kind: LegacyLiveQualifying['kind'], segmentCount: number): number {
  return kind === 'sprint_qualifying' ? 1 : segmentCount === 1 ? 3 : 2;
}

function qualifyingRecoveryBoundary(state: GameState, history: LegacyLiveQualifying, source: Record<string, unknown>, recovery: boolean) {
  const track = state.tracks[state.calendar[state.season.roundIndex]?.trackId];
  const rngState = isUint32(source.rngState) ? source.rngState : qualifyingRecoverySeed(state, history.kind, history.segmentIndex);
  const id = typeof source.id === 'string' && source.id.trim()
    ? source.id
    : `qualifying:${state.gameId}:${state.season.year}:r${state.season.roundIndex + 1}:${history.kind}`;
  const events = history.events as RaceEvent[];
  const recoveryText = '排位实时进度无法验证；已保留完成分段并暂停在恢复边界。';
  if (recovery && !events.some(event => event.text === recoveryText)) events.push({
    lap: 0,
    type: 'info',
    text: recoveryText,
    drivers: [],
    key: true,
  });
  return {
    version: 2 as const,
    id,
    revision: Number.isInteger(source.revision) && (source.revision as number) >= 0 ? source.revision as number : 0,
    physicsVersion: 1 as const,
    weekendKey: `${state.season.year}:r${state.season.roundIndex + 1}`,
    controlMode: 'automatic' as const,
    rngState,
    kind: history.kind,
    segmentIndex: history.segmentIndex,
    segmentCount: history.segmentCount,
    alive: history.alive,
    finalOrder: history.finalOrder,
    sessions: history.sessions as QualiSession[],
    events,
    stage: 'ready' as const,
    paused: true,
    speed: 1 as const,
    elapsedTicks: 0,
    durationTicks: qualifyingDurationTicks(history.kind, history.segmentIndex),
    wet: (history.kind === 'qualifying' ? state.weekend!.weather.qualifying : state.weekend!.weather.sprintQualifying) === 'wet',
    runAllowance: qualifyingRunAllowance(history.kind, history.segmentCount),
    sectors: track ? fallbackQualifyingSectors(track) : [
      { endProgress: 1 / 3, timeWeight: 1 / 3, trafficSensitivity: 1, yieldSeconds: 1.5 },
      { endProgress: 2 / 3, timeWeight: 1 / 3, trafficSensitivity: 1, yieldSeconds: 1.5 },
      { endProgress: 1, timeWeight: 1 / 3, trafficSensitivity: 1, yieldSeconds: 1.5 },
    ],
    cars: {},
  };
}

function hasValidLiveQualifyingPrivateState(state: GameState, live: Record<string, unknown>, history: LegacyLiveQualifying): boolean {
  const expectedWeekendKey = `${state.season.year}:r${state.season.roundIndex + 1}`;
  if (typeof live.id !== 'string' || !live.id
    || !Number.isInteger(live.revision) || (live.revision as number) < 0
    || live.physicsVersion !== 1
    || live.weekendKey !== expectedWeekendKey
    || (live.controlMode !== 'manual' && live.controlMode !== 'automatic')
    || !isUint32(live.rngState)
    || (live.stage !== 'ready' && live.stage !== 'running' && live.stage !== 'finishing')
    || typeof live.paused !== 'boolean'
    || ![1, 2, 4, 8].includes(live.speed as number)
    || !Number.isInteger(live.elapsedTicks) || (live.elapsedTicks as number) < 0
    || !Number.isInteger(live.durationTicks) || (live.durationTicks as number) < 1 || (live.durationTicks as number) > 12_000
    || (live.elapsedTicks as number) > (live.durationTicks as number) + 3_600
    || typeof live.wet !== 'boolean'
    || !Number.isInteger(live.runAllowance) || (live.runAllowance as number) < 1
    || !isValidQualifyingSectors(live.sectors)
    || !isPlainObject(live.cars)) return false;
  if (live.controlMode === 'automatic') return live.stage === 'ready' && live.paused && Object.keys(live.cars).length === 0;
  const cars = live.cars;
  const durationTicks = live.durationTicks as number;
  const elapsedTicks = live.elapsedTicks as number;
  const carIds = Object.keys(cars);
  if (history.alive.some(driverId => !carIds.includes(driverId))) return false;
  const phases = new Set(['garage', 'pit_out', 'out_lap', 'flying_lap', 'in_lap', 'pit_in', 'done']);
  for (const driverId of carIds) {
    const car = cars[driverId];
    const driver = state.drivers[driverId];
    const eligible = history.alive.includes(driverId);
    if (!isPlainObject(car)
      || car.driverId !== driverId
      || car.teamId !== driver?.teamId
      || typeof car.player !== 'boolean'
      || !phases.has(car.phase as string)
      || !Number.isFinite(car.progress) || (car.progress as number) < 0 || (car.progress as number) >= 1
      || !Number.isFinite(car.phaseElapsedTicks) || (car.phaseElapsedTicks as number) < 0
      || !Number.isInteger(car.runCount) || (car.runCount as number) < 0 || (car.runCount as number) > (car.runAllowance as number)
      || !Number.isInteger(car.runAllowance) || (car.runAllowance as number) !== live.runAllowance
      || !Array.isArray(car.completedRuns)
      || !Array.isArray(car.scheduledReleaseTicks)
      || !(car.scheduledReleaseTicks as unknown[]).every(tick => Number.isInteger(tick) && (tick as number) >= 0 && (tick as number) <= durationTicks)
      || !['clear', 'slower_ahead', 'yielding'].includes(car.trafficStatus as string)
      || (car.trafficDriverId !== null && (typeof car.trafficDriverId !== 'string' || !history.alive.includes(car.trafficDriverId)))
      || !Number.isInteger(car.sector) || (car.sector as number) < 1 || (car.sector as number) > (live.sectors as unknown[]).length
      || (car.bestTime !== null && !Number.isFinite(car.bestTime))
      || (car.lastTime !== null && !Number.isFinite(car.lastTime))
      || (car.activeRun !== null && !isPlainObject(car.activeRun))) return false;
    if (!eligible && (!car.player || car.phase !== 'done' || car.activeRun !== null || (car.scheduledReleaseTicks as unknown[]).length)) return false;
    if (car.activeRun) {
      const inventory = state.teams[car.teamId as string]?.tyreInventory?.[driverId] ?? [];
      const activeRun = car.activeRun as Record<string, unknown>;
      const tyreSet = typeof activeRun.setId === 'string' ? inventory.find(set => set.id === activeRun.setId && !set.returned) : undefined;
      if (!tyreSet
        || activeRun.compound !== tyreSet.compound
        || typeof activeRun.startedNew !== 'boolean'
        || !Number.isInteger(activeRun.lapsBefore) || (activeRun.lapsBefore as number) < 0
        || !Number.isInteger(activeRun.lapsCharged) || (activeRun.lapsCharged as number) < 0 || (activeRun.lapsCharged as number) > 3
        || !Number.isFinite(activeRun.cleanTime) || (activeRun.cleanTime as number) <= 0
        || typeof activeRun.valid !== 'boolean'
        || (activeRun.flyingStartedTick !== null && (!Number.isFinite(activeRun.flyingStartedTick) || (activeRun.flyingStartedTick as number) < 0 || (activeRun.flyingStartedTick as number) > elapsedTicks))
        || !Number.isFinite(activeRun.flyingElapsedTicks) || (activeRun.flyingElapsedTicks as number) < 0
        || !Number.isFinite(activeRun.trafficLoss) || (activeRun.trafficLoss as number) < 0
        || (activeRun.blockerId !== null && (typeof activeRun.blockerId !== 'string' || !history.alive.includes(activeRun.blockerId)))
        || !Number.isInteger(activeRun.blockerTicks) || (activeRun.blockerTicks as number) < 0) return false;
    }
  }
  return true;
}

const STRATEGY_RAIN_BALANCE_FLAG = 'strategy-rain-balance-v1';
const BALANCED_RAIN_CHANCES: Record<string, number> = {
  melbourne: .14, shanghai: .135, suzuka: .16, bahrain: .005, jeddah: .01, miami: .125,
  montreal: .155, monaco: .11, barcelona: .06, spielberg: .14, silverstone: .21, spa: .24,
  hungaroring: .12, zandvoort: .175, monza: .09, madrid: .075, baku: .04, singapore: .19,
  cota: .1, mexico: .09, interlagos: .22, las_vegas: .02, lusail: .005, yas_marina: .005,
};
const BALANCED_STRATEGISTS: Record<string, { name: string; skill: number; strategy: number; weather: number; reaction: number }> = {
  red_bull: { name: '汉娜·施密茨', skill: 94, strategy: 94, weather: 93, reaction: 93 },
  mercedes: { name: '罗茜·韦特', skill: 90, strategy: 90, weather: 89, reaction: 89 },
  williams: { name: '夏尔-安托万·弗洛朗坦', skill: 85, strategy: 85, weather: 84, reaction: 84 },
  haas: { name: '卡琳·克里德利希', skill: 85, strategy: 85, weather: 84, reaction: 84 },
  audi: { name: '里特维克·达南贾亚·雷迪', skill: 85, strategy: 85, weather: 84, reaction: 84 },
  alpine: { name: '奥里奥尔·伊塞恩', skill: 85, strategy: 85, weather: 84, reaction: 84 },
  cadillac: { name: '亚历克斯·古迪纳夫', skill: 85, strategy: 85, weather: 84, reaction: 84 },
  racing_bulls: { name: '马蒂厄·迪布瓦-卢卡', skill: 78, strategy: 78, weather: 77, reaction: 77 },
  mclaren: { name: '兰迪普·辛格', skill: 70, strategy: 70, weather: 69, reaction: 69 },
  aston_martin: { name: '彼得·霍尔', skill: 62, strategy: 62, weather: 60, reaction: 60 },
  ferrari: { name: '拉文·贾恩', skill: 54, strategy: 54, weather: 52, reaction: 52 },
};

function migrateStrategyAndRainBalance(state: GameState): void {
  state.flags ??= {};
  if (state.flags[STRATEGY_RAIN_BALANCE_FLAG]) return;
  for (const [trackId, rainChance] of Object.entries(BALANCED_RAIN_CHANCES)) {
    if (state.tracks?.[trackId]) state.tracks[trackId].rainChance = rainChance;
  }
  for (const [teamId, balance] of Object.entries(BALANCED_STRATEGISTS)) {
    const strategist = state.teams[teamId]?.staff?.strategist;
    if (!strategist || strategist.id !== `${teamId}-strategist` || strategist.name !== balance.name) continue;
    strategist.skill = balance.skill;
    strategist.abilities ??= {};
    strategist.abilities.strategy = balance.strategy;
    strategist.abilities.weather = balance.weather;
    strategist.abilities.reaction = balance.reaction;
  }
  state.flags[STRATEGY_RAIN_BALANCE_FLAG] = true;
}

/** 把旧版两组动力单元无损拆成六类部件。 */
function migrateSixPartPowerUnit(state: GameState): void {
  const allocation = state.rules.puAllocation;
  if (!allocation) return;
  const hasLegacy = !!(
    allocation.power_unit || allocation.ers || state.rules.parts.power_unit || state.rules.parts.ers
    || Object.values(state.teams).some(team => team.parts.power_unit || team.parts.ers
      || team.cars.some(car => car.fitted.power_unit || car.fitted.ers))
    || Object.values(state.drivers ?? {}).some(driver => driver.puUsed?.power_unit || driver.puUsed?.ers || driver.puPool?.power_unit || driver.puPool?.ers)
  );
  if (!hasLegacy) return;
  for (const type of PU_PART_TYPES) state.rules.parts[type] ??= deepClone(DEFAULT_RULES.parts[type]);
  for (const [legacy, targets] of Object.entries(LEGACY_PU_MAP)) {
    const legacyLimit = allocation[legacy] ?? DEFAULT_RULES.puAllocation[targets[0]];
    for (const type of targets) allocation[type] ??= legacyLimit;
  }
  delete allocation.power_unit;
  delete allocation.ers;
  delete state.rules.parts.power_unit;
  delete state.rules.parts.ers;
  if (state.rules.aduo) {
    if (state.rules.aduo.parts.some(type => type === 'power_unit' || type === 'ers')) state.rules.aduo.parts = [...PU_PART_TYPES];
    if (state.rules.aduo.measurePart === 'power_unit' || state.rules.aduo.measurePart === 'ers') state.rules.aduo.measurePart = 'ice';
  }
  for (const team of Object.values(state.teams)) {
    for (const [legacy, targets] of Object.entries(LEGACY_PU_MAP)) {
      const old = team.parts[legacy];
      if (!old) continue;
      for (const type of targets) team.parts[type] ??= {
        specs: old.specs.map(spec => ({ ...deepClone(spec), type })),
        stock: { ...old.stock },
      };
      for (const car of team.cars) {
        const specId = car.fitted[legacy];
        for (const type of targets) {
          if (specId) car.fitted[type] ??= specId;
          const oldWear = car.puWear?.[legacy as keyof typeof car.puWear];
          const oldPool = car.puWearPool?.[legacy as keyof typeof car.puWearPool];
          if (oldWear) (car.puWear ??= {})[type] ??= { ...oldWear };
          if (oldPool) (car.puWearPool ??= {})[type] ??= { ...oldPool };
        }
        delete car.fitted[legacy];
        if (car.puWear) delete (car.puWear as Record<string, unknown>)[legacy];
        if (car.puWearPool) delete (car.puWearPool as Record<string, unknown>)[legacy];
      }
      delete team.parts[legacy];
    }
    team.projects = team.projects.flatMap(project => {
      const targets = LEGACY_PU_MAP[project.partType as keyof typeof LEGACY_PU_MAP];
      return targets ? targets.map(type => ({
        ...deepClone(project),
        id: `${project.id}-${type}`,
        partType: type,
        cost: project.cost / targets.length,
        label: `${project.label} · ${state.rules.parts[type]?.name ?? type}`,
      })) : [project];
    });
  }
  for (const driver of Object.values(state.drivers ?? {})) {
    for (const [legacy, targets] of Object.entries(LEGACY_PU_MAP)) {
      const used = driver.puUsed?.[legacy];
      const pool = driver.puPool?.[legacy];
      for (const type of targets) {
        if (used !== undefined) (driver.puUsed ??= {})[type] ??= used;
        if (pool) (driver.puPool ??= {})[type] ??= [...pool];
      }
      if (driver.puUsed) delete driver.puUsed[legacy];
      if (driver.puPool) delete driver.puPool[legacy];
    }
  }
  if (state.alpine?.penalizedPowerSpecs) {
    const migrated: typeof state.alpine.penalizedPowerSpecs = {};
    for (const entry of Object.values(state.alpine.penalizedPowerSpecs)) {
      const targets = LEGACY_PU_MAP[entry.partType as keyof typeof LEGACY_PU_MAP];
      if (!targets) migrated[`${entry.partType}:${entry.specId}`] = entry;
      else for (const type of targets) migrated[`${type}:${entry.specId}`] = { ...entry, partType: type };
    }
    state.alpine.penalizedPowerSpecs = migrated;
  }
  if (state.rules.astonMartin.aduoPuBuff === 8) state.rules.astonMartin.aduoPuBuff = DEFAULT_RULES.astonMartin.aduoPuBuff;
}

export const DEFAULT_STAFF_NAMES: Record<string, Partial<Record<StaffRole, string>>> = {
  mercedes: { aeroChief: '贾罗德·墨菲', raceEngineer2: '彼得·博宁顿', pitCrew: '梅赛德斯维修组', strategist: '罗茜·韦特' },
  mclaren: { raceEngineer2: '汤姆·斯托拉德', pitCrew: '迈凯伦维修组' },
  red_bull: { aeroChief: '恩里科·巴尔博', raceEngineer2: '理查德·伍德', pitCrew: '红牛维修组' },
  ferrari: { raceEngineer2: '布莱恩·博齐', pitCrew: '法拉利维修组' },
  williams: { aeroChief: '亚当·肯扬', raceEngineer: '詹姆斯·厄文', raceEngineer2: '加埃唐·热戈', pitCrew: '威廉姆斯维修组', strategist: '夏尔-安托万·弗洛朗坦' },
  racing_bulls: { aeroChief: '古鲁·乔尔', raceEngineer: '亚历山大·伊利奥普洛斯', raceEngineer2: '皮埃尔·哈梅林', pitCrew: '小红牛维修组', strategist: '马蒂厄·迪布瓦-卢卡' },
  aston_martin: { aeroChief: '焦阿基诺·维诺', raceEngineer: '克里斯·克罗宁', raceEngineer2: '加里·甘农', pitCrew: '阿斯顿·马丁维修组', strategist: '彼得·霍尔' },
  haas: { aeroChief: '戴维德·帕加内利', raceEngineer: '劳拉·穆勒', raceEngineer2: '罗南·奥黑尔', pitCrew: '哈斯维修组', strategist: '卡琳·克里德利希' },
  audi: { aeroChief: '亚历山德罗·奇内利', raceEngineer: '史蒂文·佩特里克', raceEngineer2: '何塞·曼努埃尔·洛佩斯', pitCrew: '奥迪维修组', strategist: '里特维克·达南贾亚·雷迪' },
  alpine: { aeroChief: '迈克尔·布罗德赫斯特', raceEngineer: '乔什·佩克特', raceEngineer2: '斯图尔特·巴洛', pitCrew: '阿尔派维修组', strategist: '奥里奥尔·伊塞恩' },
  cadillac: { aeroChief: '乔恩·汤姆林森', raceEngineer: '约翰·霍华德', raceEngineer2: '卡洛·帕塞蒂', pitCrew: '凯迪拉克维修组', strategist: '亚历克斯·古迪纳夫' },
};

function replaceLegacyStaffPlaceholders(state: GameState): void {
  for (const [teamId, names] of Object.entries(DEFAULT_STAFF_NAMES)) {
    const team = state.teams[teamId];
    if (!team) continue;
    for (const [role, name] of Object.entries(names) as Array<[StaffRole, string]>) {
      const staff = team.staff[role];
      const placeholders = role === 'raceEngineer2'
        ? [`${team.name} ${role}`, `${team.name}（二号车）`, `${team.name} raceEngineer（二号车）`, '比赛工程师（二号车）']
        : [`${team.name} ${role}`];
      if (staff && placeholders.includes(staff.name)) staff.name = name;
    }
  }
}

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
  // This is deliberately before the modern-save return: old or malformed saves
  // must never opt into a privileged mode merely by being loaded.
  if (state.meta) state.meta.supernaturalMode = state.meta.supernaturalMode === true;
  if (!state.supernatural || typeof state.supernatural !== 'object' || Array.isArray(state.supernatural)) state.supernatural = { pendingWeather: null };
  const pending = state.supernatural.pendingWeather;
  if (!pending || !Number.isFinite(pending.year) || !Number.isInteger(pending.roundIndex) || !Number.isFinite(pending.rainBias)) {
    state.supernatural.pendingWeather = null;
  } else {
    pending.rainBias = Math.max(-0.2, Math.min(0.2, pending.rainBias));
  }
  if (state.ferrari === undefined) state.ferrari = null;
  if (state.mclaren === undefined) state.mclaren = null;
  if (state.mercedes === undefined) state.mercedes = null;
  if (state.redBull === undefined) state.redBull = null;
  if (state.astonMartin === undefined) state.astonMartin = null;
  if (state.racingBulls === undefined) state.racingBulls = null;
  if (state.audi === undefined) state.audi = null;
  if (state.alpine === undefined) state.alpine = null;
  if (state.alpine && state.alpine.penalizedPowerSpecs === undefined) state.alpine.penalizedPowerSpecs = {};
  if (state.haas === undefined) state.haas = null;
  if (state.williams === undefined) state.williams = null;
  const currentRaceKey = state.season ? `${state.season.number}-${state.season.roundIndex}` : null;
  const currentWeekKey = state.season ? `${state.season.number}-w${state.season.week}` : null;
  const alpineRaceKey = state.alpine?.lastActionRound?.includes('-w') ? null : state.alpine?.lastActionRound;
  const haasRaceKey = state.haas?.lastActionRound?.includes('-w') ? null : state.haas?.lastActionRound;
  const williamsRaceKey = state.williams?.focusRound?.includes('-w') ? null : state.williams?.focusRound;
  for (const special of [state.mercedes, state.redBull, state.astonMartin, state.alpine, state.haas]) {
    if (special && currentRaceKey && currentWeekKey && special.lastActionRound === currentRaceKey) special.lastActionRound = currentWeekKey;
  }
  if (state.alpine) {
    state.alpine.lastActionRace ??= alpineRaceKey;
    if (state.alpine.lastActionRace === currentRaceKey && currentWeekKey) state.alpine.lastActionRound = currentWeekKey;
  }
  if (state.haas) {
    state.haas.lastActionRace ??= haasRaceKey;
    if (state.haas.lastActionRace === currentRaceKey && currentWeekKey) state.haas.lastActionRound = currentWeekKey;
  }
  if (state.williams) {
    state.williams.focusRace ??= williamsRaceKey;
    if (state.williams.focusRace === currentRaceKey && currentWeekKey) state.williams.focusRound = currentWeekKey;
  }
  state.randomEvents ??= { lastRoundKey: null, weekKey: null, weeklyQuota: 0, weeklyStarted: 0, current: null, history: [] };
  state.randomEvents.weekKey ??= null;
  state.randomEvents.weeklyQuota ??= 0;
  state.randomEvents.weeklyStarted ??= 0;
  const legacyRandomRules = state.rules.randomEvents;
  const hadRoutineEventWeight = legacyRandomRules?.routineWeight !== undefined;
  const legacyEventsDisabled = !!legacyRandomRules && legacyRandomRules.routineWeight === undefined
    && legacyRandomRules.driverInjuryWeight === 0 && legacyRandomRules.windTunnelWeight === 0 && legacyRandomRules.partIssueWeight === 0;
  const configuredEventsDisabled = legacyRandomRules?.minPerWeek === 0 && legacyRandomRules?.maxPerWeek === 0;
  for (let index = 0; index < state.randomEvents.history.length; index++) {
    const record = state.randomEvents.history[index];
    record.id ??= `legacy-random-event-${record.roundKey}-${index}`;
    record.status ??= record.kind === 'none' ? 'none' : 'resolved';
    record.prompt ??= record.detail;
    record.answerOptions ??= [];
    record.playerAnswer ??= null;
    record.mainReply ??= null;
    record.outcomeSummary ??= record.status === 'resolved' ? record.detail : null;
    record.effects ??= [];
    record.generationError ??= null;
    record.category ??= record.kind.startsWith('routine_') ? 'routine' : 'problem';
    record.totalDialogueTurns ??= ['none', 'resolved', 'unresolved'].includes(record.status) ? 1 : 2;
    record.completedDialogueTurns ??= ['none', 'resolved', 'unresolved'].includes(record.status) ? record.totalDialogueTurns : record.playerAnswer && record.mainReply ? 1 : 0;
    record.dialogue ??= record.playerAnswer && record.mainReply ? [{ player: record.playerAnswer, assistant: record.mainReply }] : [];
  }
  if (state.randomEvents.current) {
    const record = state.randomEvents.current;
    const matching = [...state.randomEvents.history].reverse().find(history => history.roundKey === record.roundKey);
    record.id ??= matching?.id ?? `legacy-random-event-${record.roundKey}-current`;
    record.status ??= record.kind === 'none' ? 'none' : 'resolved';
    record.prompt ??= record.detail;
    record.answerOptions ??= [];
    record.playerAnswer ??= null;
    record.mainReply ??= null;
    record.outcomeSummary ??= record.status === 'resolved' ? record.detail : null;
    record.effects ??= [];
    record.generationError ??= null;
    record.category ??= record.kind.startsWith('routine_') ? 'routine' : 'problem';
    record.totalDialogueTurns ??= ['none', 'resolved', 'unresolved'].includes(record.status) ? 1 : 2;
    record.completedDialogueTurns ??= ['none', 'resolved', 'unresolved'].includes(record.status) ? record.totalDialogueTurns : record.playerAnswer && record.mainReply ? 1 : 0;
    record.dialogue ??= record.playerAnswer && record.mainReply ? [{ player: record.playerAnswer, assistant: record.mainReply }] : [];
  }
  for (const driver of Object.values(state.drivers ?? {})) driver.affinity ??= 50;
  for (const team of Object.values(state.teams)) {
    for (const staff of Object.values(team.staff)) staff.affinity ??= 50;
  }
  if (state.audi) state.audi.alliance = Boolean(state.audi.alliance);
  state.fiaMeeting ??= { politicalCapital: state.rules.fiaMeeting?.startPoliticalCapital ?? 50, completed: 0, current: null, ferrariTurboSpoolSeconds: 0, ferrariAduoInstalled: false, ferrariTurboDebated: false, log: [] };
  state.fiaMeeting.ferrariTurboSpoolSeconds ??= 0;
  state.fiaMeeting.ferrariAduoInstalled ??= (state.teams.ferrari?.puHomologations ?? 0) > 0;
  state.fiaMeeting.ferrariTurboDebated ??= state.fiaMeeting.ferrariAduoInstalled || state.fiaMeeting.current?.issue === 'ferrari_turbo';
  if (state.fiaMeeting.current) {
    state.fiaMeeting.current.supporters ??= [];
    state.fiaMeeting.current.forcedStance ??= null;
  }
  if (state.ferrari) {
    state.ferrari.aduoAlliance ??= false;
    state.ferrari.aduoLobbyGranted ??= false;
  }
  if (state.mclaren) state.mclaren.weeksTotal ??= state.mclaren.weeksLeft;
  state.rules.ferrari ??= deepClone(DEFAULT_RULES.ferrari);
  state.rules.astonMartin ??= deepClone(DEFAULT_RULES.astonMartin);
  state.rules.racingBulls ??= deepClone(DEFAULT_RULES.racingBulls);
  state.rules.audi ??= deepClone(DEFAULT_RULES.audi);
  state.rules.fiaMeeting ??= deepClone(DEFAULT_RULES.fiaMeeting);
  state.rules.alpine ??= deepClone(DEFAULT_RULES.alpine);
  state.rules.haas ??= deepClone(DEFAULT_RULES.haas);
  state.rules.williams ??= deepClone(DEFAULT_RULES.williams);
  state.rules.randomEvents ??= deepClone(DEFAULT_RULES.randomEvents);
  state.rules.practiceReturnSets ??= DEFAULT_RULES.practiceReturnSets;
  state.rules.performance ??= deepClone(DEFAULT_RULES.performance);
  fillMissing(state.rules.performance as unknown as Record<string, unknown>, DEFAULT_RULES.performance as unknown as Record<string, unknown>);
  fillMissing(state.rules.ferrari as unknown as Record<string, unknown>, DEFAULT_RULES.ferrari as unknown as Record<string, unknown>);
  fillMissing(state.rules.astonMartin as unknown as Record<string, unknown>, DEFAULT_RULES.astonMartin as unknown as Record<string, unknown>);
  fillMissing(state.rules.racingBulls as unknown as Record<string, unknown>, DEFAULT_RULES.racingBulls as unknown as Record<string, unknown>);
  fillMissing(state.rules.audi as unknown as Record<string, unknown>, DEFAULT_RULES.audi as unknown as Record<string, unknown>);
  fillMissing(state.rules.fiaMeeting as unknown as Record<string, unknown>, DEFAULT_RULES.fiaMeeting as unknown as Record<string, unknown>);
  fillMissing(state.rules.alpine as unknown as Record<string, unknown>, DEFAULT_RULES.alpine as unknown as Record<string, unknown>);
  fillMissing(state.rules.haas as unknown as Record<string, unknown>, DEFAULT_RULES.haas as unknown as Record<string, unknown>);
  fillMissing(state.rules.williams as unknown as Record<string, unknown>, DEFAULT_RULES.williams as unknown as Record<string, unknown>);
  fillMissing(state.rules.randomEvents as unknown as Record<string, unknown>, DEFAULT_RULES.randomEvents as unknown as Record<string, unknown>);
  const playerTeam = state.teams[state.meta?.playerTeamId];
  if (playerTeam) {
    const missing = {
      ferrari: !state.ferrari,
      mclaren: !state.mclaren,
      mercedes: !state.mercedes,
      redBull: !state.redBull,
      astonMartin: !state.astonMartin,
      audi: !state.audi,
      alpine: !state.alpine,
    };
    const ferrariMedia = state.teams.ferrari?.mediaReputation;
    const progressedSave = state.season.number > 1 || state.season.roundIndex > 0 || state.season.week > 1;
    initFerrari(state, true);
    initTeamSpecials(state, true);
    initNextTeamSpecials(state, true);
    initManagementSpecials(state, true);
    if (progressedSave) {
      if (missing.ferrari && !state.teams.ferrari?.isPlayer && ferrariMedia !== undefined) state.teams.ferrari.mediaReputation = ferrariMedia;
      if (missing.mclaren && !state.teams.mclaren?.isPlayer && state.mclaren) Object.assign(state.mclaren, { softwareResolved: true, route: 'independent', weeksLeft: 0, weeksTotal: 0 });
      if (missing.mercedes && !state.teams.mercedes?.isPlayer && state.mercedes) Object.assign(state.mercedes, { aduoApproved: true, aduoProgress: 100 });
      if (missing.redBull && !state.teams.red_bull?.isPlayer && state.redBull) Object.assign(state.redBull, { summerChecked: true, gpRetention: 100 });
      if (missing.astonMartin && !state.teams.aston_martin?.isPlayer && state.astonMartin) Object.assign(state.astonMartin, { aduoEngineArrived: true, aduoProgress: 100 });
      if (missing.audi && !state.teams.audi?.isPlayer && state.audi) Object.assign(state.audi, { turboFixed: true, alliance: true, aduoProgress: 100 });
      if (missing.alpine && !state.teams.alpine?.isPlayer) settleLegacyAlpinePenalty(state);
    }
  }
  if (legacyEventsDisabled || configuredEventsDisabled) {
    state.rules.randomEvents.routineWeight = 0;
    state.rules.randomEvents.minPerWeek = 0;
    state.rules.randomEvents.maxPerWeek = 0;
  } else if (!hadRoutineEventWeight) {
    const randomRules = state.rules.randomEvents;
    const problemWeight = randomRules.driverInjuryWeight + randomRules.windTunnelWeight + randomRules.partIssueWeight;
    randomRules.routineWeight = problemWeight > 0 ? problemWeight * 4 : 80;
  }
  if (!legacyEventsDisabled && !configuredEventsDisabled) {
    state.rules.randomEvents.minPerWeek = 1;
    state.rules.randomEvents.maxPerWeek = 1;
  }
  if (state.randomEvents.weekKey !== null) {
    state.randomEvents.weeklyQuota = state.rules.randomEvents.maxPerWeek === 0 ? 0 : 1;
  }
  // Market rules are a closed map, unlike parts/tyres. Modern saves take the
  // puAllocation fast path below, so fill this before that return.
  state.rules.market ??= deepClone(DEFAULT_RULES.market);
  fillMissing(state.rules.market as unknown as Record<string, unknown>, DEFAULT_RULES.market as unknown as Record<string, unknown>);
  // Market migration intentionally precedes the modern-save early return below.
  // It derives stable IDs/preferences without changing funds, results, or RNG.
  const hadMarket = !!state.market;
  ensureMarket(state);
  replaceLegacyStaffPlaceholders(state);
  migrateStrategyAndRainBalance(state);
  if (!hadMarket && state.season?.phase === 'season_end') openMarket(state, state.season.year + 1);
  // Live race is additive and must be initialized before the legacy early return.
  // Never synthesize a session or consume RNG while loading an older save.
  if (state.weekend && state.weekend.liveRace === undefined) state.weekend.liveRace = null;
  if (state.season && state.season.weeksUntilRound === undefined) state.season.weeksUntilRound = 0;
  if (state.weekend) {
    // The former format stored only one result. Preserve it as FP1 rather than
    // discarding a completed session or forcing an already-advanced save back
    // into the new three-session flow.
    if (!Array.isArray(state.weekend.practiceSessions)) {
      state.weekend.practiceSessions = state.weekend.practice ? [state.weekend.practice] : [];
    }
    if (!state.weekend.practice && state.weekend.practiceSessions.length) {
      state.weekend.practice = state.weekend.practiceSessions[state.weekend.practiceSessions.length - 1];
    }
    state.weekend.practiceReturn ??= null;
    for (const plan of Object.values(state.weekend.plans ?? {})) {
      plan.practiceTyre ??= 'auto';
      plan.practiceSetupFocus ??= 'balanced';
    }
    const bias = state.weekend.supernaturalRainBias;
    if (bias !== undefined && (!Number.isFinite(bias) || bias < -0.2 || bias > 0.2)) delete state.weekend.supernaturalRainBias;
    const effects = state.weekend.supernaturalCarEffects;
    if (effects && typeof effects === 'object') {
      for (const [id, value] of Object.entries(effects)) {
        if (!value || !Number.isFinite(value.confidence) || !Number.isFinite(value.tyreKnowledge)) delete effects[id];
        else {
          value.confidence = Math.max(-15, Math.min(15, value.confidence));
          value.tyreKnowledge = Math.max(-15, Math.min(15, value.tyreKnowledge));
        }
      }
    } else delete state.weekend.supernaturalCarEffects;
    for (const setup of Object.values(state.weekend.setup ?? {})) {
      setup.confidence = Number.isFinite(setup.confidence) ? Math.max(0, Math.min(100, setup.confidence)) : 0;
      setup.tyreKnowledge = Number.isFinite(setup.tyreKnowledge) ? Math.max(0, Math.min(100, setup.tyreKnowledge)) : 0;
      setup.thermalKnowledge = Number.isFinite(setup.thermalKnowledge) ? Math.max(0, Math.min(100, setup.thermalKnowledge!)) : Math.round(setup.tyreKnowledge * .75);
      setup.trackKnowledge = Number.isFinite(setup.trackKnowledge) ? Math.max(0, Math.min(100, setup.trackKnowledge!)) : Math.round(setup.confidence * .75);
      setup.qualiBonus = Number.isFinite(setup.qualiBonus) ? Math.max(0, Math.min(state.rules.performance.qualiBonusMax, setup.qualiBonus)) : 0;
    }
    if (state.weekend.practiceBaseline && typeof state.weekend.practiceBaseline !== 'object') delete state.weekend.practiceBaseline;
  }
  for (const track of Object.values(state.tracks ?? {})) {
    track.surfaceTemperature = Number.isFinite(track.surfaceTemperature) ? Math.max(10, Math.min(65, track.surfaceTemperature!)) : 32;
    track.thermalDemand = Number.isFinite(track.thermalDemand) ? Math.max(0, Math.min(100, track.thermalDemand!)) : track.tyreStress;
    if (!isValidQualifyingSectors(track.qualifyingSectors)) track.qualifyingSectors = fallbackQualifyingSectors(track);
  }
  for (const tyre of Object.values(state.rules.tyres ?? {})) {
    const fallback: [number, number] = tyre.wet ? [58, 78] : [80, 105];
    if (!Array.isArray(tyre.temperatureWindow) || tyre.temperatureWindow.length !== 2 || !tyre.temperatureWindow.every(Number.isFinite) || tyre.temperatureWindow[0] < 20 || tyre.temperatureWindow[1] > 140 || tyre.temperatureWindow[0] >= tyre.temperatureWindow[1]) tyre.temperatureWindow = fallback;
    if (!Number.isFinite(tyre.warmupRate) || tyre.warmupRate! < .05 || tyre.warmupRate! > 1) tyre.warmupRate = tyre.wet ? .4 : .32;
  }
  const dryWindows: Record<string, [number, number]> = { soft: [80, 100], medium: [85, 105], hard: [90, 110] };
  const namedDry = ['soft', 'medium', 'hard'].map(key => state.rules.tyres[key]);
  if (namedDry.every(Boolean) && !(namedDry[0].temperatureWindow![0] < namedDry[1].temperatureWindow![0] && namedDry[1].temperatureWindow![0] < namedDry[2].temperatureWindow![0])) {
    for (const [key, window] of Object.entries(dryWindows)) state.rules.tyres[key].temperatureWindow = window;
  }
  const aduoPartsBeforePuMigration = new Set([...(state.rules.aduo?.parts ?? []), 'power_unit', 'ers']);
  const activePuDesignsBeforeMigration = new Map(Object.values(state.teams).map(team => [
    team.id,
    team.projects.filter(project => project.kind === 'design' && project.partType && aduoPartsBeforePuMigration.has(project.partType)).length,
  ]));
  migrateSixPartPowerUnit(state);
  if (state.weekend?.liveQualifying) {
    const raw = state.weekend.liveQualifying as unknown;
    const history = qualifyingCheckpointHistory(state, raw);
    if (!history || history.kind !== state.season.phase) {
      // Completed history cannot be verified, so retain the established policy
      // of rejecting the whole invalid live checkpoint rather than guessing.
      state.weekend.liveQualifying = null;
    } else if (history.version === 1) {
      // V1 only persisted the boundary between fully-settled segments. Its
      // tyres, PU wear, results, and outer RNG were already accounted for.
      state.weekend.liveQualifying = qualifyingRecoveryBoundary(state, history, raw as Record<string, unknown>, false) as LiveQualifyingState;
    } else if (!hasValidLiveQualifyingPrivateState(state, raw as Record<string, unknown>, history)) {
      // Never replay a partial timed run. Preserve verified prior segments and
      // make the next one an explicitly paused automatic recovery boundary.
      state.weekend.liveQualifying = qualifyingRecoveryBoundary(state, history, raw as Record<string, unknown>, true) as LiveQualifyingState;
    }
  }
  if (state.weekend?.liveRace) {
    const live = state.weekend.liveRace;
    // Do not attempt to resume malformed or incompatible private simulation data.
    if (live.version !== 1 || !live.id || !Array.isArray(live.weatherTrajectory) || !live.cars || !Number.isFinite(live.rngState) || live.completedLaps < 0 || live.completedLaps > live.totalLaps) state.weekend.liveRace = null;
    else {
      // A missing marker means this session began before the unified model.
      // Never mutate its frozen values or rerun a start sequence.
      live.physicsVersion ??= 1;
      live.strategistSkill ??= state.teams[state.meta.playerTeamId]?.staff.strategist.skill ?? 50;
      live.redFlags ??= 0;
      live.redFlag ??= null;
      live.specialIncidents ??= [];
      live.norrisTeammateRollDone ??= false;
      // Old wet grids could omit delegated player cars (or the window entirely).
      // Reopen only an unresolved grid; ready/running saves keep their fitted tyres.
      if (requiresWetGridTyreChoice(live)) {
        const eligible = Object.values(live.cars).filter(car => car.player && car.status === 'running').map(car => car.driverId);
        live.pendingDecision = eligible.length ? {
          id: live.pendingDecision?.id ?? `${live.id}:w1`,
          lap: 0,
          stage: 'grid',
          reasons: ['grid'],
          affectedDriverIds: eligible,
          eligibleDriverIds: eligible,
          observedEventIds: live.pendingDecision?.observedEventIds ?? [],
        } : null;
      }
      for (const car of Object.values(live.cars)) {
        const driver = state.drivers[car.driverId];
        car.trust ??= driver?.trust ?? 50;
        car.ego ??= driver?.ego ?? 50;
        car.stayOutUntilLap ??= 0;
        car.pendingCompound ??= null;
        const team = state.teams[car.teamId];
        const engineer = car.slot === 2 ? (team?.staff.raceEngineer2 ?? team?.staff.raceEngineer) : team?.staff.raceEngineer;
        car.raceEngineerReaction ??= engineer?.abilities?.reaction ?? engineer?.skill ?? 50;
        car.raceEngineerWeather ??= engineer?.abilities?.weather ?? engineer?.skill ?? 50;
        car.iceHealth ??= 100;
        car.electricalHealth ??= 100;
        car.puTemperature ??= 78;
        car.puStatus ??= 'normal';
        car.ersPerformance ??= 1;
        car.iceReliability ??= car.reliability;
        car.electricalReliability ??= car.reliability;
        car.puComponentHealth ??= Object.fromEntries([
          ...PU_COMBUSTION_PARTS.map(type => [type, car.iceHealth]),
          ...PU_ELECTRICAL_PARTS.map(type => [type, car.electricalHealth]),
        ]);
        car.puComponentReliability ??= Object.fromEntries([
          ...PU_COMBUSTION_PARTS.map(type => [type, car.iceReliability]),
          ...PU_ELECTRICAL_PARTS.map(type => [type, car.electricalReliability]),
        ]);
        if (live.physicsVersion === 2) {
          car.tyreWearAge ??= car.tyreAge;
          const tyre = state.rules.tyres[car.tyre];
          car.tyreTemperature ??= (tyre?.temperatureWindow?.[0] ?? (tyre?.wet ? 58 : 80)) - 18;
          if (car.performanceContext) car.performanceContext.tyreStress ??= state.tracks[state.calendar[live.roundIndex]?.trackId]?.tyreStress ?? 50;
        }
      }
    }
  }
  // ADUO（2026-10 新增）：旧存档没有厂商车队信息，按「各车队自行研发」处理
  if (state.rules.puAllocation && !state.rules.aduo) state.rules.aduo = deepClone(DEFAULT_RULES.aduo);
  state.aduo ??= { evaluations: [] };
  const legacyAduoLifecycle = !!state.rules.aduo && Object.values(state.teams).some(team =>
    state.rules.aduo.parts.some(partType => team.parts[partType]?.specs.some(spec => spec.homologated === undefined)),
  );
  const legacyBaseUpgrades = legacyAduoLifecycle && state.rules.aduo.baseUpgrades === 1 ? 1 : 0;
  if (legacyAduoLifecycle && state.rules.aduo.baseUpgrades === 1) state.rules.aduo.baseUpgrades = 0;
  for (const team of Object.values(state.teams)) {
    const crew = team.staff.pitCrew.skill;
    team.pitCrewTraining ??= { speed: crew, consistency: crew, error_control: crew };
    for (const focus of ['speed', 'consistency', 'error_control'] as const) {
      const value = team.pitCrewTraining[focus];
      team.pitCrewTraining[focus] = Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : crew;
    }
    if (!team.staff.raceEngineer2) {
      const first = team.staff.raceEngineer;
      team.staff.raceEngineer2 = { ...deepClone(first), id: `${team.id}-raceEngineer2`, role: 'raceEngineer2', name: `${first.name || team.name}（二号车）`, salary: 0, preference: first.preference ? { ...first.preference } : undefined };
    }
    team.worksTeam ??= false;
    if (legacyAduoLifecycle && state.rules.aduo) {
      // 旧版在研发开工时计数。进行中的项目尚未生成规格，因此返还其误占的次数。
      const activePuDesigns = activePuDesignsBeforeMigration.get(team.id) ?? 0;
      team.puHomologations = Math.max(0, (team.puHomologations ?? activePuDesigns) - activePuDesigns);
      // 已交付旧规格视为获批；旧基础机会转成祖父条款机会，进行中项目完成后仍可装车。
      const legacyTotal = legacyBaseUpgrades + (team.aduoUpgrades ?? 0);
      team.aduoUpgrades = Math.max(legacyTotal, team.puHomologations);
    } else team.puHomologations ??= 0;
    for (const parts of Object.values(team.parts)) {
      for (const spec of parts.specs) spec.homologated ??= true;
    }
    team.aduoUpgrades ??= 0;
    team.aduoCapBonus ??= 0;
    team.aduoTier ??= 0;
  }
  if (!state.rules.fullWetCompound) {
    const defaultKey = DEFAULT_RULES.fullWetCompound;
    const existing = state.rules.tyres[defaultKey];
    let fallbackKey = 'full_wet';
    let suffix = 2;
    while (state.rules.tyres[fallbackKey] || fallbackKey === state.rules.wetCompound) fallbackKey = `full_wet_${suffix++}`;
    state.rules.fullWetCompound = existing && (!existing.wet || defaultKey === state.rules.wetCompound) ? fallbackKey : defaultKey;
    state.rules.tyres[state.rules.fullWetCompound] ??= deepClone(DEFAULT_RULES.tyres[DEFAULT_RULES.fullWetCompound]);
  }
  if (state.rules.tyres[state.rules.wetCompound]?.name === '雨胎') state.rules.tyres[state.rules.wetCompound].name = '半雨胎';
  migrateTyreInventory(state);
  for (const team of Object.values(state.teams)) for (const inventory of Object.values(team.tyreInventory ?? {})) {
    for (const set of inventory) set.wearAge = Number.isFinite(set.wearAge) ? Math.max(0, set.wearAge!) : Math.max(0, set.laps);
  }
  if (state.weekend?.practiceReturn) {
    const team = state.teams[state.meta.playerTeamId];
    const key = `${state.season.year}:r${state.weekend.roundIndex + 1}`;
    state.weekend.practiceReturn.eligibleSetIds ??= Object.fromEntries(state.weekend.practiceReturn.driverIds.map(driverId => [driverId, (team?.tyreInventory?.[driverId] ?? []).filter(set => set.weekendKey === key && !set.returned).map(set => set.id)]));
  }
  // 已经是 2026 规则的存档（有 puAllocation）不再补规则：玩家可能在世界书里有意删掉了某些默认项
  if (state.rules.puAllocation) return state;
  fillMissing(state.rules as unknown as Record<string, unknown>, DEFAULT_RULES as unknown as Record<string, unknown>, true);
  migrateSixPartPowerUnit(state);
  for (const type of PU_PART_TYPES) state.rules.parts[type] ??= deepClone(DEFAULT_RULES.parts[type]);
  for (const pt of Object.keys(state.rules.puAllocation)) if (!state.rules.parts[pt]) delete state.rules.puAllocation[pt];

  for (const team of Object.values(state.teams)) {
    for (const pt of Object.keys(state.rules.parts)) {
      if (!team.parts[pt]) {
        const id = `${pt}-S${state.season?.number ?? 1}m`;
        team.parts[pt] = {
          specs: [{ id, type: pt, version: 1, perf: 70, rel: 80, verified: true, expected: null, homologated: true, introduced: '存档升级' }],
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
