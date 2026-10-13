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
import type { Action, Ambition, ContractOfferTerms, DataIssue, DriverAttr, DriverPlan, FacilityType, GameState, StaffRole } from '../engine/types';
import { hashString, money, round1 } from '../engine/util';
import { buildView, type GameView } from '../engine/view';
import type { TavernEnv } from './env';
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
    next.engineerModel = String(next.engineerModel ?? '').trim();
    this.settings = next;
    this.store.opts.maxRevisions = next.maxRevisions;
    const vars = this.env.getScriptVars() ?? {};
    this.env.setScriptVars({ ...vars, settings: next });
    if (!next.inject) this.env.uninject(INJECT_ID);
    this.notify('settings');
    return next;
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
      settings: this.settings,
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
    const cur = this.store.resolve(floor);
    if (!cur) return { ok: false, message: '还没有开局' };
    this.busy = true;
    try {
      const res = dispatch(cur.state, action);
      if (!res.ok) return { ok: false, message: res.message };
      this.store.commit(res.state, { floor: Math.max(0, floor), kind: 'ui', label: res.message });
      this.notify('action');
      if (this.settings.autoNarrate && isSimulation(action) && res.state.narration.length) {
        void this.requestNarration();
      }
      return { ok: true, message: res.message };
    } finally {
      this.busy = false;
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
    const view = buildView(state);
    const driverView = view.weekend?.drivers.find(driver => driver.driverId === driverId);
    const driver = state.drivers[driverId];
    const team = state.teams[state.meta.playerTeamId];
    if (!driverView || !driver || driver.teamId !== team.id) return { ok: false, message: '找不到本队正式车手' };
    if (!driverView.options.length) return { ok: false, message: '当前没有可用的干地策略方案' };

    const slot = team.cars.find(car => car.driverId === driverId)?.slot ?? 1;
    const engineer = raceEngineerFor(team, slot);
    const decisionSkill = strategyDecisionSkill(team, slot);
    const level = perfect ? 0 : decisionSkill >= 90 ? 0 : decisionSkill >= 82 ? 1 : decisionSkill >= 73 ? 2 : decisionSkill >= 64 ? 3 : decisionSkill >= 55 ? 4 : 5;
    const labels = ['顶级', '优秀', '中游', '保守迟钝', '较差', '灾难级'];
    const liveCar = state.weekend.liveRace?.kind === 'race' ? state.weekend.liveRace.cars[driverId] : undefined;
    const activeDriverIds = new Set(Object.values(state.teams).flatMap(currentTeam => currentTeam.cars.map(car => car.driverId).filter((id): id is string => !!id)));
    const qualifyingGrid = (state.weekend.qualifying?.grid ?? []).filter(id => activeDriverIds.has(id));
    const gridPosition = liveCar?.grid ?? (qualifyingGrid.includes(driverId) ? qualifyingGrid.indexOf(driverId) + 1 : null);
    const rainWindow = state.weekend.forecast.raceRainWindow ?? null;
    const rainTarget = rainWindow ? (rainWindow[0] + rainWindow[1]) / 2 : null;
    const contextRanked = [...driverView.options].sort((a, b) => {
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
      strategySource: 'engineer',
      tyrePlan: [...option.compounds],
      paceMode: level >= 4 ? (level === 5 ? 'conserve' : 'push') : 'balanced',
      pitTiming: level >= 4 ? 'late' : 'standard',
      scReaction: level < 4,
    };
    const api = requestedApi ?? this.settings.engineerApi;
    if (api === 'secondary' && !this.settings.engineerProxyPreset) return { ok: false, message: '请先在设置中填写副 API 的代理预设名称' };
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
        api === 'secondary' ? { proxyPreset: this.settings.engineerProxyPreset, model: this.settings.engineerModel } : undefined,
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
