/**
 * 存档：修订版本库 + 楼层指针。
 *
 * - 每次状态变化（新开局、AI 结算、面板操作、读档）生成一个「修订版本」，
 *   完整快照经 lz-string 压缩后存进「聊天变量」f1m_store（数量有上限）。
 * - 发生变化的那一楼（当前 swipe）的「楼层变量」里记录指针 f1m_rev。
 * - 读取第 N 楼的状态 = 从第 N 楼往前找第一个有效指针。
 *   因为指针跟随楼层与 swipe，所以重 roll / 删除楼层 / 切换 swipe 会自然回滚存档。
 * - 同一楼层上连续的面板操作会合并成一个修订版本，避免版本爆炸。
 */
import { compressToBase64, decompressFromBase64 } from 'lz-string';
import { migrateState } from '../engine/migrate';
import type { GameState } from '../engine/types';
import type { TavernEnv } from './env';

export const STORE_KEY = 'f1m_store';
export const PTR = 'f1m_rev';
export const AI_PTR = 'f1m_ai_rev';
/** 指针所属的对局 id：新开局/导入后，旧对局楼层上的指针不会被误认成新对局的版本 */
export const GAME_PTR = 'f1m_gid';

export type RevisionKind = 'new' | 'ai' | 'ui' | 'restore' | 'import';

export interface StoredRevision {
  id: string;
  parent: string | null;
  gameId: string;
  floor: number;
  kind: RevisionKind;
  label: string;
  created: number;
  /** 一句话概要（赛季/站/阶段） */
  summary: string;
  /** 压缩后的 GameState JSON */
  data: string;
}

export interface StoreData {
  v: 1;
  gameId: string | null;
  counter: number;
  order: string[];
  revisions: Record<string, StoredRevision>;
}

export interface RevisionInfo {
  id: string;
  parent: string | null;
  floor: number;
  kind: RevisionKind;
  label: string;
  created: number;
  size: number;
  /** 当前楼层正在使用的版本 */
  current: boolean;
  /** 是否被近期楼层引用（受保护，不会被清理） */
  referenced: boolean;
  summary: string;
}

export interface Resolved {
  rev: StoredRevision;
  state: GameState;
  /** 指针所在楼层 */
  floor: number;
  /** 是否因版本被清理而使用了回退版本 */
  fallback: boolean;
}

const PHASE_LABEL: Record<string, string> = {
  preseason: '季前',
  pre_race: '赛前',
  practice: '练习赛',
  sprint_qualifying: '冲刺排位',
  sprint: '冲刺赛',
  qualifying: '排位赛',
  race: '正赛',
  post_race: '赛后',
  season_end: '赛季结束',
};

function summarize(state: GameState): string {
  const track = state.tracks[state.calendar[state.season.roundIndex]?.trackId]?.name ?? '';
  return `${state.season.year} 第${state.season.roundIndex + 1}站 ${track} · ${PHASE_LABEL[state.season.phase] ?? state.season.phase}`;
}

const emptyStore = (): StoreData => ({ v: 1, gameId: null, counter: 0, order: [], revisions: {} });

export function encodeState(state: GameState): string {
  return compressToBase64(JSON.stringify(state));
}

export function decodeState(data: string): GameState {
  const json = decompressFromBase64(data);
  if (!json) throw new Error('存档数据损坏，无法解压');
  return migrateState(JSON.parse(json) as GameState);
}

export interface StoreOptions {
  maxRevisions: number;
  /** 最近多少楼层的指针受保护 */
  protectFloors: number;
}

export class SaveStore {
  private data: StoreData = emptyStore();
  private cache = new Map<string, GameState>();

  constructor(
    private env: TavernEnv,
    public opts: StoreOptions,
  ) {}

  /** 从聊天变量载入（切换聊天时调用） */
  load(): void {
    this.cache.clear();
    const raw = this.env.getChatVars()[STORE_KEY];
    if (raw && raw.v === 1 && raw.revisions && Array.isArray(raw.order)) {
      this.data = raw as StoreData;
    } else {
      this.data = emptyStore();
    }
  }

  private save(): void {
    const vars = this.env.getChatVars();
    vars[STORE_KEY] = this.data;
    this.env.setChatVars(vars);
  }

  get gameId(): string | null {
    return this.data.gameId;
  }

  get revisionCount(): number {
    return this.data.order.length;
  }

  /** 所有修订版本的总体积（字节，约数） */
  get totalSize(): number {
    return this.data.order.reduce((a, id) => a + (this.data.revisions[id]?.data.length ?? 0), 0);
  }

  getRevision(id: string): StoredRevision | undefined {
    return this.data.revisions[id];
  }

  stateOf(rev: StoredRevision): GameState {
    let s = this.cache.get(rev.id);
    if (!s) {
      s = decodeState(rev.data);
      this.cache.set(rev.id, s);
      if (this.cache.size > 12) {
        const first = this.cache.keys().next().value as string;
        this.cache.delete(first);
      }
    }
    return JSON.parse(JSON.stringify(s)) as GameState;
  }

  pointerAt(floor: number): string | null {
    if (floor < 0) return null;
    const p = this.env.getMessageVars(floor)[PTR];
    return typeof p === 'string' ? p : null;
  }

  /**
   * 解析第 floor 楼（含）之前最近的有效版本（不解压）。
   * - 属于其他对局（新开局/导入之前）的指针视为「无存档」，不会显示新对局的状态。
   * - 指向已被清理版本的指针退回到最早仍保留、且不晚于该楼层的版本。
   */
  resolveRev(floor: number): { rev: StoredRevision; floor: number; fallback: boolean } | null {
    let sawDangling = false;
    for (let i = Math.min(floor, this.env.lastMessageId()); i >= 0; i--) {
      const vars = this.env.getMessageVars(i);
      const id = typeof vars[PTR] === 'string' ? (vars[PTR] as string) : null;
      if (!id) continue;
      const gid = vars[GAME_PTR];
      if (typeof gid === 'string' && gid !== this.data.gameId) return null;
      const rev = this.data.revisions[id];
      if (rev && rev.gameId === this.data.gameId) return { rev, floor: i, fallback: sawDangling };
      if (rev) return null; // 旧存档（没有对局标记）里撞上了新对局的版本号
      sawDangling = true;
    }
    if (sawDangling && this.data.order.length) {
      // 指针指向的版本已被清理：退回到最早仍保留的版本（不能用比该楼层更晚的版本）
      const oldest = this.data.revisions[this.data.order[0]];
      if (oldest && oldest.floor <= floor) return { rev: oldest, floor: oldest.floor, fallback: true };
    }
    return null;
  }

  /** 解析第 floor 楼（含）之前最近的有效存档 */
  resolve(floor: number): Resolved | null {
    const r = this.resolveRev(floor);
    return r ? { ...r, state: this.stateOf(r.rev) } : null;
  }

  /** 新开局：清空历史版本（版本号计数继续递增，避免与旧楼层上的指针重名） */
  reset(gameId: string): void {
    this.data = { ...emptyStore(), gameId, counter: this.data.counter };
    this.cache.clear();
  }

  /**
   * 提交新状态并把指针写到 floor 楼。
   * coalesce：如果该楼当前指向的是本楼生成的「面板操作」版本，则直接覆盖，避免版本爆炸。
   */
  commit(
    state: GameState,
    info: { floor: number; kind: RevisionKind; label: string; parent?: string | null; extraVars?: Record<string, unknown> },
  ): StoredRevision {
    if (this.data.gameId !== state.gameId) this.data.gameId = state.gameId;
    const floor = Math.max(0, info.floor);
    const vars = this.env.getMessageVars(floor);
    const currentId = typeof vars[PTR] === 'string' ? (vars[PTR] as string) : null;
    const current = currentId ? this.data.revisions[currentId] : undefined;
    const data = encodeState(state);
    let rev: StoredRevision;
    if (info.kind === 'ui' && current && current.kind === 'ui' && current.floor === floor && current.gameId === state.gameId) {
      rev = { ...current, data, label: info.label, created: Date.now(), summary: summarize(state) };
      this.data.revisions[rev.id] = rev;
      // 移到最新
      this.data.order = this.data.order.filter(x => x !== rev.id).concat(rev.id);
    } else {
      this.data.counter += 1;
      const id = `r${this.data.counter.toString(36)}`;
      rev = {
        id,
        parent: info.parent !== undefined ? info.parent : this.resolveRev(floor)?.rev.id ?? null,
        gameId: state.gameId,
        floor,
        kind: info.kind,
        label: info.label,
        created: Date.now(),
        summary: summarize(state),
        data,
      };
      this.data.revisions[id] = rev;
      this.data.order.push(id);
    }
    this.cache.set(rev.id, JSON.parse(JSON.stringify(state)) as GameState);
    const nextVars: Record<string, unknown> = {
      ...vars,
      [PTR]: rev.id,
      [GAME_PTR]: state.gameId,
      ...(info.kind === 'ai' ? { [AI_PTR]: rev.id } : {}),
      ...(info.extraVars ?? {}),
    };
    this.env.setMessageVars(floor, nextVars);
    this.prune();
    this.save();
    return rev;
  }

  /** 被近期楼层（含所有 swipe）引用的版本 */
  private referenced(): Set<string> {
    const keep = new Set<string>();
    const last = this.env.lastMessageId();
    for (let i = last; i >= 0 && i > last - this.opts.protectFloors; i--) {
      for (const v of this.env.getMessageSwipeVars(i)) {
        const p = v?.[PTR];
        if (typeof p === 'string') keep.add(p);
      }
      const cur = this.pointerAt(i);
      if (cur) keep.add(cur);
    }
    // 当前生效的版本永远保留
    const live = this.resolveRev(last);
    if (live) keep.add(live.rev.id);
    return keep;
  }

  prune(): void {
    const max = Math.max(4, this.opts.maxRevisions);
    if (this.data.order.length <= max) return;
    const keep = this.referenced();
    const removable = this.data.order.filter(id => !keep.has(id));
    let excess = this.data.order.length - max;
    for (const id of removable) {
      if (excess <= 0) break;
      delete this.data.revisions[id];
      this.cache.delete(id);
      excess--;
    }
    this.data.order = this.data.order.filter(id => this.data.revisions[id]);
  }

  list(currentId: string | null): RevisionInfo[] {
    const keep = this.referenced();
    return [...this.data.order].reverse().map(id => {
      const r = this.data.revisions[id];
      return {
        id,
        parent: r.parent,
        floor: r.floor,
        kind: r.kind,
        label: r.label,
        created: r.created,
        size: r.data.length,
        current: id === currentId,
        referenced: keep.has(id),
        summary: r.summary ?? '',
      };
    });
  }

  /** 楼层变量里的其他 F1M 字段 */
  patchFloorVars(floor: number, patch: Record<string, unknown>): void {
    const vars = this.env.getMessageVars(floor);
    const next: Record<string, unknown> = { ...vars };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    this.env.setMessageVars(floor, next);
  }
}
