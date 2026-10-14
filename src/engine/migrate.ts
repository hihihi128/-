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
import type { GameState, StaffRole } from './types';
import { deepClone } from './util';

/** 玩家可以自由增删条目的规则表：不能按默认值回填，否则会恢复被有意删除的零件 / 轮胎 */
const OPEN_MAPS = new Set(['parts', 'tyres']);

const LEGACY_PU_MAP = {
  power_unit: PU_COMBUSTION_PARTS,
  ers: PU_ELECTRICAL_PARTS,
} as const;

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
  state.fiaMeeting ??= { politicalCapital: state.rules.fiaMeeting?.startPoliticalCapital ?? 50, completed: 0, current: null, log: [] };
  if (state.mclaren) state.mclaren.weeksTotal ??= state.mclaren.weeksLeft;
  state.rules.astonMartin ??= deepClone(DEFAULT_RULES.astonMartin);
  state.rules.racingBulls ??= deepClone(DEFAULT_RULES.racingBulls);
  state.rules.audi ??= deepClone(DEFAULT_RULES.audi);
  state.rules.fiaMeeting ??= deepClone(DEFAULT_RULES.fiaMeeting);
  state.rules.alpine ??= deepClone(DEFAULT_RULES.alpine);
  state.rules.haas ??= deepClone(DEFAULT_RULES.haas);
  state.rules.williams ??= deepClone(DEFAULT_RULES.williams);
  state.rules.randomEvents ??= deepClone(DEFAULT_RULES.randomEvents);
  state.rules.practiceReturnSets ??= DEFAULT_RULES.practiceReturnSets;
  fillMissing(state.rules.astonMartin as unknown as Record<string, unknown>, DEFAULT_RULES.astonMartin as unknown as Record<string, unknown>);
  fillMissing(state.rules.racingBulls as unknown as Record<string, unknown>, DEFAULT_RULES.racingBulls as unknown as Record<string, unknown>);
  fillMissing(state.rules.audi as unknown as Record<string, unknown>, DEFAULT_RULES.audi as unknown as Record<string, unknown>);
  fillMissing(state.rules.fiaMeeting as unknown as Record<string, unknown>, DEFAULT_RULES.fiaMeeting as unknown as Record<string, unknown>);
  fillMissing(state.rules.alpine as unknown as Record<string, unknown>, DEFAULT_RULES.alpine as unknown as Record<string, unknown>);
  fillMissing(state.rules.haas as unknown as Record<string, unknown>, DEFAULT_RULES.haas as unknown as Record<string, unknown>);
  fillMissing(state.rules.williams as unknown as Record<string, unknown>, DEFAULT_RULES.williams as unknown as Record<string, unknown>);
  fillMissing(state.rules.randomEvents as unknown as Record<string, unknown>, DEFAULT_RULES.randomEvents as unknown as Record<string, unknown>);
  if (legacyEventsDisabled) {
    state.rules.randomEvents.routineWeight = 0;
    state.rules.randomEvents.minPerWeek = 0;
    state.rules.randomEvents.maxPerWeek = 0;
  } else if (!hadRoutineEventWeight) {
    const randomRules = state.rules.randomEvents;
    const problemWeight = randomRules.driverInjuryWeight + randomRules.windTunnelWeight + randomRules.partIssueWeight;
    randomRules.routineWeight = problemWeight > 0 ? problemWeight * 4 : 80;
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
  }
  const aduoPartsBeforePuMigration = new Set([...(state.rules.aduo?.parts ?? []), 'power_unit', 'ers']);
  const activePuDesignsBeforeMigration = new Map(Object.values(state.teams).map(team => [
    team.id,
    team.projects.filter(project => project.kind === 'design' && project.partType && aduoPartsBeforePuMigration.has(project.partType)).length,
  ]));
  migrateSixPartPowerUnit(state);
  if (state.weekend?.liveRace) {
    const live = state.weekend.liveRace;
    // Do not attempt to resume malformed or incompatible private simulation data.
    if (live.version !== 1 || !live.id || !Array.isArray(live.weatherTrajectory) || !live.cars || !Number.isFinite(live.rngState) || live.completedLaps < 0 || live.completedLaps > live.totalLaps) state.weekend.liveRace = null;
    else {
      live.strategistSkill ??= state.teams[state.meta.playerTeamId]?.staff.strategist.skill ?? 50;
      live.redFlags ??= 0;
      live.redFlag ??= null;
      live.specialIncidents ??= [];
      live.norrisTeammateRollDone ??= false;
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
      }
    }
  }
  // ADUO（2026-10 新增）：旧存档没有厂商车队信息，按「各车队自行研发」处理
  if (state.rules.puAllocation && !state.rules.aduo) state.rules.aduo = deepClone(DEFAULT_RULES.aduo);
  state.aduo ??= { evaluations: [] };
  const legacyAduoLifecycle = !!state.rules.aduo && Object.values(state.teams).some(team =>
    state.rules.aduo.parts.some(partType => team.parts[partType]?.specs.some(spec => spec.homologated === undefined)),
  );
  const legacyBaseUpgrades = legacyAduoLifecycle ? state.rules.aduo.baseUpgrades : 0;
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
