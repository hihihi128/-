/**
 * 后端控制器：把纯逻辑引擎接到酒馆事件上。
 *
 * 职责：
 * - 读取世界书数据、开局、存档（修订版本 + 楼层指针）。
 * - 面板动作 → 引擎 dispatch → 新版本挂到最新楼层。
 * - AI 回复到达 → 解析 <F1M_UPDATE> 白名单指令 → 结算 → 新版本挂到该楼。
 * - 每次生成前把「实时数据」注入提示词。
 * - 在 AI 回复末尾补上 <F1M_HUD/> 占位符（正则会把它渲染成状态条）。
 */
import { dispatch } from '../engine/actions';
import { normalizeDatabase, type NormalizeResult } from '../engine/data';
import { LABELS } from '../engine/defaults';
import {
  previewDriverTraining,
  previewFacility,
  previewManufacture,
  previewProject,
  type ProjectPreview,
} from '../engine/development';
import { createGame, type NewGameOptions } from '../engine/newgame';
import { migrateState } from '../engine/migrate';
import { previewContractOffer } from '../engine/market';
import { buildStatePrompt } from '../engine/prompt';
import { applyAiCommands, describeLog, parseAiCommands } from '../engine/protocol';
import { carRatings, driverOverall, moraleLabel, trackScore } from '../engine/ratings';
import { raceEngineerFor, strategyDecisionSkill } from '../engine/staff';
import { strategyOptions } from '../engine/strategy';
import { applySupernaturalCommands, effectiveSetup, parseSupernaturalCommands, SUPERNATURAL_LIMITS } from '../engine/supernatural';
import { dismissalReason } from '../engine/teamSpecials';
import type { Action, Ambition, ContractOfferTerms, DataIssue, DriverAttr, DriverPlan, FacilityType, GameState, StaffRole } from '../engine/types';
import { hashString, money, round1 } from '../engine/util';
import { buildView, supernaturalAvailability, type GameView } from '../engine/view';
import type { TavernEnv, TextGenerationOptions } from './env';
import { AI_PTR, GAME_PTR, PTR, SaveStore, type RevisionInfo } from './store';

export const HUD_TAG = '<F1M_HUD/>';
export const DATA_PREFIX = '[F1M数据]';
export const INJECT_ID = 'f1m_state';
export const CHANGE_EVENT = 'f1m_changed';
export const VERSION = '0.1.0';
/** 酒馆流式生成开始时 AI 楼层的占位文本 */
const STREAM_PLACEHOLDER = '...';

interface ProcessOptions {
  type?: string;
  force?: boolean;
  /** 来自 GENERATION_ENDED 的兜底结算 */
  fallback?: boolean;
}

interface AiGridStrategyCandidate {
  driverId: string;
  options: ReturnType<typeof strategyOptions>;
}

interface AiGridStrategyResult {
  plans: Record<string, Partial<DriverPlan>>;
  generated: number;
  fallback: number;
}

function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('策略 API 没有返回 JSON');
  return JSON.parse(text.slice(start, end + 1));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('策略 API 请求超时')), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface Settings {
  inject: boolean;
  injectDepth: number;
  injectRole: 'system' | 'user' | 'assistant';
  scanWorldInfo: boolean;
  protocolReminder: boolean;
  hudEnabled: boolean;
  maxRevisions: number;
  narrationText: string;
  autoNarrate: boolean;
  engineerApi: 'main' | 'secondary';
  engineerProxyPreset: string;
  engineerApiUrl: string;
  engineerApiKey: string;
  engineerModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  inject: true,
  injectDepth: 1,
  injectRole: 'system',
  scanWorldInfo: true,
  protocolReminder: true,
  hudEnabled: true,
  maxRevisions: 30,
  narrationText: '（领队查看了最新的数据。请根据【待叙述事件】继续叙事。）',
  autoNarrate: false,
  engineerApi: 'main',
  engineerProxyPreset: '',
  engineerApiUrl: '',
  engineerApiKey: '',
  engineerModel: '',
};

export interface Outcome {
  ok: boolean;
  message: string;
}

export interface EngineerStrategyResult extends Outcome {
  plan?: Partial<DriverPlan>;
  explanation?: string;
  api?: 'main' | 'secondary';
  strategyLevel?: string;
  gridPosition?: number | null;
  weatherResponse?: string;
  mode?: 'engineer' | 'perfect';
}

export interface SupernaturalInterventionResult extends Outcome {
  api: 'main' | 'secondary';
  revisionId: string | null;
  results: import('../engine/types').AiLogEntry[];
}

function safeWeatherAdvice(text: string, hasRainWindow: boolean): boolean {
  if (!hasRainWindow) return true;
  const mentionsWetTyre = /(半雨胎|全雨胎|雨胎|intermediate|\binter\b|wet tyre)/i.test(text);
  const contradictsTransition = /(别管.{0,8}(雨|预报)|不管.{0,8}(雨|预报)|全干胎|坚持.{0,12}干胎|下雨.{0,8}(别急|不急)|真下雨.{0,8}(别急|不急)|留在赛道.{0,12}(看看|观察)|不换.{0,8}雨胎|别换.{0,8}雨胎)/i.test(text);
  return mentionsWetTyre && !contradictsTransition;
}

export interface DataReport {
  ok: boolean;
  origin: string;
  entries: string[];
  issues: DataIssue[];
  teams: Array<{ id: string; name: string; color: string; targetPosition: number; description: string; special: string; drivers: string[] }>;
  specialRules?: {
    astonMartin: { vibrationInterval: number; vibrationRetireChance: number };
    racingBulls: { recallChance: number };
    audi: { startDropMin: number; startDropMax: number };
  };
  summary: string;
}

export interface HudView {
  ready: boolean;
  hasGame: boolean;
  floor: number;
  isLatest: boolean;
  /** 这一楼本身是否有存档版本 */
  ownRevision: boolean;
  team?: { name: string; color: string; rank: number; points: number; funds: string; cap: string; board: number };
  season?: { label: string; phase: string; track: string; trackType: string; next: string | null };
  cars?: Array<{ slot: number; driver: string; score: number | null; overall: number }>;
  drivers?: Array<{ id: string; name: string; morale: number; moraleLabel: string; trust: number; overall: number; points: number }>;
  projects?: Array<{ label: string; weeksLeft: number; progress: number }>;
  lastRace?: string | null;
  /** Public only: current progress/control state, never hidden weather or strategy. */
  liveRace?: { lap: number; totalLaps: number; raceControl: 'sc' | 'vsc' | 'red_flag' | null; pendingDecision: boolean } | null;
  /** 法拉利过渡领队考核（只有法拉利存档有） */
  ferrari?: { media: number; minMedia: number; warnMedia: number; fans: Array<{ name: string; value: number }>; gap: number; maxFanGap: number; warnFanGap: number; dismissed: string | null };
  dismissal?: string | null;
  changes: string[];
  narrated: string[];
  pending: number;
  warning?: string;
}

export class F1Controller {
  store: SaveStore;
  settings: Settings = { ...DEFAULT_SETTINGS };
  data: (NormalizeResult & { canStart: boolean; origin: string; entries: string[] }) | null = null;
  private busy = false;
  /** 「继续生成」开始时被续写楼层的原文（用于只结算新续写的部分） */
  private continuing: { floor: number; text: string } | null = null;
  private listeners = new Set<(reason: string) => void>();

  constructor(private env: TavernEnv) {
    this.store = new SaveStore(env, { maxRevisions: DEFAULT_SETTINGS.maxRevisions, protectFloors: 12 });
  }

  // ───────────────────────────── 生命周期 ─────────────────────────────

  init(): void {
    this.loadSettings();
    this.store.load();
    const e = this.env.events;
    this.env.on(e.MESSAGE_RECEIVED, (id: number, type?: string) => void this.onMessageReceived(Number(id), type));
    this.env.on(e.GENERATION_ENDED, () => void this.onGenerationEnded());
    this.env.on(e.GENERATION_AFTER_COMMANDS, (type: string, _opts: unknown, dryRun: boolean) => this.onGenerationStart(type, dryRun));
    this.env.on(e.MESSAGE_EDITED, (id: number) => void this.onMessageEdited(Number(id)));
    this.env.on(e.CHAT_CHANGED, () => this.onChatChanged());
    for (const ev of [e.MESSAGE_SWIPED, e.MESSAGE_DELETED, e.MESSAGE_SENT, e.MESSAGE_UPDATED]) {
      this.env.on(ev, () => this.notify('chat'));
    }
    this.env.registerMacro(/\{\{f1m_state\}\}/gi, () => this.promptForLatest() ?? '');
  }

  loadSettings(): void {
    const raw = this.env.getScriptVars()?.settings ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...raw };
    this.store.opts.maxRevisions = this.settings.maxRevisions;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings, ...patch };
    next.injectDepth = Math.max(0, Math.min(20, Math.round(Number(next.injectDepth) || 0)));
    next.maxRevisions = Math.max(8, Math.min(200, Math.round(Number(next.maxRevisions) || DEFAULT_SETTINGS.maxRevisions)));
    if (!['system', 'user', 'assistant'].includes(next.injectRole)) next.injectRole = 'system';
    if (!['main', 'secondary'].includes(next.engineerApi)) next.engineerApi = 'main';
    next.engineerProxyPreset = String(next.engineerProxyPreset ?? '').trim();
    next.engineerApiUrl = String(next.engineerApiUrl ?? '').trim();
    next.engineerApiKey = String(next.engineerApiKey ?? '').trim();
    next.engineerModel = String(next.engineerModel ?? '').trim();
    this.settings = next;
    this.store.opts.maxRevisions = next.maxRevisions;
    const vars = this.env.getScriptVars() ?? {};
    this.env.setScriptVars({ ...vars, settings: next });
    if (!next.inject) this.env.uninject(INJECT_ID);
    this.notify('settings');
    return next;
  }

  private secondaryApiError(): string | null {
    if (this.settings.engineerProxyPreset) return null;
    if (!this.settings.engineerApiUrl) return '请先在设置中填写副 API 站点，或填写代理预设名称';
    try {
      const url = new URL(this.settings.engineerApiUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    } catch {
      return '副 API 站点必须是有效的 http:// 或 https:// 地址';
    }
    if (!this.settings.engineerModel) return '使用副 API 站点时必须填写模型名称';
    return null;
  }

  private secondaryApiOptions(): TextGenerationOptions {
    return {
      ...(this.settings.engineerProxyPreset ? { proxyPreset: this.settings.engineerProxyPreset } : {}),
      ...(this.settings.engineerApiUrl ? { apiUrl: this.settings.engineerApiUrl } : {}),
      ...(this.settings.engineerApiKey ? { apiKey: this.settings.engineerApiKey } : {}),
      ...(this.settings.engineerModel ? { model: this.settings.engineerModel } : {}),
    };
  }

  subscribe(fn: (reason: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(reason: string): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(reason);
      } catch {
        this.listeners.delete(fn);
      }
    }
    this.env.emit(CHANGE_EVENT, reason);
  }

  // ───────────────────────────── 查询 ─────────────────────────────

  latestFloor(): number {
    return this.env.lastMessageId();
  }

  stateAt(floor?: number): GameState | null {
    const f = floor ?? this.latestFloor();
    return this.store.resolve(f)?.state ?? null;
  }

  view(floor?: number): GameView | null {
    const s = this.stateAt(floor);
    return s ? buildView(s) : null;
  }

  status() {
    const last = this.latestFloor();
    const resolved = this.store.resolveRev(last);
    return {
      version: VERSION,
      ready: true,
      chatId: this.env.chatId(),
      hasGame: !!resolved,
      generating: this.env.isGenerating(),
      latestFloor: last,
      anchorFloor: resolved?.floor ?? null,
      revisionId: resolved?.rev.id ?? null,
      fallback: resolved?.fallback ?? false,
      revisions: this.store.revisionCount,
      storeSize: this.store.totalSize,
      settings: { ...this.settings, engineerApiKey: '' },
      data: this.data
        ? {
            canStart: this.data.canStart,
            origin: this.data.origin,
            entries: this.data.entries,
            errors: this.data.issues.filter(i => i.level === 'error').length,
            warnings: this.data.issues.filter(i => i.level === 'warning').length,
          }
        : null,
      userName: this.env.userName(),
    };
  }

  hud(floor: number): HudView {
    const last = this.latestFloor();
    const vars = this.env.getMessageVars(floor);
    const resolved = this.store.resolveRev(floor);
    const base: HudView = {
      ready: true,
      hasGame: !!resolved,
      floor,
      isLatest: floor >= last,
      ownRevision: typeof vars[PTR] === 'string' && resolved?.floor === floor,
      changes: Array.isArray(vars.f1m_changes) ? vars.f1m_changes.slice(0, 8) : [],
      narrated: Array.isArray(vars.f1m_narrated) ? vars.f1m_narrated.slice(0, 6) : [],
      pending: 0,
    };
    if (!resolved) return base;
    const s = this.store.stateOf(resolved.rev);
    const team = s.teams[s.meta.playerTeamId];
    const round = s.calendar[s.season.roundIndex];
    const track = round ? s.tracks[round.trackId] : undefined;
    const v = buildView(s);
    const next = v.next;
    const lastHist = s.history[s.history.length - 1];
    let lastRace: string | null = null;
    if (lastHist) {
      const mine = lastHist.results
        .filter(([id]) => s.drivers[id]?.teamId === team.id)
        .map(([id, pos]) => `${s.drivers[id]?.short ?? id} ${pos === null ? 'DNF' : `P${pos}`}`)
        .join(' / ');
      lastRace = `${lastHist.trackName}：${mine}`;
    }
    return {
      ...base,
      team: {
        name: team.name,
        color: team.color,
        rank: v.player.rank,
        points: v.player.points,
        funds: money(team.funds),
        cap: money(v.player.capRemaining),
        board: Math.round(team.boardConfidence),
      },
      season: {
        label: `${s.season.year} · 第 ${s.season.roundIndex + 1}/${s.calendar.length} 站`,
        phase: LABELS.phase[s.season.phase],
        track: track?.name ?? '',
        trackType: track?.type ?? '',
        next: next?.label ?? null,
      },
      cars: team.cars.map(c => {
        const r = carRatings(team, c, s.rules, 'disclosed');
        return {
          slot: c.slot,
          driver: c.driverId ? s.drivers[c.driverId]?.short ?? c.driverId : '—',
          score: track && s.season.phase !== 'season_end' ? round1(trackScore(r, track)) : null,
          overall: r.overall,
        };
      }),
      drivers: team.cars
        .filter(c => c.driverId)
        .map(c => {
          const d = s.drivers[c.driverId!];
          return {
            id: d.id,
            name: d.name,
            morale: Math.round(d.morale),
            moraleLabel: moraleLabel(d.morale),
            trust: Math.round(d.trust),
            overall: driverOverall(d),
            points: s.standings.drivers[d.id]?.points ?? 0,
          };
        }),
      projects: team.projects.slice(0, 4).map(p => ({
        label: p.label,
        weeksLeft: p.weeksLeft,
        progress: Math.round(((p.weeksTotal - p.weeksLeft) / Math.max(1, p.weeksTotal)) * 100),
      })),
      lastRace,
      liveRace: v.weekend?.liveRace
        ? {
            lap: v.weekend.liveRace.completedLaps,
            totalLaps: v.weekend.liveRace.totalLaps,
            raceControl: v.weekend.liveRace.raceControl,
            pendingDecision: !!v.weekend.liveRace.pendingDecision,
          }
        : null,
      ferrari: v.ferrari
        ? {
            media: Math.round(v.ferrari.media),
            minMedia: v.ferrari.minMedia,
            warnMedia: v.ferrari.warnMedia,
            fans: v.ferrari.fans.map(f => ({ name: s.drivers[f.driverId]?.short ?? f.name, value: Math.round(f.value) })),
            gap: Math.round(v.ferrari.gap),
            maxFanGap: v.ferrari.maxFanGap,
            warnFanGap: v.ferrari.warnFanGap,
            dismissed: v.ferrari.dismissed,
          }
        : undefined,
      dismissal: v.mercedes?.dismissed ?? null,
      pending: s.narration.length,
      warning: resolved.fallback ? '该楼层原本的存档版本已被清理，显示的是最早仍保留的版本。' : undefined,
    };
  }

  previewProject(partType: string, ambition: Ambition, rush: boolean): ProjectPreview | null {
    const s = this.stateAt();
    return s ? previewProject(s, s.meta.playerTeamId, partType, ambition, rush) : null;
  }

  previewManufacture(partType: string, specId: string, qty: number) {
    const s = this.stateAt();
    return s ? previewManufacture(s, s.meta.playerTeamId, partType, specId, qty) : null;
  }

  previewFacility(facility: FacilityType) {
    const s = this.stateAt();
    return s ? previewFacility(s, s.meta.playerTeamId, facility) : null;
  }

  previewDriverTraining(driverId: string, attr: DriverAttr) {
    const s = this.stateAt();
    return s ? previewDriverTraining(s, s.meta.playerTeamId, driverId, attr) : null;
  }

  previewContractOffer(terms: ContractOfferTerms, kind: 'driver' | 'staff', role?: StaffRole) {
    const s = this.stateAt();
    return s ? previewContractOffer(s, s.meta.playerTeamId, terms, kind, role) : null;
  }

  promptForLatest(): string | null {
    const s = this.stateAt();
    return s ? buildStatePrompt(s, { protocolReminder: this.settings.protocolReminder }) : null;
  }

  listRevisions(): RevisionInfo[] {
    const r = this.store.resolveRev(this.latestFloor());
    return this.store.list(r?.rev.id ?? null);
  }

  // ───────────────────────────── 数据与开局 ─────────────────────────────

  async loadData(): Promise<DataReport> {
    const { entries, origin } = await this.env.readWorldbookEntries(DATA_PREFIX);
    const sources = [];
    const parseIssues: DataIssue[] = [];
    for (const e of entries) {
      try {
        sources.push({ name: e.name, data: this.env.parseYaml(e.content) });
      } catch (err) {
        parseIssues.push({ level: 'error', source: e.name, path: '(YAML)', message: `YAML 语法错误：${err instanceof Error ? err.message : String(err)}` });
      }
    }
    const res = normalizeDatabase(sources);
    res.issues.unshift(...parseIssues);
    if (entries.length === 0) {
      res.issues.unshift({ level: 'error', source: '世界书', path: '', message: `没有找到名字以「${DATA_PREFIX}」开头的世界书条目。请确认已导入角色卡自带的世界书。` });
    }
    const canStart = res.canStart && parseIssues.length === 0 && entries.length > 0;
    this.data = { ...res, canStart, origin, entries: entries.map(e => e.name) };
    const db = res.db;
    return {
      ok: canStart,
      origin,
      entries: entries.map(e => e.name),
      issues: res.issues,
      teams: (db?.teams ?? []).map(t => ({
        id: t.id,
        name: t.name,
        color: t.color,
        targetPosition: t.targetPosition,
        description: t.description,
        special: t.special,
        drivers: (db?.drivers ?? []).filter(d => d.teamId === t.id && d.role === 'race').map(d => d.name),
      })),
      specialRules: db ? {
        astonMartin: { vibrationInterval: db.rules.astonMartin.vibrationInterval, vibrationRetireChance: db.rules.astonMartin.vibrationRetireChance },
        racingBulls: { recallChance: db.rules.racingBulls.recallChance },
        audi: { startDropMin: db.rules.audi.startDropMin, startDropMax: db.rules.audi.startDropMax },
      } : undefined,
      summary: db ? `${db.teams.length} 支车队 · ${db.drivers.length} 名车手 · ${db.tracks.length} 条赛道 · ${db.calendar.length} 站` : '无数据',
    };
  }

  async newGame(opts: Partial<NewGameOptions> & { playerTeamId: string }): Promise<Outcome> {
    if (this.env.isGenerating()) return { ok: false, message: 'AI 正在生成，请稍后再开局' };
    const report = await this.loadData();
    if (!report.ok || !this.data?.db) {
      const first = report.issues.find(i => i.level === 'error');
      return { ok: false, message: `数据有错误，无法开局${first ? `：${first.source} ${first.path} ${first.message}` : ''}` };
    }
    let state: GameState;
    try {
      state = createGame(this.data.db, {
        playerTeamId: opts.playerTeamId,
        principalName: opts.principalName?.trim() || this.env.userName(),
        difficulty: opts.difficulty ?? 'normal',
        randomness: opts.randomness ?? 'deterministic',
        seed: opts.seed,
        selectionReason: opts.selectionReason,
        supernaturalMode: opts.supernaturalMode === true,
      });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    this.store.reset(state.gameId);
    const floor = Math.max(0, this.latestFloor());
    this.store.commit(state, { floor, kind: 'new', label: `新开局：${state.teams[state.meta.playerTeamId].name}`, parent: null });
    this.notify('new_game');
    const role = state.ferrari ? '过渡领队' : state.mclaren || state.astonMartin ? '临时领队' : state.mercedes || state.racingBulls || state.audi || state.alpine ? '副领队' : state.haas ? '共同领队' : state.williams ? '接班人' : state.redBull ? '助理领队' : '领队';
    return { ok: true, message: `已开局：你现在是 ${state.teams[state.meta.playerTeamId].name} 的${role}` };
  }

  // ───────────────────────────── 动作 ─────────────────────────────

  async dispatch(action: Action): Promise<Outcome> {
    if (this.busy) return { ok: false, message: '上一个操作还在处理中' };
    if (this.env.isGenerating()) return { ok: false, message: 'AI 正在生成回复，请等待生成结束后再操作' };
    const floor = this.latestFloor();
    let cur = this.store.resolve(floor);
    if (!cur) return { ok: false, message: '还没有开局' };
    this.busy = true;
    try {
      let preparedAction = action;
      let strategySummary = '';
      const startsRace = (action.type === 'START_RACE' && action.kind === 'race') || action.type === 'RUN_RACE' || action.type === 'ADVANCE';
      if (startsRace && cur.state.season.phase === 'race' && cur.state.weekend && !cur.state.weekend.liveRace) {
        const guard = { chatId: this.env.chatId(), gameId: cur.state.gameId, revisionId: cur.rev.id, floor };
        const prepared = await this.prepareAiGridStrategies(cur.state);
        const currentFloor = this.latestFloor();
        const current = this.store.resolve(currentFloor);
        if (this.env.chatId() !== guard.chatId || currentFloor !== guard.floor || !current || current.state.gameId !== guard.gameId || current.rev.id !== guard.revisionId || current.state.season.phase !== 'race' || current.state.weekend?.liveRace) {
          return { ok: false, message: '等待策略 API 时比赛状态已变化，请重新开始正赛' };
        }
        cur = current;
        preparedAction = { ...action, aiPlans: prepared.plans };
        strategySummary = `；赛前策略：API ${prepared.generated} 辆，本地补全 ${prepared.fallback} 辆`;
      }
      const res = dispatch(cur.state, preparedAction);
      if (!res.ok) return { ok: false, message: res.message };
      this.store.commit(res.state, { floor: Math.max(0, floor), kind: 'ui', label: res.message });
      this.notify('action');
      if (this.settings.autoNarrate && isSimulation(action) && res.state.narration.length) {
        void this.requestNarration();
      }
      return { ok: true, message: `${res.message}${strategySummary}` };
    } finally {
      this.busy = false;
    }
  }

  /**
   * One batch API request assigns distinct plans to every non-player car.
   * Missing, duplicated, or invalid rows are omitted so the engine can fill
   * only those cars with its deterministic team/driver-aware local strategy.
   */
  private async prepareAiGridStrategies(state: GameState): Promise<AiGridStrategyResult> {
    const weekend = state.weekend;
    const round = weekend && state.calendar[weekend.roundIndex];
    const track = round && state.tracks[round.trackId];
    if (!weekend || !track) return { plans: {}, generated: 0, fallback: 0 };

    const entries = Object.values(state.teams).flatMap(team => team.cars.flatMap(car => {
      const driver = car.driverId ? state.drivers[car.driverId] : null;
      return driver ? [{ team, car, driver }] : [];
    }));
    const activeIds = new Set(entries.map(entry => entry.driver.id));
    const grid = (weekend.qualifying?.grid ?? []).filter(id => activeIds.has(id));
    for (const entry of [...entries].sort((a, b) => trackScore(carRatings(b.team, b.car, state.rules, 'disclosed'), track) - trackScore(carRatings(a.team, a.car, state.rules, 'disclosed'), track))) {
      if (!grid.includes(entry.driver.id)) grid.push(entry.driver.id);
    }
    const aiEntries = entries.filter(entry => !entry.team.isPlayer);
    const candidates: AiGridStrategyCandidate[] = aiEntries
      .map(entry => {
        const setup = weekend.setup[entry.driver.id] ?? { confidence: 40, tyreKnowledge: 30, qualiBonus: 0 };
        const ratings = carRatings(entry.team, entry.car, state.rules, 'disclosed');
        return {
          driverId: entry.driver.id,
          options: strategyOptions(state.rules, track, track.laps, {
            driverTyre: entry.driver.attrs.tyre,
            carTyre: ratings.tyre,
            paceMode: 'balanced',
            knowledge: setup.tyreKnowledge,
          }, { wet: false, sprint: false }).slice(0, 5),
        };
      });
    const byDriver = new Map(candidates.map(candidate => [candidate.driverId, candidate]));
    const expected = candidates.length;
    if (!expected) return { plans: {}, generated: 0, fallback: 0 };

    const rows = aiEntries.map(entry => {
      const candidate = byDriver.get(entry.driver.id)!;
      const engineer = raceEngineerFor(entry.team, entry.car.slot);
      const options = candidate.options.map((option, index) => `${index}:${option.compounds.join('-')}/${option.stops}停/${option.stints.join('-')}圈`).join('；');
      return [
        `driverId=${entry.driver.id}；车手=${entry.driver.name}；车队=${entry.team.name}；发车位=P${grid.indexOf(entry.driver.id) + 1}`,
        `策略师=${entry.team.staff.strategist.name}(${entry.team.staff.strategist.skill})；比赛工程师=${engineer.name}；本车策略判断=${strategyDecisionSkill(entry.team, entry.car.slot)}`,
        `车手特性：轮胎管理${entry.driver.attrs.tyre}，稳定性${entry.driver.attrs.consistency}，缠斗${entry.driver.attrs.racecraft}；候选=${options}`,
      ].join('；');
    });
    const rainWindow = weekend.forecast.raceRainWindow;
    const prompt = [
      '你是 F1 全场策略总监。请为下面每一辆 AI 赛车独立选择赛前策略。不同车队和车手不能机械地使用相同方案。',
      `赛道=${track.name}；圈数=${track.laps}；正赛降雨概率=${Math.round(weekend.forecast.race * 100)}%；公开降雨窗口=${rainWindow ? `${rainWindow[0]}-${rainWindow[1]}圈` : '无明确窗口'}。`,
      '综合发车位、候选方案、策略部门能力、比赛工程师和车手特性。强队不必总选同一候选；落后车辆可以更激进。',
      ...rows,
      '只输出一个 JSON 对象，不要代码块或解释。格式：',
      '{"strategies":[{"driverId":"车手ID","option":0,"paceMode":"conserve|balanced|push","pitTiming":"early|standard|late","scReaction":true}]}',
      `strategies 必须包含全部 ${expected} 辆 AI 赛车，每个 driverId 只出现一次。option 必须使用该车候选编号。`,
    ].join('\n');

    const api = this.settings.engineerApi;
    if (api === 'secondary' && this.secondaryApiError()) return { plans: {}, generated: 0, fallback: expected };
    try {
      const generated = await withTimeout(
        this.env.generateText(prompt, api === 'secondary' ? this.secondaryApiOptions() : undefined),
        25_000,
      );
      const parsed = parseJsonObject(generated) as { strategies?: unknown };
      if (!Array.isArray(parsed.strategies)) return { plans: {}, generated: 0, fallback: expected };
      const plans: Record<string, Partial<DriverPlan>> = {};
      for (const value of parsed.strategies) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        const driverId = typeof row.driverId === 'string' ? row.driverId : '';
        const candidate = byDriver.get(driverId);
        const optionIndex = typeof row.option === 'number' && Number.isInteger(row.option) ? row.option : -1;
        const option = candidate?.options[optionIndex];
        if (!candidate || !option || plans[driverId]) continue;
        if (row.paceMode !== 'conserve' && row.paceMode !== 'balanced' && row.paceMode !== 'push') continue;
        if (row.pitTiming !== 'early' && row.pitTiming !== 'standard' && row.pitTiming !== 'late') continue;
        if (typeof row.scReaction !== 'boolean') continue;
        plans[driverId] = {
          strategySource: 'engineer',
          tyrePlan: [...option.compounds],
          paceMode: row.paceMode,
          pitTiming: row.pitTiming,
          scReaction: row.scReaction,
        };
      }
      const count = Object.keys(plans).length;
      return { plans, generated: count, fallback: expected - count };
    } catch {
      return { plans: {}, generated: 0, fallback: expected };
    }
  }

  async restoreRevision(id: string): Promise<Outcome> {
    if (this.env.isGenerating()) return { ok: false, message: 'AI 正在生成，请稍后' };
    const rev = this.store.getRevision(id);
    if (!rev) return { ok: false, message: '找不到该存档版本' };
    const state = this.store.stateOf(rev);
    this.store.commit(state, { floor: Math.max(0, this.latestFloor()), kind: 'restore', label: `读档：${rev.label}` });
    this.notify('restore');
    return { ok: true, message: `已读取版本「${rev.label}」并挂到最新楼层` };
  }

  exportSave(): string | null {
    const s = this.stateAt();
    return s ? JSON.stringify({ format: 'f1m-save', version: VERSION, exportedAt: Date.now(), state: s }) : null;
  }

  async importSave(text: string): Promise<Outcome> {
    if (this.env.isGenerating()) return { ok: false, message: 'AI 正在生成，请稍后' };
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, message: '不是有效的 JSON' };
    }
    const state: GameState | undefined = parsed?.format === 'f1m-save' ? parsed.state : parsed;
    if (!state || state.schema !== 1 || !state.teams || !state.meta?.playerTeamId || !state.teams[state.meta.playerTeamId]) {
      return { ok: false, message: '存档格式不正确' };
    }
    migrateState(state);
    this.store.reset(state.gameId);
    this.store.commit(state, { floor: Math.max(0, this.latestFloor()), kind: 'import', label: '导入存档', parent: null });
    this.notify('import');
    return { ok: true, message: '存档已导入' };
  }

  /**
   * 车队工程师使用主 API 或已配置的副 API 解释一套后端选定的方案。
   * 方案排名严格按车队策略水平选择，避免强队与弱队得到同样聪明的建议。
   */
  async requestEngineerStrategy(driverId: string, requestedApi?: 'main' | 'secondary', perfect = false): Promise<EngineerStrategyResult> {
    if (this.env.isGenerating()) return { ok: false, message: '当前正在生成内容，请稍后再请求工程师建议' };
    const state = this.stateAt();
    if (!state?.weekend) return { ok: false, message: '比赛周末开始后才能请求工程师建议' };
    if (state.weekend.liveRace) return { ok: false, message: '比赛进行中，不能重新生成赛前策略' };
    const view = buildView(state);
    const driverView = view.weekend?.drivers.find(driver => driver.driverId === driverId);
    const driver = state.drivers[driverId];
    const team = state.teams[state.meta.playerTeamId];
    if (!driverView || !driver || driver.teamId !== team.id) return { ok: false, message: '找不到本队正式车手' };
    const car = team.cars.find(value => value.driverId === driverId);
    const round = state.calendar[state.weekend.roundIndex];
    const track = round ? state.tracks[round.trackId] : null;
    const perfectOptions = perfect && car && track
      ? strategyOptions(state.rules, track, track.laps, { driverTyre: driver.attrs.tyre, carTyre: carRatings(team, car, state.rules, 'disclosed').tyre, paceMode: 'balanced', knowledge: effectiveSetup(state, driverId, state.weekend.setup[driverId] ?? { confidence: 40, tyreKnowledge: 30, qualiBonus: 0 }).tyreKnowledge }, { wet: false, sprint: false }).slice(0, 6)
      : null;
    const availableOptions = perfectOptions ?? driverView.options;
    if (!availableOptions.length) return { ok: false, message: '当前没有可用的干地策略方案' };

    const slot = team.cars.find(car => car.driverId === driverId)?.slot ?? 1;
    const engineer = raceEngineerFor(team, slot);
    const decisionSkill = strategyDecisionSkill(team, slot);
    const level = perfect ? 0 : decisionSkill >= 90 ? 0 : decisionSkill >= 82 ? 1 : decisionSkill >= 73 ? 2 : decisionSkill >= 64 ? 3 : decisionSkill >= 55 ? 4 : 5;
    const labels = ['顶级', '优秀', '中游', '保守迟钝', '较差', '灾难级'];
    const activeDriverIds = new Set(Object.values(state.teams).flatMap(currentTeam => currentTeam.cars.map(car => car.driverId).filter((id): id is string => !!id)));
    const qualifyingGrid = (state.weekend.qualifying?.grid ?? []).filter(id => activeDriverIds.has(id));
    const gridPosition = qualifyingGrid.includes(driverId) ? qualifyingGrid.indexOf(driverId) + 1 : null;
    const rainWindow = state.weekend.forecast.raceRainWindow ?? null;
    const rainTarget = rainWindow ? (rainWindow[0] + rainWindow[1]) / 2 : null;
    const contextRanked = [...availableOptions].sort((a, b) => {
      const score = (option: typeof a) => {
        if (rainTarget === null) return option.cost;
        const stopsBeforeRain = option.stints.slice(0, -1).reduce<{ laps: number; count: number }>((acc, laps) => ({ laps: acc.laps + laps, count: acc.count + (acc.laps + laps < rainTarget ? 1 : 0) }), { laps: 0, count: 0 }).count;
        const frontPenalty = gridPosition !== null && gridPosition <= 5 && option.stints[0] < rainTarget ? 4 : 0;
        return option.cost + stopsBeforeRain * 12 + frontPenalty;
      };
      return score(a) - score(b);
    });
    const option = contextRanked[Math.min(level, contextRanked.length - 1)];
    const plan: Partial<DriverPlan> = {
      strategySource: perfect ? 'perfect' : 'engineer',
      tyrePlan: [...option.compounds],
      paceMode: level >= 4 ? (level === 5 ? 'conserve' : 'push') : 'balanced',
      pitTiming: level >= 4 ? 'late' : 'standard',
      scReaction: level < 4,
    };
    const api = requestedApi ?? this.settings.engineerApi;
    const secondaryError = api === 'secondary' ? this.secondaryApiError() : null;
    if (secondaryError) return { ok: false, message: secondaryError };
    const compounds = option.compounds.map(compound => state.rules.tyres[compound]?.name ?? compound).join(' → ');
    const gridContext = gridPosition === null ? '发车位尚未确定' : `从 P${gridPosition} 发车`;
    const weatherResponse = rainWindow
      ? rainWindow[0] <= 2
        ? `公开预报显示开局阶段可能降雨；发车前确认赛道，若已湿则直接使用半雨胎，若仍干燥则用 ${state.rules.tyres[option.compounds[0]]?.name ?? option.compounds[0]}短跑，赛道转湿后立即换半雨胎`
        : `公开预报显示第 ${rainWindow[0]}–${rainWindow[1]} 圈可能降雨；先用 ${state.rules.tyres[option.compounds[0]]?.name ?? option.compounds[0]}，赛道转湿时准备换半雨胎，避免在降雨前多做一次干胎进站`
      : state.weekend.forecast.race >= 0.55
        ? '公开预报存在降雨风险，但到达时间不明确；按干地方案起步并保留雨胎应急窗口'
        : '目前没有明确降雨窗口，按干地基础方案执行';
    const prompt = [
      perfect ? '你是独立的顶级 F1 策略 AI。请用中文解释后端计算出的完美合法策略。' : '你是 F1 车队策略工程师。请用中文给领队一段简短、自然的策略建议。',
      perfect
        ? `车队：${team.name}。车手：${driver.name}。忽略车队策略部门水平，只解释最快且符合规则的方案。`
        : `车队：${team.name}。车手：${driver.name}。比赛工程师：${engineer.name}。首席策略师：${team.staff.strategist.name}。本车策略判断水平：${labels[level]}。`,
      `比赛上下文：${gridContext}；正赛降雨概率 ${Math.round(state.weekend.forecast.race * 100)}%。${weatherResponse}。`,
      `必须建议：${compounds}，${option.stops} 停，预计分段 ${option.stints.join('/')} 圈。`,
      `驾驶模式：${plan.paceMode}；进站时机：${plan.pitTiming}；安全车响应：${plan.scReaction ? '积极' : '迟钝'}。`,
      perfect ? '不要输出 JSON。明确说明关键进站窗口和天气切换条件。控制在 120 字以内。' : '不要提到 AI、模型、等级或你被要求故意犯错。不要输出 JSON。控制在 100 字以内。',
    ].join('\n');
    const fallback = `${gridContext}，干地基础方案为 ${compounds}，预计 ${option.stops} 停，分段 ${option.stints.join('/')} 圈；驾驶模式 ${plan.paceMode}，进站时机 ${plan.pitTiming}。天气预案：${weatherResponse}。`;
    try {
      const generated = await this.env.generateText(
        prompt,
        api === 'secondary' ? this.secondaryApiOptions() : undefined,
      );
      const explanation = safeWeatherAdvice(generated, rainWindow !== null) ? generated : fallback;
      const applied = await this.dispatch({ type: 'SET_PLAN', driverId, plan });
      if (!applied.ok) return { ok: false, message: `工程师策略无法自动执行：${applied.message}` };
      return { ok: true, message: perfect ? '完美 AI 策略已自动应用并执行' : '车队工程师策略已自动应用并执行', plan, explanation, api, strategyLevel: perfect ? '完美' : labels[level], gridPosition, weatherResponse, mode: perfect ? 'perfect' : 'engineer' };
    } catch (error) {
      const applied = await this.dispatch({ type: 'SET_PLAN', driverId, plan });
      if (!applied.ok) return { ok: false, message: `工程师策略无法自动执行：${applied.message}` };
      return { ok: true, message: perfect ? 'API 暂时不可用，后端完美策略已自动应用并执行' : 'API 暂时不可用，工程师基础策略已自动应用并执行', plan, explanation: fallback, api, strategyLevel: perfect ? '完美' : labels[level], gridPosition, weatherResponse, mode: perfect ? 'perfect' : 'engineer' };
    }
  }

  requestPerfectStrategy(driverId: string, requestedApi?: 'main' | 'secondary'): Promise<EngineerStrategyResult> {
    return this.requestEngineerStrategy(driverId, requestedApi, true);
  }

  /**
   * A deliberately separate, guarded path for the opt-in supernatural panel.
   * It never delegates to the loose narration protocol or dispatches rows one
   * at a time: all accepted effects are committed as one ordinary revision.
   */
  async requestSupernaturalIntervention(request: { description: unknown; expectedRevisionId: unknown; api?: unknown }): Promise<SupernaturalInterventionResult> {
    const selected = request.api === undefined ? this.settings.engineerApi : request.api;
    const api: 'main' | 'secondary' = selected === 'secondary' ? 'secondary' : 'main';
    const fail = (message: string, results: import('../engine/types').AiLogEntry[] = []): SupernaturalInterventionResult => ({ ok: false, message, api, revisionId: null, results });
    if (selected !== 'main' && selected !== 'secondary') return fail('API 必须是 main 或 secondary');
    if (typeof request.description !== 'string' || !request.description.trim() || request.description.trim().length > 1000) return fail('干预描述必须为 1–1000 个非空字符');
    if (typeof request.expectedRevisionId !== 'string' || !request.expectedRevisionId) return fail('缺少当前存档版本号');
    if (this.busy || this.env.isGenerating()) return fail('当前已有生成或存档操作，请稍后再试');
    const secondaryError = api === 'secondary' ? this.secondaryApiError() : null;
    if (secondaryError) return fail(secondaryError);
    const floor = this.latestFloor();
    const current = this.store.resolve(floor);
    if (!current) return fail('还没有开局');
    const state = current.state;
    const team = state.teams[state.meta.playerTeamId];
    if (!state.meta.supernaturalMode || !team) return fail('本存档未启用超自然干预模式');
    if (current.rev.id !== request.expectedRevisionId) return fail('存档版本已变化，请刷新后重试');
    if (dismissalReason(state)) return fail('已被撤职，不能执行超自然干预');
    if (state.weekend?.liveRace || state.season.phase === 'season_end') return fail('当前阶段不能执行超自然干预');
    const guard = {
      chatId: this.env.chatId(), floor, gameId: state.gameId, revisionId: current.rev.id,
      phase: state.season.phase, year: state.season.year, roundIndex: state.season.roundIndex,
      liveId: state.weekend?.liveRace?.id ?? null,
    };
    const invocationId = `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const drivers = Object.values(state.drivers)
      .filter(driver => driver.teamId === team.id && (driver.role === 'race' || driver.role === 'reserve'))
      .map(driver => `${driver.id}=${driver.name}(${driver.role}; 心态${driver.morale} 信任${driver.trust} 体能${driver.fitness}; 属性 pace${driver.attrs.pace}/racecraft${driver.attrs.racecraft}/consistency${driver.attrs.consistency}/tyre${driver.attrs.tyre}/wet${driver.attrs.wet}/feedback${driver.attrs.feedback})`);
    const staff = Object.entries(team.staff).filter(([, member]) => !!member.id).map(([role, member]) => `${member.id}=${member.name}(${role}; skill${member.skill})`);
    const projects = team.projects.filter(project => project.kind === 'design').map(project => `${project.id}=${project.label}(剩余${project.weeksLeft}周)`);
    const currentWeekend = state.weekend?.roundIndex === state.season.roundIndex ? state.weekend : null;
    const setup = currentWeekend ? team.cars.filter(car => !!car.driverId).map(car => {
      const natural = currentWeekend.setup[car.driverId!]; const offset = currentWeekend.supernaturalCarEffects?.[car.driverId!];
      return natural ? `${car.driverId}: confidence=${natural.confidence}+${offset?.confidence ?? 0}, tyreKnowledge=${natural.tyreKnowledge}+${offset?.tyreKnowledge ?? 0}` : '';
    }).filter(Boolean) : [];
    const pending = state.supernatural.pendingWeather;
    const eligibility = supernaturalAvailability(state).categories;
    const prompt = [
      '你是严格的 F1 超自然干预编排器。只可建议下列引擎白名单 JSON 指令；引擎会自行拒绝非法请求。',
      `玩家请求：${request.description.trim()}`,
      `当前阶段=${state.season.phase}；年份/本站=${state.season.year}/${state.season.roundIndex + 1}；资金=${team.funds}M；董事会=${team.boardConfidence}；媒体=${team.mediaReputation}；员工士气=${team.staffMorale}。`,
      `车手（只能使用精确 ID）：${drivers.join('；') || '无'}。员工（只能使用精确 ID）：${staff.join('；') || '无'}。设计项目：${projects.join('；') || '无'}。`,
      `公开天气倾向=${pending?.rainBias ?? 0}；本站临时调校=${setup.join('；') || '周末尚未创建'}。`,
      `当前可用类别：人物=${eligibility.people.available ? '是' : `否（${eligibility.people.reason}）`}；车队=${eligibility.team.available ? '是' : `否（${eligibility.team.reason}）`}；研发=${eligibility.research.available ? '是' : `否（${eligibility.research.reason}）`}；天气=${eligibility.weather.available ? '是' : `否（${eligibility.weather.reason}）`}；调校=${eligibility.setup.available ? '是' : `否（${eligibility.setup.reason}）`}。只建议当前可用类别。`,
      `每次最多${SUPERNATURAL_LIMITS.maxCommands}项。上限：人心态/信任/体能=${SUPERNATURAL_LIMITS.morale}/${SUPERNATURAL_LIMITS.trust}/${SUPERNATURAL_LIMITS.fitness}；车队董事会/媒体/员工=${SUPERNATURAL_LIMITS.board}/${SUPERNATURAL_LIMITS.media}/${SUPERNATURAL_LIMITS.staff}；车手属性和员工技能每人总计1；资金总计${SUPERNATURAL_LIMITS.funds}M；设计项目最多提前1周且不得完成；天气倾向${SUPERNATURAL_LIMITS.weatherTendency}；每车每项调校${SUPERNATURAL_LIMITS.carSetup}，总偏移±${SUPERNATURAL_LIMITS.carSetupOffset}。`,
      '禁止结果、积分、零件、合同、雇佣、比赛控制、任意补丁和未来天气。只返回一个 <F1M_UPDATE>[...]</F1M_UPDATE>，数组中每个对象必须使用以下一种精确格式：{op:"morale|trust|fitness",driver:"ID",delta:number,reason?:string}、{op:"board|media|staff|funds|weather_tendency",delta:number,reason?:string}、{op:"driver_attr",driver:"ID",attr:"pace|racecraft|consistency|tyre|wet|feedback",delta:number}、{op:"staff_skill",staffId:"ID",field:"skill|setup|communication|reaction|strategy|weather|risk",delta:number}、{op:"research_progress",projectId:"ID",weeks:1}、{op:"car_setup",driver:"ID",field:"confidence|tyreKnowledge",delta:number}。',
    ].join('\n');
    this.busy = true;
    try {
      const generated = await withTimeout(
        this.env.generateText(prompt, api === 'secondary' ? this.secondaryApiOptions() : undefined),
        60_000,
      );
      if (new TextEncoder().encode(generated).byteLength > 16 * 1024) return fail('API 返回超过 16 KiB，未保存任何改动');
      const parsed = parseSupernaturalCommands(generated);
      if (parsed.error) return fail(parsed.error);
      const latestFloor = this.latestFloor();
      const latest = this.store.resolve(latestFloor);
      const latestState = latest?.state;
      if (this.env.isGenerating() || this.env.chatId() !== guard.chatId || latestFloor !== guard.floor || !latest || !latestState || latest.rev.id !== guard.revisionId || latestState.gameId !== guard.gameId || latestState.season.phase !== guard.phase || latestState.season.year !== guard.year || latestState.season.roundIndex !== guard.roundIndex || (latestState.weekend?.liveRace?.id ?? null) !== guard.liveId || !latestState.meta.supernaturalMode) return fail('等待 API 时存档或聊天已变化，结果已安全丢弃');
      const next = JSON.parse(JSON.stringify(latestState)) as GameState;
      const applied = applySupernaturalCommands(next, parsed.commands, invocationId);
      if (!applied.changed) return { ok: false, message: '没有可应用的干预；存档未改变', api, revisionId: null, results: applied.logs };
      const revision = this.store.commit(next, { floor: Math.max(0, latestFloor), kind: 'ui', label: '超自然干预' });
      this.notify('supernatural');
      return { ok: true, message: applied.logs.some(row => !row.ok) ? '部分干预已执行，其余已拒绝或裁剪' : '超自然干预已执行', api, revisionId: revision.id, results: applied.logs };
    } catch (error) {
      return fail(error instanceof Error && /超时/.test(error.message) ? '超自然 API 请求超时，未保存任何改动' : '超自然 API 请求失败，未保存任何改动');
    } finally {
      this.busy = false;
    }
  }

  /** 发送一条用户消息并触发 AI 叙述待叙述事件 */
  async requestNarration(text?: string): Promise<Outcome> {
    if (this.env.isGenerating()) return { ok: false, message: 'AI 正在生成中' };
    const s = this.stateAt();
    if (!s) return { ok: false, message: '还没有开局' };
    await this.env.createUserMessage((text ?? this.settings.narrationText).trim() || DEFAULT_SETTINGS.narrationText);
    await this.env.triggerGeneration();
    return { ok: true, message: '已请求 AI 叙述' };
  }

  // ───────────────────────────── 事件 ─────────────────────────────

  onChatChanged(): void {
    this.store.load();
    this.data = null;
    this.continuing = null;
    this.env.uninject(INJECT_ID);
    this.notify('chat_changed');
  }

  onGenerationStart(type: string, dryRun?: boolean): void {
    const last = this.latestFloor();
    let floor = last;
    const lastMsg = this.env.getMessage(last);
    if (!dryRun) {
      this.continuing = type === 'continue' && lastMsg?.role === 'assistant' ? { floor: last, text: lastMsg.message ?? '' } : null;
    }
    if (type === 'swipe' || (type === 'regenerate' && lastMsg?.role === 'assistant')) floor = last - 1;
    const st = this.settings.inject ? this.store.resolve(floor) : null;
    if (!st) {
      this.env.uninject(INJECT_ID);
      return;
    }
    const prompt = buildStatePrompt(st.state, { protocolReminder: this.settings.protocolReminder });
    this.env.inject(INJECT_ID, prompt, this.settings.injectDepth, this.settings.injectRole, this.settings.scanWorldInfo);
  }

  /**
   * 兜底结算：酒馆在流式生成被中断/出错（如 swipe、continue）时可能不发 MESSAGE_RECEIVED。
   * 空回复（例如在第一个字之前就停止生成留下的空楼层）不会被结算，见 processAssistantMessageInner。
   */
  async onGenerationEnded(): Promise<void> {
    const last = this.latestFloor();
    const msg = this.env.getMessage(last);
    if (msg?.role === 'assistant') await this.processAssistantMessage(last, { fallback: true });
  }

  async onMessageReceived(id: number, type?: string): Promise<void> {
    if (type === 'impersonate' || type === 'quiet' || type === 'first_message') return;
    await this.processAssistantMessage(id, { type });
  }

  async onMessageEdited(id: number): Promise<void> {
    // 只有最新楼层的编辑会重新结算（中间楼层的修改不重算后续楼层）
    if (id !== this.latestFloor()) return;
    await this.processAssistantMessage(id, { type: 'edit' });
  }

  private processing = new Set<number>();

  /** 解析并结算一条 AI 回复（幂等：同样的文本不会重复结算） */
  async processAssistantMessage(id: number, opts: ProcessOptions): Promise<void> {
    if (this.processing.has(id)) return;
    this.processing.add(id);
    try {
      await this.processAssistantMessageInner(id, opts);
    } finally {
      this.processing.delete(id);
    }
  }

  private async processAssistantMessageInner(id: number, opts: ProcessOptions): Promise<void> {
    const msg = this.env.getMessage(id);
    if (!msg || msg.role !== 'assistant') return;
    const vars = this.env.getMessageVars(id);
    let text = msg.message ?? '';
    // 继续生成：酒馆用「不发给AI」正则处理过的原文（没有指令块和占位符）拼接续写内容。
    // 把原文（含已结算的指令块）放回去，这样本楼文本仍包含全部指令，之后编辑/重算也不会丢失原指令。
    const cont = this.continuing && this.continuing.floor === id ? this.continuing : null;
    if (cont) this.continuing = null;
    const suffix = cont ? continuationSuffix(cont.text, text) : null;
    if (cont && suffix !== null) {
      const original = stripHud(cont.text).trimEnd();
      const restored = original + suffix;
      if (restored !== stripHud(text)) {
        text = restored;
        try {
          await this.env.setMessageText(id, text);
        } catch (e) {
          console.warn('[F1M] 无法恢复续写前的原文', e);
        }
      }
      // 本楼在 AI 结算之后已有面板操作：只把续写部分的指令结算到本楼当前状态上
      if (!opts.force && typeof vars[PTR] === 'string' && vars[PTR] !== vars[AI_PTR] && suffix.trim()) {
        await this.settleContinuation(id, text, hashString(stripHud(text).trim()), original, suffix);
        return;
      }
    }
    const body = stripHud(text);
    // 空回复：不结算、不消耗待叙述事件、不加状态条。
    // 兜底路径上还要跳过酒馆流式生成的占位文本「...」（在第一个字之前停止生成时会原样留下）。
    if (!body.trim() || (opts.fallback && body.trim() === STREAM_PLACEHOLDER)) return;
    const hash = hashString(body.trim());
    if (!opts.force && vars.f1m_hash === hash) {
      await this.ensureHud(id, text);
      return;
    }
    // 本楼在 AI 结算之后已有面板操作：不从上一楼重算，避免冲掉玩家的操作
    if (!opts.force && typeof vars[PTR] === 'string' && vars[PTR] !== vars[AI_PTR]) {
      this.store.patchFloorVars(id, { f1m_hash: hash });
      this.env.toast('warning', '本楼已有面板操作，修改后的 AI 指令没有重新结算');
      return;
    }
    const base = this.store.resolve(id - 1);
    if (!base) {
      await this.ensureHud(id, text);
      return;
    }
    const { commands, errors } = parseAiCommands(text);
    const next = base.state;
    const logs = applyAiCommands(next, commands, { messageId: id });
    const narrated = takeNarration(next);
    const changes = describeChanges(next, logs, errors);
    if (logs.length === 0 && narrated.length === 0) {
      // 无状态变化：不生成新版本，清掉可能残留的旧指针（例如重新编辑去掉了指令）
      this.store.patchFloorVars(id, { [PTR]: undefined, [AI_PTR]: undefined, [GAME_PTR]: undefined, f1m_hash: hash, f1m_changes: changes, f1m_narrated: [] });
    } else {
      this.store.commit(next, {
        floor: id,
        kind: 'ai',
        label: `第 ${id} 楼 AI 结算${logs.length ? `（${logs.filter(l => l.ok).length} 条指令）` : ''}`,
        parent: base.rev.id,
        extraVars: { f1m_hash: hash, f1m_changes: changes, f1m_narrated: narrated },
      });
    }
    await this.ensureHud(id, text);
    this.notify('ai');
  }

  /**
   * 本楼已有面板操作时的「继续生成」：在本楼当前状态（含面板操作）上只结算续写部分。
   * 原文里的指令只用来恢复本条消息的累计上限。f1m_ai_rev 保持不变，之后编辑本楼仍受面板操作保护。
   */
  private async settleContinuation(id: number, text: string, hash: string, original: string, suffix: string): Promise<void> {
    const cur = this.store.resolve(id);
    const vars = this.env.getMessageVars(id);
    if (!cur) return;
    const { commands, errors } = parseAiCommands(suffix);
    const next = cur.state;
    const logs = applyAiCommands(next, commands, { messageId: id, prior: parseAiCommands(original).commands });
    const narrated = takeNarration(next);
    const changes = [...(Array.isArray(vars.f1m_changes) ? vars.f1m_changes : []), ...describeChanges(next, logs, errors)];
    const allNarrated = [...(Array.isArray(vars.f1m_narrated) ? vars.f1m_narrated : []), ...narrated];
    if (logs.length === 0 && narrated.length === 0) {
      this.store.patchFloorVars(id, { f1m_hash: hash, f1m_changes: changes });
    } else {
      this.store.commit(next, {
        floor: id,
        kind: 'ai',
        label: `第 ${id} 楼继续生成结算${logs.length ? `（${logs.filter(l => l.ok).length} 条指令）` : ''}`,
        parent: cur.rev.id,
        extraVars: { [AI_PTR]: vars[AI_PTR], f1m_hash: hash, f1m_changes: changes, f1m_narrated: allNarrated },
      });
    }
    // 续写会把原来的占位符留在正文中间：移到末尾
    await this.ensureHud(id, text.trimEnd().endsWith(HUD_TAG) ? text : stripHud(text));
    this.notify('ai');
  }

  private async ensureHud(id: number, text: string): Promise<void> {
    if (!this.settings.hudEnabled || text.includes(HUD_TAG)) return;
    try {
      await this.env.setMessageText(id, `${text.trimEnd()}\n\n${HUD_TAG}`);
    } catch (e) {
      console.warn('[F1M] 无法追加状态条占位符', e);
    }
  }
}

function stripHud(text: string): string {
  return text.split(HUD_TAG).join('');
}

const UPDATE_BLOCK = /<F1M_UPDATE>[\s\S]*?<\/F1M_UPDATE>/gi;

/**
 * 「继续生成」后的文本相对续写前原文新增的部分；对不上时返回 null。
 * 酒馆续写时以「发给 AI 的版本」为前缀（指令块、占位符已被正则去掉，空白也可能变化），
 * 所以按「去掉指令块与空白后的正文」逐字对齐。
 */
export function continuationSuffix(original: string, current: string): string | null {
  const o = stripHud(original).trimEnd();
  const c = stripHud(current);
  if (c.startsWith(o)) return c.slice(o.length);
  const target = o.replace(UPDATE_BLOCK, '').replace(/\s+/g, '');
  let k = 0;
  let i = 0;
  while (i < c.length && k < target.length) {
    if (/\s/.test(c[i])) {
      i++;
      continue;
    }
    if (c[i] !== target[k]) return null;
    i++;
    k++;
  }
  return k === target.length ? c.slice(i) : null;
}

/** 取出待叙述事件（标记为已叙述），返回它们的标题 */
function takeNarration(state: GameState): string[] {
  const titles = state.narration.map(e => e.title);
  if (state.narration.length) {
    state.narrated = state.narration;
    state.narration = [];
  }
  return titles;
}

function describeChanges(state: GameState, logs: ReturnType<typeof applyAiCommands>, errors: string[]): string[] {
  const changes = logs.map(l => describeLog(state, l));
  if (errors.length) changes.push(...errors.slice(0, 3).map(e => `✗ ${e}`));
  return changes;
}

function isSimulation(a: Action): boolean {
  return ['ADVANCE', 'RUN_PRACTICE', 'RUN_QUALIFYING', 'RUN_SPRINT_QUALIFYING', 'RUN_SPRINT', 'RUN_RACE', 'FINISH_ROUND', 'START_SEASON', 'START_WEEKEND', 'START_NEXT_SEASON'].includes(a.type);
}
