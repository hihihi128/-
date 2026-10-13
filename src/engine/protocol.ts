/**
 * AI 叙事指令协议。
 *
 * AI 只负责叙事；当剧情产生「可量化」的后果时，在回复末尾输出：
 *
 *   <F1M_UPDATE>
 *   {"op":"morale","driver":"a1","delta":3,"reason":"领队的鼓励"}
 *   {"op":"news","text":"车队宣布与新赞助商续约","tag":"商务"}
 *   </F1M_UPDATE>
 *
 * 引擎只接受白名单指令，并按规则限制单次幅度；赛车性能、零件、比赛结果等核心数值 AI 无权修改。
 */
import { ferrariActive, shiftFans } from './ferrari';
import { addNews } from './log';
import { addGridPenalty } from './weekend';
import type { AiLogEntry, GameState } from './types';
import { clamp, pushCapped, round1, round2, stamp } from './util';

export const UPDATE_TAG = 'F1M_UPDATE';

export interface AiCommand {
  op: string;
  driver?: string;
  delta?: number;
  grid?: number;
  text?: string;
  tag?: string;
  key?: string;
  value?: string | number | boolean;
  reason?: string;
}

const OP_ALIASES: Record<string, string> = {
  morale: 'morale',
  心态: 'morale',
  trust: 'trust',
  信任: 'trust',
  fitness: 'fitness',
  体能: 'fitness',
  board: 'board',
  董事会: 'board',
  media: 'media',
  媒体: 'media',
  staff: 'staff',
  士气: 'staff',
  funds: 'funds',
  资金: 'funds',
  news: 'news',
  新闻: 'news',
  flag: 'flag',
  标记: 'flag',
  penalty: 'penalty',
  罚退: 'penalty',
  fans: 'fans',
  粉丝: 'fans',
};

const BLOCK_RE = new RegExp(`<${UPDATE_TAG}>([\\s\\S]*?)<\\/${UPDATE_TAG}>`, 'gi');

/** 从 AI 回复中提取指令（宽松解析：每行一个 JSON，也接受 JSON 数组） */
export function parseAiCommands(text: string): { commands: AiCommand[]; errors: string[] } {
  const commands: AiCommand[] = [];
  const errors: string[] = [];
  const blocks = [...text.matchAll(BLOCK_RE)].map(m => m[1]);
  for (const raw of blocks) {
    const body = raw.replace(/```(?:json|jsonl)?/gi, '').trim();
    if (!body) continue;
    const tryParse = (s: string): unknown => {
      try {
        return JSON.parse(s);
      } catch {
        const fixed = s
          .replace(/[“”]/g, '"')
          .replace(/'/g, '"')
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
        try {
          return JSON.parse(fixed);
        } catch {
          return undefined;
        }
      }
    };
    const whole = body.startsWith('[') ? tryParse(body) : undefined;
    const items: unknown[] = Array.isArray(whole)
      ? whole
      : body
          .split(/\n+/)
          .map(l => l.trim().replace(/,$/, ''))
          .filter(l => l && l !== '[' && l !== ']')
          .map(l => {
            const v = tryParse(l);
            if (v === undefined) errors.push(`无法解析：${l.slice(0, 80)}`);
            return v;
          });
    for (const it of items) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      const o = it as Record<string, unknown>;
      const op = OP_ALIASES[String(o.op ?? o.type ?? '').trim()] ?? String(o.op ?? '').trim();
      if (!op) {
        errors.push('缺少 op 字段');
        continue;
      }
      commands.push({
        op,
        driver: o.driver !== undefined ? String(o.driver) : o.target !== undefined ? String(o.target) : undefined,
        delta: o.delta !== undefined ? Number(o.delta) : o.value !== undefined && typeof o.value !== 'string' && op !== 'flag' ? Number(o.value) : undefined,
        grid: o.grid !== undefined ? Number(o.grid) : undefined,
        text: o.text !== undefined ? String(o.text) : undefined,
        tag: o.tag !== undefined ? String(o.tag) : undefined,
        key: o.key !== undefined ? String(o.key) : undefined,
        value: typeof o.value === 'string' || typeof o.value === 'number' || typeof o.value === 'boolean' ? o.value : undefined,
        reason: o.reason !== undefined ? String(o.reason) : '',
      });
    }
  }
  return { commands, errors };
}

/** 去掉回复中的指令块（用于显示/摘要） */
export function stripAiCommands(text: string): string {
  return text.replace(BLOCK_RE, '').trim();
}

function resolveDriver(state: GameState, ref: string | undefined): string | null {
  if (!ref) return null;
  const r = ref.trim();
  if (state.drivers[r]) return r;
  const lower = r.toLowerCase();
  for (const d of Object.values(state.drivers)) {
    if (d.name === r || d.short.toLowerCase() === lower || String(d.number) === r) return d.id;
  }
  return null;
}

export interface ApplyContext {
  messageId: number | null;
  /**
   * 同一条消息里此前已经结算过的指令（例如「继续生成」前的原文）。
   * 只用来恢复本条消息的累计上限与指令计数，不会再次作用到 state 上。
   */
  prior?: AiCommand[];
}

/**
 * 应用指令（就地修改 state），返回逐条日志。
 * 同一条消息内对同一对象的累计变化也受上限约束。
 */
export function applyAiCommands(state: GameState, commands: AiCommand[], ctx: ApplyContext): AiLogEntry[] {
  const used: Record<string, number> = {};
  const prior = ctx.prior ?? [];
  if (prior.length) runCommands(JSON.parse(JSON.stringify(state)) as GameState, prior, ctx.messageId, used, 0);
  return runCommands(state, commands, ctx.messageId, used, prior.length);
}

function runCommands(state: GameState, commands: AiCommand[], messageId: number | null, used: Record<string, number>, offset: number): AiLogEntry[] {
  const limits = state.rules.aiLimits;
  const logs: AiLogEntry[] = [];
  const team = state.teams[state.meta.playerTeamId];
  const at = stamp(state);

  const log = (e: Omit<AiLogEntry, 'at' | 'messageId'>) => {
    const entry: AiLogEntry = { at, messageId, ...e };
    logs.push(entry);
    pushCapped(state.aiLog, entry, 30);
  };

  /** 按累计上限裁剪 delta */
  const budget = (key: string, delta: number, limit: number): number => {
    const prev = used[key] ?? 0;
    const next = clamp(prev + delta, -limit, limit);
    used[key] = next;
    return next - prev;
  };

  commands.forEach((cmd, idx) => {
    const reason = (cmd.reason ?? '').slice(0, 60);
    if (idx + offset >= limits.maxCommands) {
      log({ op: cmd.op, target: cmd.driver ?? '', requested: cmd.delta ?? null, applied: null, reason, ok: false, note: `超过单条消息 ${limits.maxCommands} 条指令上限` });
      return;
    }
    switch (cmd.op) {
      case 'morale':
      case 'trust':
      case 'fitness': {
        const id = resolveDriver(state, cmd.driver);
        const delta = Number(cmd.delta);
        if (!id || !Number.isFinite(delta)) {
          log({ op: cmd.op, target: cmd.driver ?? '', requested: cmd.delta ?? null, applied: null, reason, ok: false, note: !id ? '找不到该车手' : 'delta 不是数字' });
          return;
        }
        const d = state.drivers[id];
        if (cmd.op === 'trust' && d.teamId !== team.id) {
          log({ op: cmd.op, target: id, requested: delta, applied: null, reason, ok: false, note: '信任只对本队车手有效' });
          return;
        }
        const limit = limits[cmd.op];
        const allowed = budget(`${cmd.op}:${id}`, delta, limit);
        const before = d[cmd.op];
        d[cmd.op] = round1(clamp(before + allowed, 0, 100));
        log({ op: cmd.op, target: id, requested: delta, applied: round1(d[cmd.op] - before), reason, ok: true, note: allowed !== delta ? `已按上限 ±${limit} 裁剪` : '' });
        return;
      }
      case 'board':
      case 'media':
      case 'staff': {
        const delta = Number(cmd.delta);
        if (!Number.isFinite(delta)) {
          log({ op: cmd.op, target: team.id, requested: cmd.delta ?? null, applied: null, reason, ok: false, note: 'delta 不是数字' });
          return;
        }
        const field = cmd.op === 'board' ? 'boardConfidence' : cmd.op === 'media' ? 'mediaReputation' : 'staffMorale';
        const limit = limits[cmd.op];
        const allowed = budget(cmd.op, delta, limit);
        const before = team[field];
        team[field] = round1(clamp(before + allowed, 0, 100));
        log({ op: cmd.op, target: team.id, requested: delta, applied: round1(team[field] - before), reason, ok: true, note: allowed !== delta ? `已按上限 ±${limit} 裁剪` : '' });
        return;
      }
      case 'fans': {
        const id = resolveDriver(state, cmd.driver);
        const delta = Number(cmd.delta);
        if (!ferrariActive(state)) {
          log({ op: 'fans', target: cmd.driver ?? '', requested: cmd.delta ?? null, applied: null, reason, ok: false, note: '只有法拉利过渡领队存档有粉丝意见' });
          return;
        }
        if (!id || !(id in state.ferrari.fans) || !Number.isFinite(delta)) {
          log({ op: 'fans', target: id ?? cmd.driver ?? '', requested: cmd.delta ?? null, applied: null, reason, ok: false, note: !id || !(id in state.ferrari.fans) ? '该车手没有粉丝阵营' : 'delta 不是数字' });
          return;
        }
        const allowed = budget(`fans:${id}`, delta, limits.fans);
        const before = state.ferrari.fans[id];
        shiftFans(state, { [id]: allowed }, reason || '剧情');
        log({ op: 'fans', target: id, requested: delta, applied: round1(state.ferrari.fans[id] - before), reason, ok: true, note: allowed !== delta ? `已按上限 ±${limits.fans} 裁剪` : '' });
        return;
      }
      case 'funds': {
        const delta = Number(cmd.delta);
        if (!Number.isFinite(delta)) {
          log({ op: 'funds', target: team.id, requested: cmd.delta ?? null, applied: null, reason, ok: false, note: 'delta 不是数字' });
          return;
        }
        const allowed = round2(budget('funds', delta, limits.funds));
        team.funds = round2(team.funds + allowed);
        log({ op: 'funds', target: team.id, requested: delta, applied: allowed, reason, ok: true, note: allowed !== delta ? `已按上限 ±${limits.funds}M 裁剪` : '' });
        return;
      }
      case 'news': {
        const text = (cmd.text ?? '').trim().slice(0, 120);
        if (!text) {
          log({ op: 'news', target: '', requested: null, applied: null, reason, ok: false, note: '新闻内容为空' });
          return;
        }
        addNews(state, (cmd.tag ?? '剧情').slice(0, 8), text);
        log({ op: 'news', target: '', requested: text, applied: text, reason, ok: true, note: '' });
        return;
      }
      case 'flag': {
        const key = (cmd.key ?? '').trim().slice(0, 40);
        if (!key || ['fired', 'firedReason', 'pendingPenalties'].includes(key)) {
          log({ op: 'flag', target: key, requested: null, applied: null, reason, ok: false, note: '无效或受保护的标记名' });
          return;
        }
        const value = cmd.value ?? true;
        state.flags[`story.${key}`] = typeof value === 'string' ? value.slice(0, 80) : value;
        log({ op: 'flag', target: key, requested: String(value), applied: String(value), reason, ok: true, note: '' });
        return;
      }
      case 'penalty': {
        const id = resolveDriver(state, cmd.driver);
        const grid = Math.round(Number(cmd.grid ?? cmd.delta));
        if (!id || !Number.isFinite(grid) || grid <= 0) {
          log({ op: 'penalty', target: cmd.driver ?? '', requested: cmd.grid ?? null, applied: null, reason, ok: false, note: '参数无效' });
          return;
        }
        // 同一条消息里对同一车手的罚退累计不超过上限
        const allowed = budget(`penalty:${id}`, grid, limits.penalty);
        const { added, thisRound } = addGridPenalty(state, id, allowed, state.rules.maxGridPenalty);
        log({
          op: 'penalty',
          target: id,
          requested: grid,
          applied: added,
          reason,
          ok: added > 0,
          note: added > 0 ? (thisRound ? '本站生效' : '下一站生效') : '已达到罚退上限',
        });
        return;
      }
      default:
        log({ op: cmd.op, target: cmd.driver ?? '', requested: cmd.delta ?? null, applied: null, reason, ok: false, note: '不在白名单中的指令，已忽略' });
    }
  });
  return logs;
}

const OP_LABEL: Record<string, string> = {
  morale: '心态',
  trust: '信任',
  fitness: '体能',
  board: '董事会信心',
  media: '媒体声誉',
  staff: '员工士气',
  funds: '资金',
  news: '新闻',
  flag: '剧情标记',
  penalty: '罚退',
  fans: '粉丝意见',
  driver_attr: '车手属性',
  staff_skill: '员工技能',
  research_progress: '设计研发进度',
  weather_tendency: '公开降雨倾向',
  car_setup: '临时调校',
};

/** 把日志转成一行可读文本（状态条/提示词用） */
export function describeLog(state: GameState, e: AiLogEntry): string {
  const label = OP_LABEL[e.op] ?? e.op;
  const who = state.drivers[e.target]?.name ?? (e.target === state.meta.playerTeamId ? '' : e.target);
  if (!e.ok) return `✗ ${label}${who ? `(${who})` : ''}：${e.note}`;
  if (e.op === 'news') return `新闻：${String(e.applied)}`;
  if (e.op === 'flag') return `剧情标记 ${e.target} = ${String(e.applied)}`;
  if (e.op === 'penalty') return `${who} 罚退 ${String(e.applied)} 格（${e.note}）`;
  const v = Number(e.applied);
  const unit = e.op === 'funds' ? 'M' : '';
  return `${who ? `${who} ` : ''}${label} ${v > 0 ? '+' : ''}${v}${unit}${e.reason ? `（${e.reason}）` : ''}${e.note ? ` [${e.note}]` : ''}`;
}
