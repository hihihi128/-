/**
 * F1 领队模拟器 · 数据类型定义
 *
 * 约定：
 * - 所有数值属性（车手能力、零件性能、可靠性…）都是 0~100 的浮点数，保留 1 位小数。
 * - 金额单位统一为「百万美元」(M$)。
 * - 时间单位：圈速为秒，研发周期为周。
 * - GameState 必须是纯 JSON（无函数、无 Date、无 Map），这样才能存进酒馆变量。
 */

// ───────────────────────────── 基础枚举 ─────────────────────────────

/** 零件类型，键来自 rules.parts（默认 8 种，可在规则数据里增删） */
export type PartType = string;
export type PowerUnitPartType = 'ice' | 'turbocharger' | 'mgu_k' | 'energy_store' | 'control_electronics' | 'exhaust';
/** 轮胎配方，键来自 rules.tyres */
export type Compound = string;

/** 由零件合成出的赛车属性 */
export type CarAttr = 'downforce' | 'efficiency' | 'power' | 'mechanical' | 'tyre';
/** 赛道对赛车属性的需求权重（tyre 不在其中，轮胎友好度单独作用于衰减） */
export type TrackDemand = 'downforce' | 'efficiency' | 'power' | 'mechanical';
/** 车手能力项 */
export type DriverAttr = 'pace' | 'racecraft' | 'consistency' | 'tyre' | 'wet' | 'feedback';

export type FacilityType = 'windTunnel' | 'cfd' | 'simulator' | 'factory';
export type StaffRole = 'technicalDirector' | 'aeroChief' | 'raceEngineer' | 'raceEngineer2' | 'pitCrew' | 'strategist';
export type StaffAbility = 'setup' | 'communication' | 'reaction' | 'strategy' | 'weather' | 'risk';
export type PitCrewFocus = 'speed' | 'consistency' | 'error_control';

export type Ambition = 'conservative' | 'standard' | 'aggressive';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Randomness = 'deterministic' | 'fresh';
export type Weather = 'dry' | 'wet';

/**
 * 赛季阶段（状态机）
 * preseason → pre_race → practice → [sprint_qualifying → sprint →] qualifying → race → post_race → (下一站 pre_race | season_end)
 */
export type Phase =
  | 'preseason'
  | 'pre_race'
  | 'practice'
  | 'sprint_qualifying'
  | 'sprint'
  | 'qualifying'
  | 'race'
  | 'post_race'
  | 'season_end';

export type PracticeProgram = 'setup' | 'longrun' | 'quali_sim' | 'parts';
export type QualiApproach = 'safe' | 'standard' | 'aggressive';
export type PaceMode = 'conserve' | 'balanced' | 'push';
export type PitTiming = 'early' | 'standard' | 'late';

// ───────────────────────────── 规则 ─────────────────────────────

export interface PartDef {
  /** 显示名 */
  name: string;
  /** 是否属于空气动力学部件（研发消耗风洞/CFD 时长） */
  aero: boolean;
  /** 是否允许研发 */
  developable: boolean;
  /** 对各项赛车属性的贡献权重 */
  weights: Partial<Record<CarAttr, number>>;
  /** 对整车可靠性的权重 */
  reliabilityWeight: number;
  /** 研发基础花费 (M$) */
  baseCost: number;
  /** 研发基础周期（周） */
  baseWeeks: number;
  /** 研发消耗的风洞/CFD 时长 */
  aeroHours: number;
  /** 额外生产一件的成本 (M$) */
  unitCost: number;
  /** 撞车时该部件损毁的概率 0~1 */
  crashDamage: number;
}

export interface TyreDef {
  name: string;
  short: string;
  /** 相对中性胎的圈速差（秒，负数更快） */
  pace: number;
  /** 每圈胎龄带来的衰减（秒/圈） */
  deg: number;
  /** 悬崖圈数：超过后衰减急剧上升 */
  cliff: number;
  /** 是否为雨胎 */
  wet: boolean;
  color: string;
}

export interface AmbitionDef {
  name: string;
  /** 预期收益（零件性能点，未计入员工/设施修正） */
  gain: number;
  /** 收益波动比例（0.5 = ±50%） */
  spread: number;
  costMul: number;
  weeksMul: number;
  hoursMul: number;
  /** 新零件初始可靠性变化 */
  relDelta: number;
  /** 首批交付件数 */
  units: number;
}

export interface FacilityDef {
  name: string;
  maxLevel: number;
  /** upgradeCost[n] = 升到 n+2 级的花费（1 级升 2 级为 upgradeCost[0]） */
  upgradeCost: number[];
  upgradeWeeks: number[];
}

export interface AiLimits {
  maxCommands: number;
  morale: number;
  trust: number;
  board: number;
  media: number;
  staff: number;
  funds: number;
  fitness: number;
  penalty: number;
  /** 粉丝意见（法拉利特殊机制） */
  fans: number;
}

/**
 * ADUO（Additional Development and Upgrade Opportunities，2026 动力单元追赶机制）。
 *
 * - 动力单元零件（parts）可自由研发和生产，但新规格必须消耗 ADUO 机会完成认证后才能装车。
 * - 一次认证会批准厂商当前所有已交付、尚未认证的动力单元规格，作为同一升级批次。
 * - 有厂商车队（worksTeam）的动力单元由厂商车队研发，客户车队不能自行研发，厂商认证后的新件才交付给客户车队。
 * - 在 evalRounds 列出的站次（正赛后）按厂商评估 measurePart 的真实性能：
 *   落后最好厂商的百分比 = 性能分差 × pctPerPoint。
 *   落后 ≥ tier1Deficit% → 一档；≥ tier2Deficit% → 二档。
 *   每次评估按档位给厂商车队增加认证升级次数、本赛季预算帽额度，并缩短动力单元研发周期（到下次评估为止）。
 */
export interface AduoRules {
  enabled: boolean;
  /** 计入认证升级次数、并由厂商供应给客户车队的零件类型 */
  parts: PartType[];
  /** 评估用的零件类型（2026 规则只评估内燃机） */
  measurePart: PartType;
  /** 每赛季基础认证升级次数（2026 默认为 0，只能通过 ADUO 评估获得） */
  baseUpgrades: number;
  /** 评估站次（第 N 站正赛后，1 起） */
  evalRounds: number[];
  /** 1 分零件性能差距折合的百分比 */
  pctPerPoint: number;
  tier1Deficit: number;
  tier2Deficit: number;
  tier1Upgrades: number;
  tier2Upgrades: number;
  /** 每次评估增加的预算帽额度（M$，本赛季有效） */
  tier1CapBonus: number;
  tier2CapBonus: number;
  /** 动力单元研发周期倍率（台架时间增加） */
  tier1WeeksMul: number;
  tier2WeeksMul: number;
}

export interface AduoResult {
  engine: string;
  /** 厂商车队 id（没有厂商车队时为空） */
  worksTeamId: string | null;
  perf: number;
  deficitPct: number;
  tier: number;
  upgrades: number;
  capBonus: number;
}

export interface AduoEvaluation {
  year: number;
  /** 第几站后评估（1 起） */
  round: number;
  results: AduoResult[];
}

export interface AduoState {
  /** 本赛季的评估记录 */
  evaluations: AduoEvaluation[];
}

/**
 * 法拉利特殊机制：媒体支持率 + 两位车手的粉丝意见。
 * 只对 special = ferrari 的玩家车队生效。媒体支持率直接使用车队的 mediaReputation。
 */
export interface FerrariRules {
  /** 开局媒体支持率 */
  startMedia: number;
  /** 开局两边粉丝的满意度 */
  startFans: number;
  /** 媒体支持率低于该值 → 撤职 */
  minMedia: number;
  /** 媒体支持率低于该值 → 警告 */
  warnMedia: number;
  /** 两边粉丝满意度差距超过该值 → 撤职 */
  maxFanGap: number;
  /** 两边粉丝满意度差距超过该值 → 警告 */
  warnFanGap: number;
  /** 每站正赛后媒体耐心的固定消耗 */
  mediaPerRace: number;
  /** 正赛成绩对媒体支持率影响的倍率 */
  mediaResultMul: number;
  /** 升级件分配：两台车每差 1 分综合性能，两边粉丝各变化多少 */
  allocationFans: number;
  /** 指定 / 取消优先车手的粉丝变化 */
  priorityFans: number;
  /** 执行车队指令（让车）的粉丝变化 */
  orderFans: number;
  /** 正赛名次高低 / 领奖台的粉丝变化 */
  resultFans: number;
  /** 撤职检查前的宽限站数（前 N 站只警告不撤职） */
  graceRounds: number;
}

export interface McLarenRules {
  failureChance: number;
  independentWeeks: number;
  cooperationWeeks: number;
  mercedesDevelopmentBuff: number;
}

export interface MercedesRules {
  failureChance: number;
  startTotoSatisfaction: number;
  dismissTotoSatisfaction: number;
  startPoliticalPressure: number;
  banPoliticalPressure: number;
  pressurePerRace: number;
  aduoProgressPerLobby: number;
}

export interface RedBullRules {
  mistakeMultiplier: number;
  startGpRetention: number;
  gpLossPerRace: number;
  gpNegotiationGain: number;
  gpNegotiationCost: number;
}

export interface AstonMartinRules {
  vibrationInterval: number;
  vibrationRetireChance: number;
  startHondaConflict: number;
  startMediaPressure: number;
  mediaConfidenceLoss: number;
  aduoPressureGain: number;
  mediationGain: number;
  neweyProgressGain: number;
  aduoPuBuff: number;
  chassisBuff: number;
}

export interface RacingBullsRules { recallChance: number }
export interface AudiRules { startDropMin: number; startDropMax: number; allianceProgress: number; progressPerRace: number }
export interface FiaMeetingRules { interval: number; startPoliticalCapital: number }
export interface AlpineRules {
  startBriatoreSatisfaction: number;
  dismissBriatoreSatisfaction: number;
  startFanPressure: number;
  startGaslyCommitment: number;
  startPuIntegration: number;
  integrationGain: number;
}
export interface HaasRules {
  startGeneSupport: number;
  startToyotaSupport: number;
  startToyotaInfluence: number;
  influencePerRace: number;
  interferenceThreshold: number;
  dismissGeneSupport: number;
}
export interface WilliamsRules {
  startVowlesConfidence: number;
  startSuccessionReadiness: number;
  successionThreshold: number;
  dismissVowlesConfidence: number;
}
export interface RandomEventRules {
  /** 每个游戏周安排的事件数量。 */
  minPerWeek?: number;
  maxPerWeek?: number;
  /** 日常事件约占全部事件的比例权重。 */
  routineWeight?: number;
  noneWeight: number;
  driverInjuryWeight: number;
  windTunnelWeight: number;
  partIssueWeight: number;
  minDialogueTurns?: number;
  maxDialogueTurns?: number;
}

export interface Rules {
  seasonYear: number;
  pointsRace: number[];
  pointsSprint: number[];
  /** 最快圈加分（0 = 不加分） */
  fastestLapPoint: number;
  fastestLapTopN: number;
  /** 预算帽 (M$) */
  costCap: number;
  /** 车手薪水是否计入预算帽 */
  costCapIncludesSalaries: boolean;
  /** 设施升级是否计入预算帽 */
  costCapIncludesFacilities: boolean;
  /** 休赛期合同市场的公开规则。 */
  market: MarketRules;
  /** 赛季末按车队排名发放奖金 (M$)，下标 0 = 冠军 */
  prizeMoney: number[];
  /** 每得 1 分的赞助奖金 (M$) */
  pointBonus: number;
  /** 赛车综合分每差 1 点的圈速差（秒） */
  secPerCarPoint: number;
  /** 车手能力每差 1 点的圈速差（秒） */
  secPerDriverPoint: number;
  parts: Record<PartType, PartDef>;
  tyres: Record<Compound, TyreDef>;
  /** 干地可用配方（按软→硬） */
  dryCompounds: Compound[];
  /** 雨地配方 */
  wetCompound: Compound;
  /** 大雨和严重积水时使用的全雨胎配方 */
  fullWetCompound: Compound;
  /** 干地正赛至少使用几种不同配方 */
  mandatoryCompounds: number;
  /** 每节练习赛后每位正式车手必须交回的轮胎组数 */
  practiceReturnSets: number;
  ambition: Record<Ambition, AmbitionDef>;
  /** 每个比赛间隔的基础风洞时长 */
  aeroAllowanceBase: number;
  /** 按车队排名的风洞时长倍率（下标 0 = 第 1 名） */
  aeroAllowanceByPosition: number[];
  facilities: Record<FacilityType, FacilityDef>;
  /** 研发并行槽位基础值 */
  rndSlotsBase: number;
  /** 零件性能软上限 */
  partCap: number;
  /** 新赛季零件性能保留比例 */
  carryOver: number;
  /** 冲刺赛圈数占正赛比例 */
  sprintLapsFactor: number;
  /** 单次罚退上限 */
  maxGridPenalty: number;
  /** AI 叙事指令的单次幅度上限 */
  aiLimits: AiLimits;
  /** 董事会信心低于该值时触发「被解雇」剧情 */
  boardFireThreshold: number;
  /** 排位赛进入最后一节（Q3）的车数；其余车在 Q1/Q2 平分淘汰（2026：22 台车 → 6/6/10） */
  qualiFinalists: number;
  /** 超车模式（2026，取代 DRS）：落后前车不足该秒数时可获得额外电能 */
  overtakeModeGap: number;
  /** 超车模式的基础超车优势（秒/圈，按能量回收系统性能缩放） */
  overtakeModeBonus: number;
  /** Boost 按钮：进攻模式下主动释放电能带来的进攻优势（秒） */
  boostAttack: number;
  /** Boost 按钮：进攻模式下被追击时用电能防守的优势（秒） */
  boostDefence: number;
  /** 每位车手每赛季可用的动力单元元件数（键 = 零件类型） */
  puAllocation: Record<PartType, number>;
  /** 第一次超出配额的罚退格数 */
  puPenaltyFirst: number;
  /** 之后每次超出配额的罚退格数 */
  puPenaltyNext: number;
  /** 法拉利特殊机制 */
  ferrari: FerrariRules;
  mclaren: McLarenRules;
  mercedes: MercedesRules;
  redBull: RedBullRules;
  astonMartin: AstonMartinRules;
  racingBulls: RacingBullsRules;
  audi: AudiRules;
  fiaMeeting: FiaMeetingRules;
  alpine: AlpineRules;
  haas: HaasRules;
  williams: WilliamsRules;
  randomEvents: RandomEventRules;
  /** ADUO 动力单元追赶机制 */
  aduo: AduoRules;
}

export interface MarketRules {
  minYears: number;
  maxYears: number;
  /** 剩余保障合同的公开买断/解约比例。 */
  buyoutRate: number;
  /** 报价可接受分数。 */
  acceptanceThreshold: number;
  /** 现金缓冲按多少周工资保留。 */
  payrollBufferWeeks: number;
}

// ───────────────────────────── 静态数据（来自世界书） ─────────────────────────────

export interface TrackDef {
  id: string;
  name: string;
  country: string;
  /** 赛道类型描述，如「高速」「街道」「均衡」 */
  type: string;
  laps: number;
  /** 参考圈速（秒）：满分车手 + 满分赛车的干地圈速 */
  baseLap: number;
  /** 进站损失（秒，含进出维修区） */
  pitLoss: number;
  /** 对赛车属性的需求权重，已归一化 */
  weights: Record<TrackDemand, number>;
  /** 超车容易度 0~100 */
  overtaking: number;
  /** 轮胎负荷 0~100 */
  tyreStress: number;
  /** 降雨概率 0~1 */
  rainChance: number;
  /** 事故后出动安全车（而非虚拟安全车）的概率 0~1 */
  scChance: number;
  description: string;
}

export interface RoundDef {
  id: string;
  trackId: string;
  name: string;
  sprint: boolean;
  /** 距上一站的间隔周数（第一站表示季前测试到首站的周数） */
  weeksGap: number;
  dateLabel: string;
}

export interface StaffMember {
  /** 稳定身份；旧数据由迁移使用 teamId + role 补齐。 */
  id?: string;
  role?: StaffRole;
  name: string;
  skill: number;
  /** 个人专项能力。旧数据缺失时回退到综合 skill。 */
  abilities?: Partial<Record<StaffAbility, number>>;
  /** 年薪 (M$) */
  salary: number;
  contractStart?: number;
  contractEnd?: number;
  preference?: CandidatePreference;
  /** 候选人的主要外部赛事/项目；空值表示未特别标注。 */
  series?: string;
  /** 候选人简介，供人员市场展示。 */
  description?: string;
  /** 对玩家领队的个人好感度 0~100。 */
  affinity?: number;
}

export interface CandidatePreference {
  askingSalary: number;
  preferredYears: number;
  desiredStrength: number;
  preferredTeamId: string | null;
  loyalty: number;
  acceptsReserve?: boolean;
}

export interface TeamDef {
  id: string;
  name: string;
  short: string;
  color: string;
  principal: string;
  engine: string;
  /** 动力单元厂商车队（同一 engine 的其他车队是客户车队） */
  worksTeam: boolean;
  base: string;
  funds: number;
  /** 每站赞助收入 (M$) */
  sponsorIncome: number;
  /** 每站运营成本 (M$)，计入预算帽 */
  operatingCost: number;
  facilities: Record<FacilityType, number>;
  staff: Record<StaffRole, StaffMember>;
  /** 初始零件规格 */
  parts: Record<PartType, { perf: number; rel: number }>;
  /** 董事会预期的车队排名 */
  targetPosition: number;
  /** 开局选队界面的难度分组 */
  selectionDifficulty: TeamSelectionDifficulty;
  description: string;
  /** 特殊机制标识，空字符串 = 无 */
  special: string;
}

export type TeamSelectionDifficulty = 'easy' | 'medium' | 'hard';

export interface DriverDef {
  id: string;
  name: string;
  short: string;
  number: number;
  nationality: string;
  age: number;
  teamId: string | null;
  /** race = 正式车手；reserve = 替补 */
  role: 'race' | 'reserve';
  attrs: Record<DriverAttr, number>;
  potential: number;
  morale: number;
  fitness: number;
  /** 自尊心 0~100：越高越在意待遇不公与车队指令 */
  ego: number;
  /** 年薪 (M$) */
  salary: number;
  contractStart?: number;
  contractEnd: number;
  preference?: CandidatePreference;
  traits: string[];
  /** 主要外部赛事/项目；F1 车手通常留空。 */
  series?: string;
  description: string;
}

export interface Database {
  rules: Rules;
  teams: TeamDef[];
  drivers: DriverDef[];
  /** 可选的自由员工池；缺失时由开局生成虚构候选人。 */
  staffCandidates?: StaffMember[];
  tracks: TrackDef[];
  calendar: RoundDef[];
  /** 数据来源（世界书条目名） */
  sources: string[];
  /** 数据指纹（用于提示数据是否变更） */
  signature: string;
}

export interface DataIssue {
  level: 'error' | 'warning';
  source: string;
  path: string;
  message: string;
}

// ───────────────────────────── 动态状态 ─────────────────────────────

export interface PartSpec {
  id: string;
  type: PartType;
  version: number;
  /** 真实性能（未验证前界面只显示预估区间） */
  perf: number;
  rel: number;
  /** 是否已通过练习赛/正赛数据验证 */
  verified: boolean;
  /** 交付前的预估区间 */
  expected: [number, number] | null;
  /** 动力单元规格是否已获认证；非动力单元规格与旧存档默认视为已认证 */
  homologated?: boolean;
  introduced: string;
}

export interface TeamParts {
  specs: PartSpec[];
  /** 备件库存：specId → 件数（不含已装车的） */
  stock: Record<string, number>;
}

export interface CarState {
  /** 车号位（1 号车、2 号车…） */
  slot: number;
  driverId: string | null;
  /** 当前装车：零件类型 → specId */
  fitted: Record<PartType, string>;
  /** 动力单元实体磨损；更换为不同规格时从新件开始。旧存档没有该字段。 */
  puWear?: Partial<Record<PowerUnitPartType, { specId: string; wear: number }>>;
  /** 按规格保存可再次装回的动力单元磨损。 */
  puWearPool?: Partial<Record<PowerUnitPartType, Record<string, number>>>;
}

export type ProjectKind = 'design' | 'manufacture' | 'facility' | 'pit_training' | 'driver_training';

export interface Project {
  id: string;
  kind: ProjectKind;
  label: string;
  partType?: PartType;
  specId?: string;
  facility?: FacilityType;
  driverId?: string;
  attr?: DriverAttr;
  pitFocus?: PitCrewFocus;
  ambition?: Ambition;
  rush?: boolean;
  qty?: number;
  cost: number;
  weeksTotal: number;
  weeksLeft: number;
  /** 设计项目：预估区间与真实收益（真实收益对界面隐藏） */
  expected?: [number, number];
  trueGain?: number;
  relDelta?: number;
  units?: number;
  startedAt: string;
}

export interface TeamState {
  id: string;
  name: string;
  short: string;
  color: string;
  principal: string;
  engine: string;
  /** 动力单元厂商车队（旧存档没有该字段） */
  worksTeam?: boolean;
  /** 本赛季已用的动力单元认证升级次数 */
  puHomologations?: number;
  /** 本赛季 ADUO 追加的认证升级次数 */
  aduoUpgrades?: number;
  /** 本赛季 ADUO 追加的预算帽额度（M$） */
  aduoCapBonus?: number;
  /** 当前 ADUO 档位（0 = 无） */
  aduoTier?: number;
  base: string;
  isPlayer: boolean;
  funds: number;
  /** 本赛季已计入预算帽的支出 */
  costCapSpent: number;
  sponsorIncome: number;
  operatingCost: number;
  facilities: Record<FacilityType, number>;
  staff: Record<StaffRole, StaffMember>;
  /** 维修组专项训练水平；旧存档以综合能力初始化。 */
  pitCrewTraining?: Record<PitCrewFocus, number>;
  /** 每位车手独立持有的实体轮胎组。 */
  tyreInventory?: Record<string, TyreSet[]>;
  parts: Record<PartType, TeamParts>;
  cars: CarState[];
  projects: Project[];
  /** 本周期剩余风洞/CFD 时长 */
  aeroHours: number;
  /** 优先车手（升级件默认先给谁、车队指令偏向谁） */
  driverPriority: string | null;
  boardConfidence: number;
  targetPosition: number;
  mediaReputation: number;
  staffMorale: number;
  /** 0~100：资源投向下赛季的比例 */
  nextSeasonFocus: number;
  description: string;
  /** 特殊机制标识（旧存档没有该字段） */
  special?: string;
}

export interface DriverStats {
  starts: number;
  wins: number;
  podiums: number;
  poles: number;
  points: number;
  dnfs: number;
}

export interface DriverState {
  id: string;
  name: string;
  short: string;
  number: number;
  nationality: string;
  age: number;
  teamId: string | null;
  role: 'race' | 'reserve';
  attrs: Record<DriverAttr, number>;
  potential: number;
  morale: number;
  fitness: number;
  /** 对玩家领队的信任 0~100（仅玩家车队车手有意义） */
  trust: number;
  /** 对玩家领队的个人好感度 0~100。 */
  affinity: number;
  /** 近期状态 -10~10 */
  form: number;
  ego: number;
  salary: number;
  contractStart?: number;
  contractEnd: number;
  preference?: CandidatePreference;
  traits: string[];
  series?: string;
  description: string;
  stats: DriverStats;
  /** 本赛季已启用的动力单元元件数（键 = 零件类型；旧存档没有该字段） */
  puUsed?: Record<PartType, number>;
  /** 本赛季已启用过的动力单元规格（换回池中的旧规格不计新件） */
  puPool?: Record<PartType, string[]>;
}

/** 单站成绩代码：数字 = 名次；'DNF' 退赛；null = 未参赛 */
export type ResultCode = number | 'DNF' | null;

export interface DriverStanding {
  points: number;
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  dnfs: number;
  best: number | null;
  results: ResultCode[];
  sprintPoints: number;
}

export interface TeamStanding {
  points: number;
  wins: number;
  podiums: number;
  best: number | null;
}

export interface Standings {
  drivers: Record<string, DriverStanding>;
  teams: Record<string, TeamStanding>;
}

// ───────────────────────────── 比赛周末 ─────────────────────────────

export type EnergyMode = 'harvest' | 'balanced' | 'deploy';

export interface DriverPlan {
  /** 策略来源；旧存档缺失时按玩家策略处理。 */
  strategySource?: 'player' | 'engineer' | 'perfect';
  practiceProgram: PracticeProgram;
  qualiApproach: QualiApproach;
  /** 轮胎策略：各段配方；'auto' 由策略组自动选择 */
  tyrePlan: Compound[] | 'auto';
  /** 冲刺赛起步配方；'auto' 自动 */
  sprintTyre: Compound | 'auto';
  paceMode: PaceMode;
  pitTiming: PitTiming;
  /** 能量模式；旧存档缺失时按 balanced 自动处理 */
  energyMode?: EnergyMode;
  /** 安全车时是否机会进站 */
  scReaction: boolean;
}

export interface TeamOrders {
  mode: 'free' | 'hold' | 'favor';
  favorDriverId: string | null;
}

export interface SetupState {
  /** 调校信心 0~100 */
  confidence: number;
  /** 轮胎数据 0~100 */
  tyreKnowledge: number;
  /** 排位模拟加成（秒） */
  qualiBonus: number;
}

export interface PracticeEntry {
  driverId: string;
  teamId: string;
  time: number;
  laps: number;
}

export interface PracticeResult {
  timesheet: PracticeEntry[];
  gains: Record<string, { setup: number; tyre: number; program: PracticeProgram; verified: string[] }>;
  events: RaceEvent[];
}

/** A physical tyre set belongs to exactly one driver for one race weekend. */
export interface TyreSet {
  id: string;
  compound: Compound;
  state: 'new' | 'used';
  laps: number;
  returned: boolean;
  /** Season + calendar round key. Prevents same-index sets leaking into a new season. */
  weekendKey: string;
}

export interface PracticeReturnRequest {
  session: number;
  required: number;
  driverIds: string[];
  /** Frozen at the end of the session so the UI and action validate the same choice set. */
  eligibleSetIds: Record<string, string[]>;
}

export interface QualiSession {
  name: string;
  entries: Array<{ driverId: string; teamId: string; time: number | null; eliminated: boolean; note?: string }>;
}

export interface QualiResult {
  kind: 'qualifying' | 'sprint_qualifying';
  weather: Weather;
  sessions: QualiSession[];
  /** 排位名次（未计罚退） */
  order: string[];
  /** 最终发车顺序（已计罚退） */
  grid: string[];
  pole: { driverId: string; time: number } | null;
  events: RaceEvent[];
}

export type RaceEventType =
  | 'start'
  | 'overtake'
  | 'pit'
  | 'slow_stop'
  | 'dnf'
  | 'damage'
  | 'sc'
  | 'vsc'
  | 'red_flag'
  | 'restart'
  | 'sc_end'
  | 'order'
  | 'fastest'
  | 'error'
  | 'finish'
  | 'info';

export interface RaceEvent {
  lap: number;
  type: RaceEventType;
  text: string;
  drivers: string[];
  /** 是否涉及玩家车队或领跑者（叙事重点） */
  key: boolean;
}

export interface ClassificationEntry {
  driverId: string;
  teamId: string;
  pos: number | null;
  grid: number;
  status: 'finished' | 'dnf';
  laps: number;
  time: number;
  gap: string;
  pits: number;
  bestLap: number;
  points: number;
  reason: string;
  tyres: Compound[];
  pitStops?: PitStopRecord[];
}

export interface PitStopRecord {
  lap: number;
  predictedStationary: number;
  actualStationary: number;
  slow: boolean;
  repair: boolean;
}

export interface RaceResult {
  kind: 'race' | 'sprint';
  weather: Weather;
  /** 赛后实际天气摘要；旧结果可不含此字段。 */
  weatherSummary?: 'dry' | 'wet' | 'mixed';
  laps: number;
  classification: ClassificationEntry[];
  events: RaceEvent[];
  fastestLap: { driverId: string; time: number; lap: number } | null;
  /** 玩家车手每圈名次（用于走势图） */
  lapChart: Record<string, number[]>;
  safetyCars: number;
  /** 红旗次数；旧结果可能缺失。 */
  redFlags?: number;
  /** 车队指令执行情况 */
  orderOutcomes: Array<{ lap: number; yielded: string; favored: string; complied: boolean }>;
}

export type LiveRaceStage = 'grid' | 'ready' | 'before_pit' | 'finished';
export type RaceWindowReason = 'grid' | 'pit_opportunity' | 'weather_change' | 'sc' | 'vsc' | 'red_flag' | 'incident';

export interface RaceForecast {
  issuedLap: number;
  horizonLaps: number;
  rainProbability: number;
  intensityRange: [number, number];
  arrivalLaps: [number, number] | null;
  confidence: number;
}

export interface LiveRaceCar {
  driverId: string;
  teamId: string;
  slot: number;
  player: boolean;
  grid: number;
  score: number;
  skill: number;
  consistency: number;
  racecraft: number;
  trust: number;
  ego: number;
  reliability: number;
  wetSkill: number;
  tyreFactor: number;
  setupBonus: number;
  raceEngineerReaction: number;
  raceEngineerWeather: number;
  plan: DriverPlan;
  tyre: Compound;
  tyreAge: number;
  tyreSetId?: string;
  usedCompounds: Compound[];
  plannedCompounds: Compound[];
  stints: number[];
  stintIndex: number;
  pits: number;
  pitStops?: PitStopRecord[];
  cumulativeTime: number;
  completedLaps: number;
  status: 'running' | 'dnf';
  reason: string;
  bestLap: number | null;
  damage: number;
  partial: number;
  repairPending: boolean;
  energy: number;
  energyMode: EnergyMode;
  /** 2026 动力单元实时状态。健康度与温度均为简化管理指标。 */
  iceHealth?: number;
  electricalHealth?: number;
  /** 六类动力单元部件的独立健康度。 */
  puComponentHealth?: Partial<Record<PowerUnitPartType, number>>;
  puComponentReliability?: Partial<Record<PowerUnitPartType, number>>;
  puTemperature?: number;
  puStatus?: 'normal' | 'hot' | 'protect' | 'critical';
  ersPerformance?: number;
  iceReliability?: number;
  electricalReliability?: number;
  pendingPit: 'auto' | 'stay_out' | 'box' | null;
  /** Choice is staged until a real pit stop; never changes track position tyre instantly. */
  pendingCompound: Compound | null;
  /** Prevents a stay-out acknowledgement being immediately re-prompted next lap. */
  stayOutUntilLap: number;
  /** 工程师天气判断使用独立确定性随机流，不消耗比赛主随机流。 */
  engineerLightRainAssessed?: boolean;
  engineerWetAssessed?: boolean;
  engineerWeatherSpell?: number;
  engineerTyreOverride?: Compound | null;
  engineerTyreOverrideUntilLap?: number;
  /** Prevents repeated opportunistic stops during one SC/VSC period. */
  neutralStopTaken?: boolean;
}

export interface RaceDamageRecord {
  id: string;
  incidentId: string;
  driverId: string;
  teamId: string;
  slot: number;
  cause: 'single_car' | 'collision';
  severity: 'minor' | 'wing' | 'dnf';
  affectedPartTypes: string[];
  repairedInRace: boolean;
}

export interface RaceDecisionWindow {
  id: string;
  lap: number;
  stage: LiveRaceStage;
  reasons: RaceWindowReason[];
  affectedDriverIds: string[];
  eligibleDriverIds: string[];
  observedEventIds: string[];
}

/** Fully serializable in-progress race state. Private trajectory and RNG stay out of views. */
export interface LiveRaceState {
  version: 1;
  id: string;
  kind: 'race' | 'sprint';
  roundIndex: number;
  totalLaps: number;
  completedLaps: number;
  lap: number;
  stage: LiveRaceStage;
  revision: number;
  rngState: number;
  weatherRngState: number;
  forecastRngState: number;
  /** Frozen at lights-out so staff changes cannot alter a restored session. */
  strategistSkill: number;
  expectedPositions: Record<string, number>;
  cars: Record<string, LiveRaceCar>;
  order: string[];
  weatherTrajectory: number[];
  weatherHistory: number[];
  rain: number;
  wetness: number;
  surface: 'dry' | 'damp' | 'wet';
  forecast: RaceForecast;
  scLeft: number;
  vscLeft: number;
  safetyCars: number;
  redFlags: number;
  redFlag: {
    active: boolean;
    triggerLap: number;
    restart: 'standing' | 'rolling';
    restartPending: boolean;
  } | null;
  fastestLap: { driverId: string; time: number; lap: number } | null;
  events: Array<RaceEvent & { id: string }>;
  lapChart: Record<string, number[]>;
  orderOutcomes: Array<{ lap: number; yielded: string; favored: string; complied: boolean }>;
  orderCooldown: Record<string, number>;
  teamOrders: TeamOrders;
  pendingDecision: RaceDecisionWindow | null;
  damageLedger: RaceDamageRecord[];
  specialIncidents?: Array<{ type: 'mclaren_pu' | 'mercedes_pu'; driverId: string; lap: number; handled: boolean }>;
  norrisTeammateRollDone?: boolean;
}

export interface WeekendState {
  roundIndex: number;
  weather: { practice: Weather; qualifying: Weather; race: Weather; sprintQualifying: Weather; sprint: Weather };
  /** 赛前天气预报（降雨概率，0~1） */
  forecast: {
    qualifying: number;
    race: number;
    /** 公开的赛前降雨到达窗口；预报可以与隐藏天气轨迹有偏差。 */
    raceRainWindow?: [number, number] | null;
  };
  /** 仅供引擎复现隐藏正赛天气轨迹；不得进入公开视图或提示词。 */
  raceWeatherSeed?: number;
  /** 本站已消费的公开降雨倾向，不暴露隐藏天气。 */
  supernaturalRainBias?: number;
  /** 只作用于本周末尚未执行计算的玩家赛车调校。 */
  supernaturalCarEffects?: Record<string, { confidence: number; tyreKnowledge: number }>;
  setup: Record<string, SetupState>;
  plans: Record<string, DriverPlan>;
  teamOrders: TeamOrders;
  /** 本站罚退（格） */
  penalties: Record<string, number>;
  /** 封闭车辆规则：排位后不能换件 */
  parcFerme: boolean;
  /** 已完成的练习赛；冲刺周末 1 节，普通周末 3 节。 */
  practiceSessions: PracticeResult[];
  /** 最近一节练习赛结果，保留以兼容旧存档和调用方。 */
  practice: PracticeResult | null;
  /** Set after each practice until the player returns the required sets. */
  practiceReturn?: PracticeReturnRequest | null;
  sprintQualifying: QualiResult | null;
  sprint: RaceResult | null;
  qualifying: QualiResult | null;
  race: RaceResult | null;
  /** 可暂停的正赛或冲刺赛；旧存档默认为 null。 */
  liveRace: LiveRaceState | null;
}

// ───────────────────────────── 日志 ─────────────────────────────

export interface RoundSummary {
  roundIndex: number;
  trackId: string;
  trackName: string;
  weather: Weather;
  winner: string | null;
  pole: string | null;
  fastest: string | null;
  /** [driverId, 名次或 null, 得分, 状态] */
  results: Array<[string, number | null, number, 'finished' | 'dnf']>;
  sprint: Array<[string, number | null, number, 'finished' | 'dnf']> | null;
}

export interface NewsItem {
  id: string;
  at: string;
  tag: string;
  text: string;
}

export interface NarrationEvent {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string;
}

export interface AiLogEntry {
  at: string;
  messageId: number | null;
  op: string;
  target: string;
  requested: number | string | null;
  applied: number | string | null;
  reason: string;
  ok: boolean;
  note: string;
  source?: 'supernatural';
  invocationId?: string;
}

export interface GameMeta {
  createdAt: number;
  playerTeamId: string;
  principalName: string;
  difficulty: Difficulty;
  randomness: Randomness;
  dataSignature: string;
  dataSources: string[];
  /** 玩家开局时填写的「为什么被选中」（可为空） */
  selectionReason?: string;
  /** 仅本存档的手动超自然干预模式。 */
  supernaturalMode: boolean;
}

export interface SupernaturalState {
  /** 尚未进入周末的本赛季本站公开降雨倾向。 */
  pendingWeather: { year: number; roundIndex: number; rainBias: number } | null;
}

/** 法拉利特殊机制的动态状态 */
export interface FerrariState {
  /** 粉丝阵营：车手 id → 满意度 0~100 */
  fans: Record<string, number>;
  /** 已发出的警告（避免每站重复） */
  warned: { media: boolean; gap: boolean };
  /** 被撤职的原因（未撤职为 null） */
  dismissed: string | null;
  /** 最近几次粉丝/媒体变化（供面板展示） */
  log: Array<{ at: string; text: string }>;
}

export interface McLarenState {
  softwareResolved: boolean;
  route: 'independent' | 'mercedes' | null;
  weeksLeft: number;
  weeksTotal: number;
  mercedesBuffApplied: boolean;
  log: Array<{ at: string; text: string }>;
}

export interface MercedesState {
  aduoApproved: boolean;
  aduoProgress: number;
  politicalPressure: number;
  compressionRatio: '1:18' | '1:16';
  totoSatisfaction: number;
  dismissed: string | null;
  lastActionRound: string | null;
  log: Array<{ at: string; text: string }>;
}

export interface RedBullState {
  gpRetention: number;
  gpTransferred: boolean;
  summerChecked: boolean;
  verstappenExit: boolean;
  lastActionRound: string | null;
  log: Array<{ at: string; text: string }>;
}

export interface AstonMartinState {
  aduoEngineArrived: boolean;
  aduoProgress: number;
  hondaConflict: number;
  neweyProgress: number;
  chassisUpgradeReady: boolean;
  mediaPressure: number;
  alonsoFanAnger: number;
  strollFavor: number;
  lastActionRound: string | null;
  log: Array<{ at: string; text: string }>;
}

export interface RacingBullsState {
  pendingRecall: { driverId: string; candidateIds: string[] } | null;
  activeRecall: { driverId: string; replacementId: string; replacementTeamId: string | null; replacementPuUsed?: Record<PartType, number>; replacementPuPool?: Record<PartType, string[]> } | null;
  log: Array<{ at: string; text: string }>;
}

export interface AudiState {
  turboFixed: boolean;
  aduoProgress: number;
  alliance: boolean;
  politicalSupport: number;
  lastActionRound: string | null;
  log: Array<{ at: string; text: string }>;
}

export interface AlpineState {
  briatoreSatisfaction: number;
  fanPressure: number;
  gaslyCommitment: number;
  puIntegration: number;
  integrationPenaltyActive: boolean;
  penalizedPowerSpecs: Record<string, { partType: PartType; specId: string; perfAfter: number; relAfter: number }>;
  rndDirection: PartType[];
  lastActionRound: string | null;
  /** 最近一次至少执行过管理行动的比赛轮次。 */
  lastActionRace?: string | null;
  gaslyLeaving: boolean;
  dismissed: string | null;
  log: Array<{ at: string; text: string }>;
}

export interface HaasState {
  geneSupport: number;
  toyotaSupport: number;
  toyotaInfluence: number;
  fundingProvided: number;
  preferredParts: PartType[];
  lastActionRound: string | null;
  /** 最近一次至少执行过股东行动的比赛轮次。 */
  lastActionRace?: string | null;
  partnershipWithdrawn: boolean;
  dismissed: string | null;
  log: Array<{ at: string; text: string }>;
}

export interface WilliamsState {
  vowlesConfidence: number;
  successionReadiness: number;
  focus: 'facilities' | 'development' | 'reserve' | null;
  focusRound: string | null;
  /** 最近一次设置预算方向的比赛轮次。 */
  focusRace?: string | null;
  facilityInvestment: number;
  developmentInvestment: number;
  vowlesDeparted: boolean;
  confirmedSuccessor: boolean;
  log: Array<{ at: string; text: string }>;
}

export type RandomEventKind = 'none' | 'routine_social' | 'routine_factory' | 'routine_team' | 'driver_injury' | 'wind_tunnel_data' | 'part_issue';
export type RandomEventCategory = 'routine' | 'problem';
export type RandomEventStatus = 'none' | 'pending_generation' | 'awaiting_player' | 'awaiting_narration' | 'resolved' | 'unresolved';
export type RandomEventEffectOp = 'driver_fitness' | 'driver_morale' | 'funds' | 'project_weeks' | 'part_reliability' | 'staff_skill' | 'aero_hours' | 'affinity';
export interface RandomEventEffect {
  op: RandomEventEffectOp;
  targetId: string | null;
  delta: number;
  reason: string;
}
export interface RandomEventRecord {
  id: string;
  roundKey: string;
  kind: RandomEventKind;
  category: RandomEventCategory;
  status: RandomEventStatus;
  title: string;
  detail: string;
  prompt: string;
  answerOptions: string[];
  playerAnswer: string | null;
  mainReply: string | null;
  outcomeSummary: string | null;
  effects: RandomEventEffect[];
  generationError: string | null;
  /** 本事件需要完成的玩家-AI 对话轮数。 */
  totalDialogueTurns: number;
  /** 已收到有效主 API 回复的轮数。 */
  completedDialogueTurns: number;
  dialogue: Array<{ player: string; assistant: string }>;
}
export interface RandomEventState {
  lastRoundKey: string | null;
  weekKey: string | null;
  weeklyQuota: number;
  weeklyStarted: number;
  current: RandomEventRecord | null;
  history: RandomEventRecord[];
}

export type FiaMeetingIssue = 'aduo' | 'driver_safety' | 'cost_cap';
export interface FiaMeetingState {
  politicalCapital: number;
  completed: number;
  current: { index: number; issue: FiaMeetingIssue; opponents: string[] } | null;
  log: Array<{ at: string; text: string }>;
}

export interface SeasonState {
  year: number;
  /** 第几个赛季（从 1 开始） */
  number: number;
  roundIndex: number;
  phase: Phase;
  /** 本赛季已过去的周数 */
  week: number;
  /** 距下一站比赛周末的完整工厂周数；旧存档在赛前阶段默认为 0。 */
  weeksUntilRound?: number;
}

export interface GameState {
  schema: 1;
  gameId: string;
  meta: GameMeta;
  /** 随机数状态（uint32） */
  rng: number;
  /** 自增 id 计数器 */
  seq: number;
  rules: Rules;
  tracks: Record<string, TrackDef>;
  calendar: RoundDef[];
  season: SeasonState;
  teams: Record<string, TeamState>;
  /** 车队显示顺序 */
  teamOrder: string[];
  drivers: Record<string, DriverState>;
  /** 版本化的确定性休赛期市场。 */
  market?: MarketState;
  standings: Standings;
  weekend: WeekendState | null;
  history: RoundSummary[];
  news: NewsItem[];
  /** 待 AI 叙述的事件队列（AI 回复后清空） */
  narration: NarrationEvent[];
  /** 最近一次 AI 回复已叙述的事件（供状态条展示） */
  narrated: NarrationEvent[];
  flags: Record<string, string | number | boolean>;
  aiLog: AiLogEntry[];
  supernatural: SupernaturalState;
  /** 法拉利特殊机制（非法拉利开局或旧存档为 null / 缺省） */
  ferrari?: FerrariState | null;
  mclaren?: McLarenState | null;
  mercedes?: MercedesState | null;
  redBull?: RedBullState | null;
  astonMartin?: AstonMartinState | null;
  racingBulls?: RacingBullsState | null;
  audi?: AudiState | null;
  alpine?: AlpineState | null;
  haas?: HaasState | null;
  williams?: WilliamsState | null;
  randomEvents?: RandomEventState;
  fiaMeeting?: FiaMeetingState;
  /** ADUO 评估记录（旧存档缺省） */
  aduo?: AduoState | null;
  lastSeason: { year: number; driverChampion: string | null; constructorChampion: string | null; playerPosition: number | null } | null;
}

export interface MarketRoster {
  raceSeats: Record<string, string | null>;
  reserveIds: string[];
  staff: Record<StaffRole, string | null>;
}

export interface MarketAgreement {
  id: string;
  personKind: 'driver' | 'staff';
  personId: string;
  fromTeamId: string | null;
  toTeamId: string;
  driverRole?: 'race' | 'reserve';
  slot?: number;
  staffRole?: StaffRole;
  annualSalary: number;
  startYear: number;
  endYear: number;
  buyout: number;
  severance: number;
  windowId: string;
}

export interface MarketEscrow {
  id: string;
  payerTeamId: string;
  recipientTeamId: string | null;
  recipientPersonId: string | null;
  amount: number;
  category: 'buyout' | 'severance';
  capYear: number;
  settled: boolean;
}

export interface MarketRelease {
  id: string;
  personKind: 'driver' | 'staff';
  personId: string;
  teamId: string;
  effectiveYear: number;
  severance: number;
}

export interface MarketWindow {
  id: string;
  targetYear: number;
  status: 'open' | 'ai_resolved' | 'closed';
  strengthByTeam: Record<string, number>;
  candidateProfiles: Record<string, CandidatePreference>;
  agreements: MarketAgreement[];
  releases: MarketRelease[];
  projectedRosters: Record<string, MarketRoster>;
  escrow: MarketEscrow[];
  aiResolved: boolean;
}

export interface MarketState {
  version: 1;
  revision: number;
  freeStaff: Record<string, StaffMember>;
  window: MarketWindow | null;
  completed: Array<{ year: number; personId: string; fromTeamId: string | null; toTeamId: string | null; role: string; annualSalary: number }>;
}

export interface ContractOfferTerms {
  windowId: string;
  marketRevision: number;
  personId: string;
  annualSalary: number;
  years: number;
  role?: 'race' | 'reserve';
  slot?: number;
  replacePersonId?: string;
}

export interface ContractQuote {
  windowId: string;
  marketRevision: number;
  terms: ContractOfferTerms;
  candidateDecision: 'accept' | 'reject';
  score: number;
  threshold: number;
  factors: Record<string, number>;
  blockers: string[];
  buyout: number;
  severance: number;
  cashDueNow: number;
  annualPayrollBefore: number;
  annualPayrollAfter: number;
  guaranteedSalaryTotal: number;
  capYear: number;
  capCharge: number;
  projectedCapRemaining: number;
  replacedPersonId: string | null;
}

// ───────────────────────────── 动作 ─────────────────────────────

export type Action =
  | { type: 'ADVANCE'; aiPlans?: Record<string, Partial<DriverPlan>> }
  | { type: 'START_SEASON' }
  | { type: 'ADVANCE_WEEK' }
  | { type: 'START_WEEKEND' }
  | { type: 'RUN_PRACTICE' }
  | { type: 'RETURN_PRACTICE_TYRES'; driverId: string; setIds: string[] }
  | { type: 'RUN_SPRINT_QUALIFYING' }
  | { type: 'RUN_SPRINT' }
  | { type: 'RUN_QUALIFYING' }
  | { type: 'RUN_RACE'; aiPlans?: Record<string, Partial<DriverPlan>> }
  | { type: 'START_RACE'; kind: 'race' | 'sprint'; aiPlans?: Record<string, Partial<DriverPlan>> }
  | { type: 'ADVANCE_RACE'; sessionId: string; expectedRevision: number; until: 'next_lap' | 'next_decision' }
  | { type: 'SET_RACE_TACTICS'; sessionId: string; expectedRevision: number; drivers: Array<{ driverId: string; paceMode?: PaceMode; energyMode?: EnergyMode; pitTiming?: PitTiming }>; orders?: TeamOrders }
  | { type: 'RESOLVE_RACE_DECISION'; sessionId: string; expectedRevision: number; windowId: string; drivers: Array<{ driverId: string; pit: 'auto' | 'stay_out' | 'box'; compound?: Compound; repairWing?: boolean; paceMode?: PaceMode; energyMode?: EnergyMode; pitTiming?: PitTiming }>; orders?: TeamOrders }
  | { type: 'FINISH_ROUND' }
  | { type: 'START_NEXT_SEASON' }
  | { type: 'OFFER_DRIVER_CONTRACT'; windowId: string; marketRevision: number; driverId: string; annualSalary: number; years: number; role: 'race' | 'reserve'; slot?: number; replaceDriverId?: string }
  | { type: 'OFFER_STAFF_CONTRACT'; windowId: string; marketRevision: number; candidateId: string; role: StaffRole; annualSalary: number; years: number; replaceStaffId?: string }
  | { type: 'RELEASE_PERSON'; windowId: string; marketRevision: number; personKind: 'driver' | 'staff'; personId: string }
  | { type: 'RESOLVE_AI_MARKET'; windowId: string; marketRevision: number }
  | { type: 'SET_PLAN'; driverId: string; plan: Partial<DriverPlan> }
  | { type: 'SET_TEAM_ORDERS'; orders: TeamOrders }
  | { type: 'SET_PRIORITY'; driverId: string | null }
  | { type: 'START_PROJECT'; partType: PartType; ambition: Ambition; rush?: boolean }
  | { type: 'CANCEL_PROJECT'; projectId: string }
  | { type: 'ORDER_UNITS'; partType: PartType; specId: string; qty: number }
  | { type: 'FIT_PART'; slot: number; partType: PartType; specId: string }
  | { type: 'UPGRADE_FACILITY'; facility: FacilityType }
  | { type: 'TRAIN_PIT_CREW'; focus?: PitCrewFocus }
  | { type: 'TRAIN_DRIVER'; driverId: string; attr: DriverAttr }
  | { type: 'SET_NEXT_SEASON_FOCUS'; value: number }
  | { type: 'START_MCLAREN_FIX'; route: 'independent' | 'mercedes' }
  | { type: 'MERCEDES_POLITICS'; strategy: 'lobby_aduo' | 'defend' | 'compromise' }
  | { type: 'RED_BULL_RETAIN_GP' }
  | { type: 'ASTON_CRISIS'; strategy: 'pressure_honda' | 'mediate' | 'push_newey' }
  | { type: 'RACING_BULLS_SELECT_RESERVE'; driverId: string }
  | { type: 'AUDI_ALLIANCE' }
  | { type: 'ALPINE_MANAGEMENT'; strategy: 'back_colapinto' | 'reassure_gasly' | 'integrate_power_unit' }
  | { type: 'HAAS_BALANCE'; strategy: 'protect_independence' | 'accept_toyota' | 'compromise' }
  | { type: 'WILLIAMS_BUDGET_FOCUS'; focus: 'facilities' | 'development' | 'reserve' }
  | { type: 'FIA_DEBATE'; stance: 'support' | 'oppose' | 'compromise' }
  | { type: 'SWAP_DRIVER'; slot: number; driverId: string }
  | { type: 'CLEAR_NARRATION' };

export interface ActionResult {
  ok: boolean;
  state: GameState;
  /** 给玩家看的一句话结果 */
  message: string;
  error?: string;
}
