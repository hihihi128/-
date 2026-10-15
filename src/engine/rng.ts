/**
 * 可复现的随机数（mulberry32）。
 *
 * 随机数状态保存在 GameState.rng 中：同一存档 + 同一操作 → 同一结果。
 * 这样「回滚后用同样的决策重跑」会得到同样的比赛，只有领队的决策会改变结局；
 * 若玩家在设置里选择「每次重新随机」，引擎会在模拟前混入当前时间。
 */
export class Rng {
  private s: number;

  constructor(seed: number, restore = false) {
    this.s = restore ? seed >>> 0 : seed >>> 0 || 0x9e3779b9;
  }

  /** Restores an exact serialized state, including the valid uint32 value zero. */
  static restore(state: number): Rng {
    return new Rng(state, true);
  }

  get state(): number {
    return this.s >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 正态分布（Box-Muller） */
  normal(mean = 0, sd = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** 按权重抽取下标 */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
    if (total <= 0) return 0;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
}

/** 从字符串生成种子 */
export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
