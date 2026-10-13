/**
 * 面板 ↔ 后端桥接。
 *
 * 面板运行在酒馆主页面里的一个同源 iframe 中，通过 window.parent.F1Manager 调用后端。
 * 跨 iframe 返回的对象一律 JSON 深拷贝后再交给 Vue（避免跨 realm 对象与响应式代理冲突）。
 */
import { reactive } from 'vue';
import type { F1ManagerApi } from '../../tavern/api';
import type { GameView } from '../../engine/view';
import type { Action } from '../../engine/types';
import type { NegotiationSessionView } from '../../tavern/negotiation';

type Status = ReturnType<F1ManagerApi['status']>;

export interface Toast {
  id: number;
  kind: 'ok' | 'err' | 'info';
  text: string;
}

export const store = reactive({
  connected: false,
  status: null as Status | null,
  view: null as GameView | null,
  negotiation: null as NegotiationSessionView | null,
  busy: false,
  toasts: [] as Toast[],
  tab: 'overview',
  error: '',
  /** 已有存档时手动打开开局界面 */
  forceNewGame: false,
});

export function api(): F1ManagerApi | null {
  try {
    const p = (window.parent as any)?.F1Manager;
    if (p) return p as F1ManagerApi;
  } catch {
    /* 跨域时忽略 */
  }
  return ((window as any).F1Manager as F1ManagerApi) ?? null;
}

export function clone<T>(v: T): T {
  return v === undefined || v === null ? v : (JSON.parse(JSON.stringify(v)) as T);
}

let toastId = 0;
export function toast(kind: Toast['kind'], text: string): void {
  const t = { id: ++toastId, kind, text };
  store.toasts.push(t);
  setTimeout(() => {
    const i = store.toasts.findIndex(x => x.id === t.id);
    if (i >= 0) store.toasts.splice(i, 1);
  }, kind === 'err' ? 6000 : 3500);
}

export function refresh(): void {
  const a = api();
  if (!a) {
    store.connected = false;
    store.error = '没有找到后端脚本（F1Manager）。请确认已在酒馆助手中启用本角色卡的脚本。';
    return;
  }
  try {
    store.status = clone(a.status());
    store.view = clone(a.view());
    store.negotiation = clone(a.getSpecialNegotiation());
    store.connected = true;
    store.error = '';
  } catch (e) {
    store.error = `读取数据失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function scheduleRefresh(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    refresh();
  }, 60);
}

/** 执行一个引擎动作并刷新 */
export async function act(action: Action, opts: { silent?: boolean } = {}): Promise<boolean> {
  const a = api();
  if (!a) return false;
  store.busy = true;
  try {
    const r = clone(await a.dispatch(action));
    if (!r.ok || !opts.silent) toast(r.ok ? 'ok' : 'err', r.message);
    return r.ok;
  } catch (e) {
    toast('err', e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    store.busy = false;
    refresh();
  }
}

/** 调用任意后端方法（返回值深拷贝），并在需要时提示结果 */
export async function call<T>(fn: (a: F1ManagerApi) => T | Promise<T>, notify = true): Promise<T | null> {
  const a = api();
  if (!a) return null;
  store.busy = true;
  try {
    const r = clone(await fn(a)) as T;
    const o = r as unknown as { ok?: boolean; message?: string } | null;
    if (notify && o && typeof o === 'object' && typeof o.ok === 'boolean' && o.message) toast(o.ok ? 'ok' : 'err', o.message);
    return r;
  } catch (e) {
    toast('err', e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    store.busy = false;
    refresh();
  }
}

/** 同步读取（预览类接口） */
export function peek<T>(fn: (a: F1ManagerApi) => T): T | null {
  const a = api();
  if (!a) return null;
  try {
    return clone(fn(a));
  } catch {
    return null;
  }
}

let cleanup: Array<() => void> = [];

export function connect(): void {
  refresh();
  const handler = () => scheduleRefresh();
  // 首选：酒馆事件总线（后端每次变化都会发出 f1m_changed）
  try {
    const es = (window.parent as any)?.SillyTavern?.getContext?.()?.eventSource;
    if (es?.on) {
      es.on('f1m_changed', handler);
      cleanup.push(() => es.removeListener?.('f1m_changed', handler));
    }
  } catch {
    /* 忽略 */
  }
  // 后备：直接订阅后端
  const a = api();
  const unsub = a?.subscribe?.(handler);
  if (typeof unsub === 'function') cleanup.push(unsub);
  // 后端脚本被重载时重新连接
  let last = a;
  const poll = setInterval(() => {
    const cur = api();
    if (cur !== last) {
      last = cur;
      const u = cur?.subscribe?.(handler);
      if (typeof u === 'function') cleanup.push(u);
      refresh();
    }
  }, 3000);
  cleanup.push(() => clearInterval(poll));
  window.addEventListener('message', ev => {
    if (ev.data?.type === 'f1m:tab' && typeof ev.data.tab === 'string') store.tab = ev.data.tab;
  });
  window.addEventListener('pagehide', () => {
    for (const fn of cleanup) {
      try {
        fn();
      } catch {
        /* 忽略 */
      }
    }
    cleanup = [];
  });
}

// ───────────── 显示工具 ─────────────

export function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(1)}M`;
}

export function lapTime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export function signed(v: number, digits = 1): string {
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
