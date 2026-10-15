/**
 * 视图模型：把存档加工成前端直接可用的数据（评分、排名、预览、标签）。
 * 前端只读视图、只通过动作修改存档，保证所有规则都在引擎里。
 */
import {
  aduoWeeksMul,
  engineLabel,
  homologationsLeft,
  homologationsTotal,
  isPuCustomer,
  nextEvalRound,
  tierName,
  worksTeamFor,
} from './aduo';
import { AMBITIONS, FACILITIES, LABELS, STAFF_ROLES } from './defaults';
import { ferrariTurboAdvantageActive } from './nextTeamSpecials';
import { isPowerUnitPart } from './powerunit';
import {
  allocationGap,
  previewFacility,
  previewPitTraining,
  previewProject,
  rankOfTeam,
  rndSlots,
  type ProjectPreview,
} from './development';
import { annualSalaries, capRemaining, costCapOf } from './finance';
import { fanCamps, fanGap } from './ferrari';
import { dismissalReason } from './teamSpecials';
import { effectiveSetup, SUPERNATURAL_LIMITS } from './supernatural';
import { teammateRelationship } from './driverBehavior';
import { requiresWetGridTyreChoice } from './race';
import { describeLog } from './protocol';
import { carRatings, disclosedPerf, driverOverall, findSpec, moraleLabel, teamPaceRanking, trackScore, type CarRatings } from './ratings';
import { nextActionFor, sortedDrivers, sortedTeams, type NextAction } from './season';
import { degFactor, predictedTyreLife, strategyOptions, type StrategyOption } from './strategy';
import { canRunTyreStrategy, weekendTyreKey } from './tyres';
import { buildPerformanceContext, practiceEffects } from './performance';
import type {
  DriverState,
  GameState,
  Phase,
  Project,
  RaceResult,
  QualiResult,
  PracticeResult,
  TeamState,
  TrackDef,
  WeekendState,
  Weather,
  DriverPlan,
  SetupState,
  RoundSummary,
} from './types';
import { round1 } from './util';
import { predictedStationaryTime } from './pitstop';
import { currentRound } from './weekend';
import { marketCloseBlockers } from './market';

export interface PartView {
  type: string;
  name: string;
  specId: string;
  version: number;
  /** 已验证时为真实性能，否则为预估区间中值 */
  perf: number;
  rel: number;
  verified: boolean;
  expected: [number, number] | null;
  homologated: boolean;
}

export interface CarView {
  slot: number;
  driverId: string | null;
  driverName: string;
  ratings: CarRatings;
  trackScore: number | null;
  parts: PartView[];
}

export interface StockView {
  partType: string;
  partName: string;
  specId: string;
  version: number;
  count: number;
  perf: number;
  rel: number;
  verified: boolean;
  expected: [number, number] | null;
  homologated: boolean;
  fittedOn: number[];
}

export interface ProjectView extends Project {
  progress: number;
}

export interface DriverView {
  id: string;
  name: string;
  short: string;
  number: number;
  nationality: string;
  age: number;
  teamId: string | null;
  teamName: string;
  teamColor: string;
  role: 'race' | 'reserve';
  attrs: DriverState['attrs'];
  overall: number;
  potential: number;
  morale: number;
  moraleLabel: string;
  fitness: number;
  trust: number;
  affinity: number;
  form: number;
  ego: number;
  salary: number;
  contractEnd: number;
  traits: string[];
  description: string;
  points: number;
  position: number | null;
  wins: number;
  podiums: number;
  isPlayerTeam: boolean;
  isPriority: boolean;
  slot: number | null;
  /** 动力单元配额：已用 / 上限（只列出 rules.puAllocation 中的零件） */
  pu: Array<{ type: string; name: string; used: number; limit: number; health: number }>;
}

export interface FerrariView {
  media: number;
  minMedia: number;
  warnMedia: number;
  fans: Array<{ driverId: string; name: string; value: number }>;
  gap: number;
  maxFanGap: number;
  warnFanGap: number;
  dismissed: string | null;
  /** 还剩几站适应期（适应期内不会被撤职） */
  graceLeft: number;
  log: Array<{ at: string; text: string }>;
  aduoAlliance: boolean;
  aduoLobbyGranted: boolean;
  turboStartGainMin: number;
  turboStartGainMax: number;
  turboSpoolSeconds: number;
  turboAdvantageActive: boolean;
}

export interface AduoView {
  enabled: boolean;
  /** 玩家车队使用的动力单元 */
  engine: string;
  /** 玩家是客户车队时的供应商（厂商车队）名称 */
  supplier: string | null;
  isWorks: boolean;
  isCustomer: boolean;
  /** 以下是负责研发的车队（玩家或供应商）的状态 */
  upgradesUsed: number;
  upgradesTotal: number;
  upgradesLeft: number;
  tier: number;
  tierName: string;
  capBonus: number;
  /** 当前公开档位对应的动力单元研发周期倍率 */
  weeksMultiplier: number;
  /** 受 ADUO 认证与客户供应限制的零件 */
  developmentParts: string[];
  evalRounds: number[];
  nextEvalRound: number | null;
  /** 最近一次评估（round = 0 是季前基准，不产生效果） */
  last: { round: number; results: AduoRowView[] } | null;
  /** 门槛（%） */
  tier1Deficit: number;
  tier2Deficit: number;
}

export interface AduoRowView {
  engine: string;
  worksTeam: string | null;
  deficitPct: number;
  tier: number;
  tierName: string;
  isPlayer: boolean;
}

export interface WeekendDriverView {
  driverId: string;
  driverName: string;
  plan: DriverPlan;
  setup: SetupState;
  performance?: { trackFit: number; practice: { quali: number; race: number; wearMultiplier: number } };
  performanceSummary?: { qualiGain: number; raceGain: number; wearDelta: number; trackFit: number; trackKnowledge: number; tyres: Record<string, { temperatureWindow: [number, number]; warmupRate: number }> };
  supernaturalSetup?: { base: SetupState; offset: { confidence: number; tyreKnowledge: number }; expires: string };
  options: StrategyOption[];
  sprintOptions: StrategyOption[];
  tyreLife: Record<string, number>;
  tyreSets: Array<{ id: string; compound: string; state: 'new' | 'used'; laps: number; returned: boolean; returnEligible: boolean }>;
}

function tyreThermalState(state: GameState, car: import('./types').LiveRaceCar): 'cold' | 'optimal' | 'hot' {
  const [low, high] = state.rules.tyres[car.tyre]?.temperatureWindow ?? [80, 105];
  const temperature = car.tyreTemperature ?? low;
  return temperature < low ? 'cold' : temperature > high ? 'hot' : 'optimal';
}

export type RevealedWeather = Record<keyof WeekendState['weather'], Weather | null>;

const SESSION_ORDER: Phase[] = ['practice', 'sprint_qualifying', 'sprint', 'qualifying', 'race', 'post_race'];

/** 只公开「已经到来」的场次天气，未来场次只给预报，避免剧透 */
export function revealedWeather(w: WeekendState, phase: Phase, isCurrent: boolean): RevealedWeather {
  const idx = isCurrent ? SESSION_ORDER.indexOf(phase) : SESSION_ORDER.length;
  const at = (p: Phase) => idx >= SESSION_ORDER.indexOf(p);
  return {
    practice: at('practice') ? w.weather.practice : null,
    sprintQualifying: at('sprint_qualifying') ? w.weather.sprintQualifying : null,
    sprint: at('sprint') ? w.weather.sprint : null,
    qualifying: at('qualifying') ? w.weather.qualifying : null,
    race: at('race') ? w.weather.race : null,
  };
}

export interface LiveRaceView {
  id: string;
  revision: number;
  kind: 'race' | 'sprint';
  completedLaps: number;
  totalLaps: number;
  stage: string;
  raceControl: 'sc' | 'vsc' | 'red_flag' | null;
  restart: 'standing' | 'rolling' | null;
  weather: { rain: number; surface: 'dry' | 'damp' | 'wet'; forecast: import('./types').RaceForecast };
  timing: Array<{ driverId: string; teamId: string; pos: number | null; status: 'running' | 'dnf'; gap: string; tyre: string; tyreAge: number; tyreTemperature?: number; tyreState?: 'cold' | 'optimal' | 'hot' | 'legacy'; pits: number }>;
  playerCars: Array<{ driverId: string; tyre: string; tyreAge: number; tyreTemperature?: number; tyreThermalState?: 'cold' | 'optimal' | 'hot' | 'legacy'; tyreState: 'new' | 'used'; damage: boolean; partial: boolean; energy: number; paceMode: string; energyMode: string; pitTiming: string; iceHealth: number; electricalHealth: number; weakestPuHealth: number; weakestPuName: string; puTemperature: number; puStatus: string; predictedStationary: number; lastPit: import('./types').PitStopRecord | null }>;
  events: Array<{ id: string; lap: number; type: string; text: string; drivers: string[]; driverNames: string[]; key: boolean }>;
  pendingDecision: { id: string; lap: number; reasons: string[]; eligibleDriverIds: string[]; expectedPitLoss: number; startTyreOptions?: import('./types').Compound[] } | null;
  teamOrders: import('./types').TeamOrders;
}

export interface WeekendView {
  roundIndex: number;
  isCurrent: boolean;
  weather: RevealedWeather;
  forecast: WeekendState['forecast'];
  parcFerme: boolean;
  teamOrders: WeekendState['teamOrders'];
  /** 由两位车手当前信任、心态与自尊推算。 */
  teammateRelationship: number;
  penalties: Record<string, number>;
  drivers: WeekendDriverView[];
  /** Individual FP results, including a migrated legacy result as FP1. */
  practiceSessions: PracticeResult[];
  practiceSessionTotal: number;
  /** Latest practice result retained for consumers of the old view shape. */
  practice: PracticeResult | null;
  practiceReturn: { required: number; driverIds: string[] } | null;
  liveQualifying: WeekendState['liveQualifying'];
  sprintQualifying: QualiResult | null;
  sprint: RaceResult | null;
  qualifying: QualiResult | null;
  race: RaceResult | null;
  /** Explicit public projection; never exposes trajectory, RNG, rival energy or plans. */
  liveRace: LiveRaceView | null;
}

export interface MarketView {
  revision: number;
  status: 'none' | 'open' | 'ai_resolved' | 'closed';
  window: { id: string; targetYear: number; status: string; aiResolved: boolean } | null;
  closeBlockers: string[];
  current: { raceSeats: Record<string, string | null>; reserveIds: string[]; staff: Record<string, string | null> } | null;
  projected: { raceSeats: Record<string, string | null>; reserveIds: string[]; staff: Record<string, string | null> } | null;
  drivers: Array<{ id: string; name: string; teamId: string | null; role: string; overall: number; salary: number; contractEnd: number; series?: string; description: string; preference: { askingSalary: number; preferredYears: number; desiredStrength: number; preferredTeamId: string | null; acceptsReserve: boolean } }>;
  staff: Array<{ id: string; name: string; role: string; teamId: string | null; skill: number; abilities?: import('./types').StaffMember['abilities']; salary: number; contractEnd: number; series?: string; description?: string; preference: { askingSalary: number; preferredYears: number; desiredStrength: number; preferredTeamId: string | null } }>;
  agreements: Array<{ personId: string; toTeamId: string; role: string; annualSalary: number; endYear: number }>;
}

export interface GameView {
  gameId: string;
  meta: GameState['meta'];
  season: GameState['season'] & { rounds: number; phaseLabel: string };
  next: NextAction | null;
  round: { index: number; name: string; sprint: boolean; dateLabel: string; weeksGap: number; track: TrackDef } | null;
  player: {
    team: TeamState;
    rank: number;
    points: number;
    leaderPoints: number;
    capRemaining: number;
    /** 本赛季预算帽（含 ADUO 追加额度） */
    costCap: number;
    annualSalaries: number;
    rndSlots: number;
    allocationGap: number;
    cars: CarView[];
    stock: StockView[];
    projects: ProjectView[];
    rndOptions: ProjectPreview[];
    facilities: Array<{ id: string; name: string; level: number; max: number; preview: ReturnType<typeof previewFacility> }>;
    staff: Array<{ role: string; label: string; name: string; skill: number; abilities?: import('./types').StaffMember['abilities']; salary: number }>;
    pitTraining: Record<import('./types').PitCrewFocus, ReturnType<typeof previewPitTraining>>;
  };
  teams: Array<{ id: string; name: string; short: string; color: string; isPlayer: boolean; points: number; rank: number; carOverall: number; trackScore: number | null; paceRank: number | null }>;
  drivers: DriverView[];
  standings: {
    drivers: Array<{ pos: number; driverId: string; name: string; teamId: string | null; teamName: string; color: string; points: number; wins: number; podiums: number; results: Array<number | 'DNF' | null> }>;
    teams: Array<{ pos: number; teamId: string; name: string; color: string; points: number; wins: number; podiums: number }>;
  };
  calendar: Array<{ index: number; id: string; name: string; trackName: string; trackType: string; sprint: boolean; dateLabel: string; status: 'done' | 'current' | 'upcoming'; winner: string | null; playerBest: number | null }>;
  weekend: WeekendView | null;
  market: MarketView;
  history: RoundSummary[];
  news: GameState['news'];
  narration: GameState['narration'];
  narrated: GameState['narrated'];
  aiLog: Array<GameState['aiLog'][number] & { text: string }>;
  supernatural: {
    enabled: boolean;
    available: boolean;
    reason: string | null;
    categories: Record<'people' | 'team' | 'research' | 'weather' | 'setup', { available: boolean; reason: string | null }>;
    targets: { drivers: Array<{ id: string; name: string; role: string; attrs: GameState['drivers'][string]['attrs'] }>; staff: Array<{ id: string; name: string; role: string }>; projects: Array<{ id: string; label: string; weeksLeft: number }> };
    pendingWeather: { rainBias: number; year: number; roundIndex: number } | null;
    caps: typeof SUPERNATURAL_LIMITS;
  };
  flags: GameState['flags'];
  ferrari: FerrariView | null;
  mclaren: GameState['mclaren'];
  mercedes: GameState['mercedes'];
  redBull: (GameState['redBull'] & { verstappenPosition?: number }) | null;
  specialRules: Pick<GameState['rules'], 'ferrari' | 'mclaren' | 'mercedes' | 'redBull'>;
  astonMartin: GameState['astonMartin'];
  racingBulls: (GameState['racingBulls'] & { candidates?: Array<{ id: string; name: string }> }) | null;
  audi: GameState['audi'];
  alpine: GameState['alpine'];
  haas: GameState['haas'];
  williams: GameState['williams'];
  randomEvents: GameState['randomEvents'];
  fiaMeeting: GameState['fiaMeeting'];
  nextSpecialRules: Pick<GameState['rules'], 'astonMartin' | 'racingBulls' | 'audi' | 'fiaMeeting' | 'alpine' | 'haas' | 'williams'>;
  aduo: AduoView;
  lastSeason: GameState['lastSeason'];
  labels: typeof LABELS & {
    parts: Record<string, string>;
    tyres: Record<string, { name: string; short: string; color: string; wet: boolean }>;
    facilities: Record<string, string>;
    ambition: Record<string, string>;
  };
  rules: {
    costCap: number;
    dryCompounds: string[];
    wetCompound: string;
    fullWetCompound: string;
    mandatoryCompounds: number;
    aiLimits: GameState['rules']['aiLimits'];
    tyres: Record<string, { temperatureWindow: [number, number]; warmupRate: number }>;
  };
}

function partView(team: TeamState, type: string, specId: string, name: string): PartView {
  const s = findSpec(team, type, specId) ?? team.parts[type]?.specs[0];
  const perf = s ? disclosedPerf(s) : 0;
  return {
    type,
    name,
    specId: s?.id ?? specId,
    version: s?.version ?? 0,
    perf,
    rel: s?.rel ?? 0,
    verified: s?.verified ?? true,
    expected: s?.expected ?? null,
    homologated: s?.homologated !== false,
  };
}

function driverView(state: GameState, d: DriverState, positions: Map<string, number>): DriverView {
  const team = d.teamId ? state.teams[d.teamId] : undefined;
  const st = state.standings.drivers[d.id];
  const car = team?.cars.find(c => c.driverId === d.id);
  return {
    id: d.id,
    name: d.name,
    short: d.short,
    number: d.number,
    nationality: d.nationality,
    age: d.age,
    teamId: d.teamId,
    teamName: team?.name ?? '自由车手',
    teamColor: team?.color ?? '#666',
    role: d.role,
    attrs: { ...d.attrs },
    overall: driverOverall(d),
    potential: d.potential,
    morale: d.morale,
    moraleLabel: moraleLabel(d.morale),
    fitness: d.fitness,
    trust: d.trust,
    affinity: d.affinity,
    form: d.form,
    ego: d.ego,
    salary: d.salary,
    contractEnd: d.contractEnd,
    traits: [...d.traits],
    description: d.description,
    points: st?.points ?? 0,
    position: positions.get(d.id) ?? null,
    wins: st?.wins ?? 0,
    podiums: st?.podiums ?? 0,
    isPlayerTeam: d.teamId === state.meta.playerTeamId,
    isPriority: !!team && team.driverPriority === d.id,
    slot: car?.slot ?? null,
    pu: Object.entries(state.rules.puAllocation).map(([type, limit]) => ({
      type,
      name: state.rules.parts[type]?.name ?? type,
      used: d.puUsed?.[type] ?? 1,
      limit,
      health: isPowerUnitPart(type)
        ? Math.max(0, 100 - (car && car.puWear?.[type]?.specId === car.fitted[type] ? car.puWear[type]!.wear : 0))
        : 100,
    })),
  };
}

function aduoView(state: GameState): AduoView {
  const r = state.rules.aduo;
  const team = state.teams[state.meta.playerTeamId];
  const supplier = isPuCustomer(state, team) ? worksTeamFor(state, team)! : null;
  const dev = supplier ?? team;
  const mine = engineLabel(team);
  const rows = (list: Array<{ engine: string; worksTeamId: string | null; deficitPct: number; tier: number }>): AduoRowView[] =>
    list.map(x => ({
      engine: x.engine,
      worksTeam: x.worksTeamId ? (state.teams[x.worksTeamId]?.name ?? x.worksTeamId) : null,
      deficitPct: x.deficitPct,
      tier: x.tier,
      tierName: tierName(x.tier),
      isPlayer: x.engine === mine,
    }));
  const evals = state.aduo?.evaluations ?? [];
  const last = evals.length ? evals[evals.length - 1] : null;
  return {
    enabled: r.enabled,
    engine: mine,
    supplier: supplier?.name ?? null,
    isWorks: !!team.worksTeam,
    isCustomer: !!supplier,
    upgradesUsed: dev.puHomologations ?? 0,
    upgradesTotal: homologationsTotal(state, dev),
    upgradesLeft: homologationsLeft(state, dev),
    tier: dev.aduoTier ?? 0,
    tierName: tierName(dev.aduoTier ?? 0),
    capBonus: dev.aduoCapBonus ?? 0,
    weeksMultiplier: aduoWeeksMul(state, dev, r.measurePart),
    developmentParts: [...r.parts],
    evalRounds: [...r.evalRounds].sort((a, b) => a - b),
    nextEvalRound: nextEvalRound(state),
    last: last ? { round: last.round, results: rows(last.results) } : null,
    tier1Deficit: r.tier1Deficit,
    tier2Deficit: r.tier2Deficit,
  };
}

function ferrariView(state: GameState): FerrariView | null {
  const f = state.ferrari;
  if (!f || state.teams[state.meta.playerTeamId]?.special !== 'ferrari') return null;
  const r = state.rules.ferrari;
  return {
    media: state.teams[state.meta.playerTeamId].mediaReputation,
    minMedia: r.minMedia,
    warnMedia: r.warnMedia,
    fans: fanCamps(f).map(id => ({ driverId: id, name: state.drivers[id]?.name ?? id, value: f.fans[id] })),
    gap: fanGap(f),
    maxFanGap: r.maxFanGap,
    warnFanGap: r.warnFanGap,
    dismissed: f.dismissed,
    graceLeft:
      state.season.number === 1
        ? Math.max(0, r.graceRounds - state.season.roundIndex - (state.weekend?.roundIndex === state.season.roundIndex && state.weekend.race ? 1 : 0))
        : 0,
    log: [...f.log].reverse(),
    aduoAlliance: f.aduoAlliance,
    aduoLobbyGranted: f.aduoLobbyGranted,
    turboStartGainMin: r.turboStartGainMin,
    turboStartGainMax: r.turboStartGainMax,
    turboSpoolSeconds: state.fiaMeeting?.ferrariTurboSpoolSeconds ?? 0,
    turboAdvantageActive: ferrariTurboAdvantageActive(state),
  };
}

function marketView(state: GameState): MarketView {
  const market = state.market ?? { version: 1 as const, revision: 0, freeStaff: {}, window: null, completed: [] };
  const storedWindow = market.window;
  const window = storedWindow?.status === 'closed' ? null : storedWindow;
  const playerId = state.meta.playerTeamId;
  const profile = (p: import('./types').CandidatePreference | undefined, salary: number, id: string) => p ?? { askingSalary: salary, preferredYears: 1, desiredStrength: 50, preferredTeamId: null, loyalty: 0, acceptsReserve: true };
  return {
    revision: market.revision,
    status: storedWindow?.status ?? 'none',
    window: window ? { id: window.id, targetYear: window.targetYear, status: window.status, aiResolved: window.aiResolved } : null,
    closeBlockers: window ? marketCloseBlockers(state) : [],
    current: window ? {
      raceSeats: Object.fromEntries(state.teams[playerId].cars.map(c => [String(c.slot), c.driverId])),
      reserveIds: Object.values(state.drivers).filter(d => d.teamId === playerId && d.role === 'reserve').map(d => d.id),
      staff: Object.fromEntries(STAFF_ROLES.map(role => [role, state.teams[playerId].staff[role]?.id ?? null])),
    } : null,
    projected: window ? { ...window.projectedRosters[playerId], raceSeats: { ...window.projectedRosters[playerId].raceSeats }, reserveIds: [...window.projectedRosters[playerId].reserveIds], staff: { ...window.projectedRosters[playerId].staff } } : null,
    drivers: Object.values(state.drivers).map(d => {
      const p = profile(window?.candidateProfiles[d.id] ?? d.preference, d.salary, d.id);
      return { id: d.id, name: d.name, teamId: d.teamId, role: d.role, overall: driverOverall(d), salary: d.salary, contractEnd: d.contractEnd, series: d.series, description: d.description, preference: { askingSalary: p.askingSalary, preferredYears: p.preferredYears, desiredStrength: p.desiredStrength, preferredTeamId: p.preferredTeamId, acceptsReserve: !!p.acceptsReserve } };
    }),
    staff: [
      ...Object.entries(state.teams).flatMap(([teamId, team]) => Object.values(team.staff).map(s => ({ ...s, teamId }))),
      ...Object.values(market.freeStaff).map(s => ({ ...s, teamId: null })),
    ].map(s => {
      const p = profile(window?.candidateProfiles[s.id!] ?? s.preference, s.salary, s.id!);
      return { id: s.id!, name: s.name || s.id!, role: s.role ?? '', teamId: s.teamId, skill: s.skill, abilities: s.abilities ? { ...s.abilities } : undefined, salary: s.salary, contractEnd: s.contractEnd ?? 0, series: s.series, description: s.description, preference: { askingSalary: p.askingSalary, preferredYears: p.preferredYears, desiredStrength: p.desiredStrength, preferredTeamId: p.preferredTeamId } };
    }),
    agreements: (window?.agreements ?? []).filter(a => a.toTeamId === playerId || a.fromTeamId === playerId).map(a => ({ personId: a.personId, toTeamId: a.toTeamId, role: a.driverRole ?? a.staffRole ?? '', annualSalary: a.annualSalary, endYear: a.endYear })),
  };
}

export function buildView(state: GameState): GameView {
  const rules = state.rules;
  const team = state.teams[state.meta.playerTeamId];
  const roundDef = currentRound(state);
  const track = roundDef ? state.tracks[roundDef.trackId] : undefined;
  const phase: Phase = state.season.phase;
  const showTrack = phase !== 'season_end' && !!track;
  const paceRanking = teamPaceRanking(state, showTrack ? track! : null, 'disclosed');
  const teamRows = sortedTeams(state);
  const driverRows = sortedDrivers(state);
  const driverPos = new Map(driverRows.map((id, i) => [id, i + 1]));

  const partNames = Object.fromEntries(Object.entries(rules.parts).map(([k, v]) => [k, v.name]));
  const cars: CarView[] = team.cars.map(c => {
    const ratings = carRatings(team, c, rules, 'disclosed');
    return {
      slot: c.slot,
      driverId: c.driverId,
      driverName: c.driverId ? state.drivers[c.driverId]?.name ?? c.driverId : '（空）',
      ratings,
      trackScore: showTrack ? round1(trackScore(ratings, track!)) : null,
      parts: Object.keys(rules.parts).map(pt => partView(team, pt, c.fitted[pt], partNames[pt])),
    };
  });

  const stock: StockView[] = [];
  for (const [pt, parts] of Object.entries(team.parts)) {
    for (const s of parts.specs) {
      const fittedOn = team.cars.filter(c => c.fitted[pt] === s.id).map(c => c.slot);
      const count = parts.stock[s.id] ?? 0;
      if (count <= 0 && fittedOn.length === 0) continue;
      stock.push({
        partType: pt,
        partName: partNames[pt] ?? pt,
        specId: s.id,
        version: s.version,
        count,
        perf: disclosedPerf(s),
        rel: s.rel,
        verified: s.verified,
        expected: s.expected,
        homologated: s.homologated !== false,
        fittedOn,
      });
    }
  }

  const projects: ProjectView[] = team.projects.map(p => {
    const { trueGain: _hidden, ...rest } = p;
    return { ...rest, progress: round1(((p.weeksTotal - p.weeksLeft) / Math.max(1, p.weeksTotal)) * 100) };
  });

  // 原始零件规格里未验证新件的真实性能要遮住，面板只能拿到预估值
  const maskedParts = Object.fromEntries(
    Object.entries(team.parts).map(([pt, parts]) => [pt, { ...parts, specs: parts.specs.map(s => ({ ...s, perf: disclosedPerf(s) })) }]),
  );

  const rndOptions: ProjectPreview[] = [];
  for (const pt of Object.keys(rules.parts)) {
    if (!rules.parts[pt].developable) continue;
    for (const amb of AMBITIONS) rndOptions.push(previewProject(state, team.id, pt, amb, false));
  }

  const weekend = buildWeekendView(state);
  const market = marketView(state);

  return {
    gameId: state.gameId,
    meta: state.meta,
    season: { ...state.season, rounds: state.calendar.length, phaseLabel: LABELS.phase[phase] },
    next: dismissalReason(state) ? null : nextActionFor(state),
    round:
      roundDef && track
        ? {
            index: state.season.roundIndex,
            name: roundDef.name || `${track.name}大奖赛`,
            sprint: roundDef.sprint,
            dateLabel: roundDef.dateLabel,
            weeksGap: roundDef.weeksGap,
            track,
          }
        : null,
    player: {
      team: { ...team, parts: maskedParts, projects: projects as Project[] },
      rank: rankOfTeam(state, team.id),
      points: state.standings.teams[team.id]?.points ?? 0,
      leaderPoints: Math.max(0, ...Object.values(state.standings.teams).map(t => t.points)),
      capRemaining: capRemaining(team, rules),
      costCap: costCapOf(team, rules),
      annualSalaries: round1(annualSalaries(state, team)),
      rndSlots: rndSlots(team, rules),
      allocationGap: allocationGap(state, team),
      cars,
      stock,
      projects,
      rndOptions,
      facilities: FACILITIES.map(f => ({
        id: f,
        name: rules.facilities[f].name,
        level: team.facilities[f],
        max: rules.facilities[f].maxLevel,
        preview: previewFacility(state, team.id, f),
      })),
      staff: STAFF_ROLES.map(r => ({ role: r, label: LABELS.staff[r], name: team.staff[r].name, skill: team.staff[r].skill, abilities: team.staff[r].abilities, salary: team.staff[r].salary })),
      pitTraining: {
        speed: previewPitTraining(state, team.id, 'speed'),
        consistency: previewPitTraining(state, team.id, 'consistency'),
        error_control: previewPitTraining(state, team.id, 'error_control'),
      },
    },
    teams: teamRows.map((tid, i) => {
      const t = state.teams[tid];
      const best = Math.max(...t.cars.map(c => carRatings(t, c, rules, 'disclosed').overall), 0);
      const pr = paceRanking.findIndex(p => p.teamId === tid);
      return {
        id: tid,
        name: t.name,
        short: t.short,
        color: t.color,
        isPlayer: t.isPlayer,
        points: state.standings.teams[tid]?.points ?? 0,
        rank: i + 1,
        carOverall: round1(best),
        trackScore: showTrack ? paceRanking[pr]?.score ?? null : null,
        paceRank: showTrack ? pr + 1 : null,
      };
    }),
    drivers: Object.values(state.drivers).map(d => driverView(state, d, driverPos)),
    standings: {
      drivers: driverRows.map((id, i) => {
        const d = state.drivers[id];
        const s = state.standings.drivers[id];
        const t = d?.teamId ? state.teams[d.teamId] : undefined;
        return {
          pos: i + 1,
          driverId: id,
          name: d?.name ?? id,
          teamId: d?.teamId ?? null,
          teamName: t?.name ?? '',
          color: t?.color ?? '#666',
          points: s.points,
          wins: s.wins,
          podiums: s.podiums,
          results: s.results,
        };
      }),
      teams: teamRows.map((tid, i) => ({
        pos: i + 1,
        teamId: tid,
        name: state.teams[tid].name,
        color: state.teams[tid].color,
        points: state.standings.teams[tid]?.points ?? 0,
        wins: state.standings.teams[tid]?.wins ?? 0,
        podiums: state.standings.teams[tid]?.podiums ?? 0,
      })),
    },
    calendar: state.calendar.map((r, i) => {
      const h = state.history.find(x => x.roundIndex === i);
      const t = state.tracks[r.trackId];
      const mine = h ? h.results.filter(([id]) => state.drivers[id]?.teamId === team.id).map(([, pos]) => pos).filter((p): p is number => p !== null) : [];
      const status: 'done' | 'current' | 'upcoming' =
        h ? 'done' : i === state.season.roundIndex && state.season.phase !== 'season_end' ? 'current' : i < state.season.roundIndex ? 'done' : 'upcoming';
      return {
        index: i,
        id: r.id,
        name: r.name || `${t?.name ?? r.trackId}大奖赛`,
        trackName: t?.name ?? r.trackId,
        trackType: t?.type ?? '',
        sprint: r.sprint,
        dateLabel: r.dateLabel,
        status,
        winner: h?.winner ? state.drivers[h.winner]?.name ?? h.winner : null,
        playerBest: mine.length ? Math.min(...mine) : null,
      };
    }),
    weekend,
    market,
    history: state.history,
    news: [...state.news].reverse(),
    narration: state.narration,
    narrated: state.narrated,
    aiLog: [...state.aiLog].reverse().map(e => ({ ...e, text: describeLog(state, e) })),
    supernatural: supernaturalView(state),
    flags: state.flags,
    ferrari: ferrariView(state),
    mclaren: team.special === 'mclaren' ? state.mclaren ?? null : null,
    mercedes: team.special === 'mercedes' ? state.mercedes ?? null : null,
    redBull: team.special === 'red_bull' && state.redBull ? {
      ...state.redBull,
      verstappenPosition: driverPos.get('verstappen') ?? 0,
    } : null,
    specialRules: {
      ferrari: { ...rules.ferrari },
      mclaren: { ...rules.mclaren },
      mercedes: { ...rules.mercedes },
      redBull: { ...rules.redBull },
    },
    astonMartin: team.special === 'aston_martin' ? state.astonMartin ?? null : null,
    racingBulls: team.special === 'racing_bulls' && state.racingBulls ? {
      ...state.racingBulls,
      candidates: state.racingBulls.pendingRecall?.candidateIds.map(id => ({ id, name: state.drivers[id]?.name ?? id })) ?? [],
    } : null,
    audi: team.special === 'audi' ? state.audi ?? null : null,
    alpine: team.special === 'alpine' ? state.alpine ?? null : null,
    haas: team.special === 'haas' ? state.haas ?? null : null,
    williams: team.special === 'williams' ? state.williams ?? null : null,
    randomEvents: state.randomEvents,
    fiaMeeting: state.fiaMeeting,
    nextSpecialRules: {
      astonMartin: { ...rules.astonMartin },
      racingBulls: { ...rules.racingBulls },
      audi: { ...rules.audi },
      fiaMeeting: { ...rules.fiaMeeting },
      alpine: { ...rules.alpine },
      haas: { ...rules.haas },
      williams: { ...rules.williams },
    },
    aduo: aduoView(state),
    lastSeason: state.lastSeason,
    labels: {
      ...LABELS,
      parts: partNames,
      tyres: Object.fromEntries(Object.entries(rules.tyres).map(([k, v]) => [k, { name: v.name, short: v.short, color: v.color, wet: v.wet }])),
      facilities: Object.fromEntries(FACILITIES.map(f => [f, rules.facilities[f].name])),
      ambition: Object.fromEntries(AMBITIONS.map(a => [a, rules.ambition[a].name])),
    },
    rules: {
      costCap: rules.costCap,
      dryCompounds: rules.dryCompounds,
      wetCompound: rules.wetCompound,
      fullWetCompound: rules.fullWetCompound,
      mandatoryCompounds: rules.mandatoryCompounds,
      aiLimits: rules.aiLimits,
      tyres: Object.fromEntries(Object.entries(rules.tyres).map(([compound, tyre]) => [compound, { temperatureWindow: (tyre.temperatureWindow ?? (tyre.wet ? [58, 78] : [80, 105])) as [number, number], warmupRate: tyre.warmupRate ?? (tyre.wet ? .4 : .32) }])),
    },
  };
}

function buildWeekendView(state: GameState): WeekendView | null {
  const w = state.weekend;
  if (!w) return null;
  const team = state.teams[state.meta.playerTeamId];
  const roundDef = state.calendar[w.roundIndex];
  const track = roundDef ? state.tracks[roundDef.trackId] : undefined;
  const isCurrent = w.roundIndex === state.season.roundIndex && state.season.phase !== 'pre_race' && state.season.phase !== 'season_end';
  const drivers: WeekendDriverView[] = [];
  if (track) {
    for (const car of team.cars) {
      if (!car.driverId) continue;
      const d = state.drivers[car.driverId];
      const plan = w.plans[d.id];
      const naturalSetup = w.setup[d.id];
      if (!plan || !naturalSetup) continue;
      const setup = effectiveSetup(state, d.id, naturalSetup);
      const ratings = carRatings(team, car, state.rules, 'disclosed');
      const performanceContext = buildPerformanceContext({ driverTyre: d.attrs.tyre, carTyre: ratings.tyre, setup, ratings, track });
      const practice = practiceEffects(setup, state.rules, performanceContext.trackFit);
      const baselineSetup = w.practiceBaseline?.[d.id];
      const baselinePractice = baselineSetup ? practiceEffects(baselineSetup, state.rules, performanceContext.trackFit) : null;
      const ctx = { driverTyre: d.attrs.tyre, carTyre: ratings.tyre, paceMode: plan.paceMode, knowledge: setup.tyreKnowledge, performanceContext };
      const sprintLaps = Math.max(3, Math.round(track.laps * state.rules.sprintLapsFactor));
      const factor = degFactor(track, ctx);
      drivers.push({
        driverId: d.id,
        driverName: d.name,
        plan,
        setup,
        performance: { trackFit: performanceContext.trackFit, practice },
        performanceSummary: baselinePractice ? {
          qualiGain: round1(practice.quali - baselinePractice.quali),
          raceGain: round1(practice.race - baselinePractice.race),
          wearDelta: round1((practice.wearMultiplier - baselinePractice.wearMultiplier) * 100),
          trackFit: performanceContext.trackFit,
          trackKnowledge: setup.trackKnowledge ?? 0,
          tyres: Object.fromEntries(Object.entries(state.rules.tyres).map(([compound, tyre]) => [compound, { temperatureWindow: (tyre.temperatureWindow ?? (tyre.wet ? [58, 78] : [80, 105])) as [number, number], warmupRate: tyre.warmupRate ?? (tyre.wet ? .4 : .32) }])),
        } : undefined,
        supernaturalSetup: w.supernaturalCarEffects?.[d.id] ? { base: naturalSetup, offset: w.supernaturalCarEffects[d.id], expires: '本站周末结束后失效' } : undefined,
        // 玩家看到的是「干地」策略预测（雨战由引擎自动换雨胎）
        options: strategyOptions(state.rules, track, track.laps, ctx, {
          wet: false,
          sprint: false,
          isAvailable: compounds => canRunTyreStrategy(team, d.id, weekendTyreKey(state, w.roundIndex), compounds),
        }).slice(0, 6),
        sprintOptions: roundDef?.sprint
          ? strategyOptions(state.rules, track, sprintLaps, ctx, {
            wet: false,
            sprint: true,
            isAvailable: compounds => canRunTyreStrategy(team, d.id, weekendTyreKey(state, w.roundIndex), compounds),
          })
          : [],
        tyreLife: Object.fromEntries(Object.entries(state.rules.tyres).map(([k, t]) => [k, round1(predictedTyreLife(t, factor, { context: performanceContext, paceMode: plan.paceMode, rules: state.rules }))])),
        tyreSets: (team.tyreInventory?.[d.id] ?? []).filter(set => set.weekendKey === weekendTyreKey(state, w.roundIndex)).map(set => ({ id: set.id, compound: set.compound, state: set.state, laps: set.laps, returned: set.returned, returnEligible: !!w.practiceReturn?.eligibleSetIds?.[d.id]?.includes(set.id) })),
      });
    }
  }
  const live = w.liveRace;
  const liveRace: LiveRaceView | null = !live
    ? null
    : (() => {
        const running = live.order.map((id, index) => ({ id, index, car: live.cars[id] })).filter(x => !!x.car);
        const leader = running[0]?.car;
        const timing = [...running, ...Object.values(live.cars).filter(c => c.status === 'dnf').map(car => ({ id: car.driverId, index: -1, car }))].map(({ car, index }) => ({
          driverId: car.driverId, teamId: car.teamId, pos: car.status === 'running' ? index + 1 : null, status: car.status,
          gap: car.status === 'dnf' ? 'DNF' : index === 0 ? '领跑' : `+${Math.max(0, car.cumulativeTime - (leader?.cumulativeTime ?? car.cumulativeTime)).toFixed(1)}s`,
          tyre: car.tyre, tyreAge: car.tyreAge, tyreTemperature: live.physicsVersion === 2 ? car.tyreTemperature : undefined, tyreState: (live.physicsVersion === 2 ? tyreThermalState(state, car) : 'legacy') as 'cold' | 'optimal' | 'hot' | 'legacy', pits: car.pits,
        }));
        return {
          id: live.id, revision: live.revision, kind: live.kind, completedLaps: live.completedLaps, totalLaps: live.totalLaps, stage: live.stage,
          raceControl: live.redFlag?.active ? 'red_flag' : live.scLeft > 0 ? 'sc' : live.vscLeft > 0 ? 'vsc' : null,
          restart: live.redFlag?.restartPending ? live.redFlag.restart : null,
          weather: { rain: live.rain, surface: live.surface, forecast: live.forecast }, timing,
          playerCars: Object.values(live.cars).filter(c => c.player).map(c => {
            const weakest = Object.entries(c.puComponentHealth ?? {}).sort((a, b) => (a[1] ?? 100) - (b[1] ?? 100))[0];
            return { driverId: c.driverId, tyre: c.tyre, tyreAge: c.tyreAge, tyreTemperature: live.physicsVersion === 2 ? c.tyreTemperature : undefined, tyreThermalState: live.physicsVersion === 2 ? tyreThermalState(state, c) : 'legacy', tyreState: state.teams[c.teamId]?.tyreInventory?.[c.driverId]?.find(set => set.id === c.tyreSetId)?.state ?? 'used', damage: c.damage > 0, partial: c.partial > 0, energy: c.energy, paceMode: c.plan.paceMode, energyMode: c.energyMode, pitTiming: c.plan.pitTiming, iceHealth: c.iceHealth ?? 100, electricalHealth: c.electricalHealth ?? 100, weakestPuHealth: weakest?.[1] ?? 100, weakestPuName: state.rules.parts[weakest?.[0] ?? '']?.name ?? '动力单元', puTemperature: c.puTemperature ?? 78, puStatus: c.puStatus ?? 'normal', predictedStationary: predictedStationaryTime(state.teams[c.teamId], c.repairPending), lastPit: c.pitStops?.at(-1) ?? null };
          }),
          events: live.events.slice(-20).map(event => {
            const names = event.drivers.map(id => state.drivers[id]?.short ?? state.drivers[id]?.name ?? id);
            let text = event.text;
            event.drivers.forEach((id, index) => { text = text.replaceAll(id, names[index]); });
            return { ...event, text, drivers: event.drivers, driverNames: names };
          }),
          teamOrders: { ...live.teamOrders },
          pendingDecision: live.pendingDecision ? {
            id: live.pendingDecision.id,
            lap: live.pendingDecision.lap,
            reasons: live.pendingDecision.reasons,
            eligibleDriverIds: live.pendingDecision.eligibleDriverIds,
            expectedPitLoss: (track?.pitLoss ?? 0) * (live.scLeft > 0 ? .5 : live.vscLeft > 0 ? .7 : 1),
            ...(live.stage === 'grid' && live.completedLaps === 0
              ? { startTyreOptions: requiresWetGridTyreChoice(live) ? [state.rules.wetCompound, state.rules.fullWetCompound] : [...state.rules.dryCompounds, state.rules.wetCompound, state.rules.fullWetCompound] }
              : {}),
          } : null,
        };
      })();
  return {
    roundIndex: w.roundIndex,
    isCurrent,
    weather: revealedWeather(w, state.season.phase, isCurrent),
    forecast: w.forecast,
    parcFerme: w.parcFerme,
    teamOrders: w.teamOrders,
    teammateRelationship: teammateRelationship(state, team.id),
    penalties: w.penalties,
    drivers,
    practiceSessions: Array.isArray(w.practiceSessions) ? w.practiceSessions : w.practice ? [w.practice] : [],
    practiceSessionTotal: state.calendar[w.roundIndex]?.sprint ? 1 : 3,
    practice: w.practice,
    practiceReturn: w.practiceReturn ? { required: w.practiceReturn.required, driverIds: [...w.practiceReturn.driverIds] } : null,
    liveQualifying: w.liveQualifying ?? null,
    sprintQualifying: w.sprintQualifying,
    sprint: w.sprint,
    qualifying: w.qualifying,
    race: w.race,
    liveRace,
  };
}

export function supernaturalAvailability(state: GameState): Pick<GameView['supernatural'], 'available' | 'reason' | 'categories'> {
  const team = state.teams[state.meta.playerTeamId];
  const blocked = !state.meta.supernaturalMode ? '本存档未在开局时启用超自然模式'
    : !team ? '玩家车队不可用'
    : dismissalReason(state) ? '已被撤职，不能干预'
        : state.season.phase === 'season_end' ? '赛季已经结束，不能干预'
          : state.weekend?.liveRace ? '实时比赛进行中，不能干预' : null;
  const category = (available: boolean, reason: string | null) => ({ available: !blocked && available, reason: blocked ?? (available ? null : reason) });
  const currentWeekend = state.weekend?.roundIndex === state.season.roundIndex ? state.weekend : null;
  return {
    available: !blocked,
    reason: blocked,
    categories: {
      people: category(true, null),
      team: category(true, null),
      research: category(['preseason', 'pre_race', 'post_race'].includes(state.season.phase), '仅可在季前、赛前或赛后推进研发'),
      weather: category(['preseason', 'pre_race'].includes(state.season.phase) && !currentWeekend, '仅可在当前比赛周末创建前调整天气倾向'),
      setup: category(!!currentWeekend && state.season.phase !== 'post_race', '需要当前未完成比赛周末中的赛车'),
    },
  };
}

function supernaturalView(state: GameState): GameView['supernatural'] {
  const team = state.teams[state.meta.playerTeamId];
  const availability = supernaturalAvailability(state);
  return {
    enabled: state.meta.supernaturalMode,
    ...availability,
    targets: {
      drivers: team ? Object.values(state.drivers).filter(driver => driver.teamId === team.id && (driver.role === 'race' || driver.role === 'reserve')).map(driver => ({ id: driver.id, name: driver.name, role: driver.role, attrs: { ...driver.attrs } })) : [],
      staff: team ? Object.entries(team.staff).filter(([, staff]) => !!staff.id).map(([role, staff]) => ({ id: staff.id!, name: staff.name, role })) : [],
      projects: team ? team.projects.filter(project => project.kind === 'design').map(project => ({ id: project.id, label: project.label, weeksLeft: project.weeksLeft })) : [],
    },
    pendingWeather: state.supernatural.pendingWeather ? { ...state.supernatural.pendingWeather } : null,
    caps: SUPERNATURAL_LIMITS,
  };
}
