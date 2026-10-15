import type { GameState } from './types';

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
export const round1 = (v: number): number => Math.round(v * 10) / 10;
export const round2 = (v: number): number => Math.round(v * 100) / 100;
export const round3 = (v: number): number => Math.round(v * 1000) / 1000;
export const sum = (arr: number[]): number => arr.reduce((a, b) => a + b, 0);
export const mean = (arr: number[]): number => (arr.length ? sum(arr) / arr.length : 0);

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 生成本局内唯一 id */
export function nextId(state: GameState, prefix: string): string {
  state.seq += 1;
  return `${prefix}${state.seq.toString(36)}`;
}

/** 当前时间点标签，如「S1·R3·赛前」 */
export function stamp(state: GameState): string {
  const r = state.season.roundIndex + 1;
  return `S${state.season.number}R${r}`;
}

/** 格式化金额（百万美元） */
export function money(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(1)}M`;
}

/** 秒 → m:ss.SSS */
export function lapTime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** 秒差 → +1.234s */
export function gapText(sec: number): string {
  return `+${sec.toFixed(3)}s`;
}

/** 总时间 → h:mm:ss.SSS */
export function raceTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export function signed(v: number, digits = 1): string {
  const r = v.toFixed(digits);
  return v > 0 ? `+${r}` : r;
}

/** 简单字符串哈希（FNV-1a），用于数据指纹 / 文本去重 */
export function hashString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function pushCapped<T>(arr: T[], item: T, cap: number): void {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}
