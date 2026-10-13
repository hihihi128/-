/**
 * 冒烟测试：在 jsdom 里用「模拟的酒馆助手全局接口」加载打包后的 dist/f1m-backend.js，
 * 验证真实的环境绑定代码（env.ts）、面板宿主与事件流程。需要先 npm run build。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { diskWorldbook } from './fakeEnv';

const BUNDLE = resolve(__dirname, '../../dist/f1m-backend.js');
const CARD = resolve(__dirname, '../../dist/F1领队模拟器.json');

interface Msg {
  role: 'user' | 'assistant';
  swipes: string[];
  swipe_id: number;
  variables: Array<Record<string, any>>;
}

function setupWindow() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window as any;
  const clone = (v: any) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const chat: Msg[] = [{ role: 'assistant', swipes: ['欢迎\n\n<F1M_HUD/>'], swipe_id: 0, variables: [{}] }];
  let chatVars: Record<string, any> = {};
  let scriptVars: Record<string, any> = {};
  const listeners = new Map<string, Array<(...a: any[]) => any>>();
  const injected: Record<string, any> = {};
  const globals: Record<string, any> = {};
  const worldbook = diskWorldbook().map(e => ({ name: e.name, content: e.content, enabled: false }));
  const pagehide: Array<() => void> = [];

  const $ = (arg: any) => {
    if (typeof arg === 'function') {
      arg();
      return;
    }
    return { on: (ev: string, fn: () => void) => ev === 'pagehide' && pagehide.push(fn) };
  };
  Object.assign(w, {
    $,
    errorCatched: (fn: any) => fn,
    getVariables: (opt: any) => {
      if (opt.type === 'chat') return clone(chatVars);
      if (opt.type === 'script') return clone(scriptVars);
      if (opt.type === 'message') {
        const m = chat.at(opt.message_id);
        if (!m) throw new Error('out of range');
        return clone(m.variables[m.swipe_id] ?? {});
      }
      return {};
    },
    replaceVariables: (v: any, opt: any) => {
      if (opt.type === 'chat') chatVars = clone(v);
      else if (opt.type === 'script') scriptVars = clone(v);
      else if (opt.type === 'message') {
        const m = chat.at(opt.message_id)!;
        m.variables[m.swipe_id] = clone(v);
      }
    },
    getChatMessages: (range: number, opt?: any) => {
      const m = chat[range];
      if (!m) return [];
      if (opt?.include_swipes) return [{ message_id: range, role: m.role, swipes: m.swipes, swipe_id: m.swipe_id, swipes_data: clone(m.variables) }];
      return [{ message_id: range, role: m.role, message: m.swipes[m.swipe_id], is_hidden: false, data: clone(m.variables[m.swipe_id]) }];
    },
    setChatMessages: async (msgs: any[]) => {
      for (const x of msgs) chat[x.message_id].swipes[chat[x.message_id].swipe_id] = x.message;
    },
    createChatMessages: async (msgs: any[]) => {
      for (const x of msgs) chat.push({ role: x.role, swipes: [x.message], swipe_id: 0, variables: [{}] });
    },
    getLastMessageId: () => chat.length - 1,
    triggerSlash: async (cmd: string) => {
      globals.lastSlash = cmd;
      return '';
    },
    injectPrompts: (prompts: any[]) => {
      for (const p of prompts) injected[p.id] = p;
      return { uninject: () => {} };
    },
    uninjectPrompts: (ids: string[]) => ids.forEach(id => delete injected[id]),
    registerMacroLike: () => ({ unregister() {} }),
    getCharWorldbookNames: () => ({ primary: 'F1 领队模拟器', additional: [] }),
    getGlobalWorldbookNames: () => [],
    getWorldbook: async (name: string) => (name === 'F1 领队模拟器' ? worldbook : []),
    eventOn: (ev: string, fn: any) => {
      const arr = listeners.get(ev) ?? [];
      arr.push(fn);
      listeners.set(ev, arr);
    },
    eventEmit: async (ev: string, ...args: any[]) => {
      for (const fn of listeners.get(ev) ?? []) await fn(...args);
    },
    getButtonEvent: (name: string) => `btn_${name}`,
    appendInexistentScriptButtons: (b: any) => (globals.buttons = b),
    initializeGlobal: (name: string, v: any) => (w[name] = v),
    substitudeMacros: () => '测试玩家',
    tavern_events: {
      MESSAGE_RECEIVED: 'message_received',
      MESSAGE_SENT: 'message_sent',
      MESSAGE_SWIPED: 'message_swiped',
      MESSAGE_DELETED: 'message_deleted',
      MESSAGE_EDITED: 'message_edited',
      MESSAGE_UPDATED: 'message_updated',
      CHAT_CHANGED: 'chat_id_changed',
      GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
      GENERATION_ENDED: 'generation_ended',
    },
    builtin: { duringGenerating: () => false },
    toastr: { info() {}, success() {}, warning() {}, error() {} },
    YAML,
    SillyTavern: { getCurrentChatId: () => 'chat-1', characters: [], characterId: 0 },
  });
  const fire = async (ev: string, ...args: any[]) => {
    for (const fn of listeners.get(ev) ?? []) await fn(...args);
  };
  return { dom, w, chat, injected, globals, fire, pagehide, get chatVars() { return chatVars; } };
}

describe.skipIf(!existsSync(BUNDLE))('打包后的后端脚本（dist/f1m-backend.js）', () => {
  it('生成卡包含三支车队的条件式资料', () => {
    const card = JSON.parse(readFileSync(CARD, 'utf8'));
    const entries = card.data.character_book.entries as Array<{ comment: string; content: string }>;
    expect(entries.find(entry => entry.comment.includes('迈凯伦车队'))?.content).toContain('若玩家执掌迈凯伦');
    expect(entries.find(entry => entry.comment.includes('梅赛德斯车队'))?.content).toContain('其他车队存档只把接班人计划视为围场新闻');
    expect(entries.find(entry => entry.comment.includes('红牛车队'))?.content).toContain('其他车队存档只把人手危机视为围场新闻');
  });
  it('能在模拟的酒馆助手环境中加载并跑通开局 → 面板 → AI 结算 → 注入', async () => {
    const env = setupWindow();
    const code = readFileSync(BUNDLE, 'utf8');
    env.w.eval(code);
    const api = env.w.F1Manager;
    expect(api).toBeTruthy();
    expect(api.version).toBe('0.1.0');
    expect(env.globals.buttons.map((b: any) => b.name)).toEqual(['F1管理面板', 'AI叙述']);
    expect(api.status().hasGame).toBe(false);

    const report = await api.loadData();
    expect(report.ok).toBe(true);
    expect(report.teams).toHaveLength(11);

    const r = await api.newGame({ playerTeamId: 'team_b' });
    expect(r.ok).toBe(true);
    expect(env.chat[0].variables[0].f1m_rev).toBeTruthy();
    expect(env.chatVars.f1m_store.order).toHaveLength(1);
    expect(api.view().player.team.name).toBe('测试车队B');
    expect(api.status().userName).toBe('测试玩家');

    // 悬浮面板宿主
    api.openPanel('car');
    const root = env.w.document.getElementById('f1m-panel-root');
    expect(root).toBeTruthy();
    expect(root.classList.contains('f1m-hidden')).toBe(false);
    const frame = root.querySelector('iframe');
    expect(frame.getAttribute('srcdoc') ?? frame.srcdoc).toContain('F1 领队管理面板');
    api.closePanel();
    expect(root.classList.contains('f1m-hidden')).toBe(true);

    // 面板动作
    expect((await api.dispatch({ type: 'START_PROJECT', partType: 'floor', ambition: 'standard' })).ok).toBe(true);

    // 生成前注入
    env.chat.push({ role: 'user', swipes: ['你好'], swipe_id: 0, variables: [{}] });
    await env.fire('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    expect(env.injected.f1m_state.content).toContain('测试车队B');
    expect(env.injected.f1m_state.position).toBe('in_chat');

    // AI 回复结算
    env.chat.push({ role: 'assistant', swipes: ['好的。\n<F1M_UPDATE>\n{"op":"morale","driver":"b2","delta":4}\n</F1M_UPDATE>'], swipe_id: 0, variables: [{}] });
    const m0 = api.view(1).drivers.find((d: any) => d.id === 'b2').morale;
    await env.fire('message_received', 2, 'normal');
    const m1 = api.view().drivers.find((d: any) => d.id === 'b2').morale;
    expect(m1).toBeCloseTo(Math.min(100, m0 + 4), 1);
    expect(env.chat[2].swipes[0]).toContain('<F1M_HUD/>');
    const hud = api.hud(2);
    expect(hud.changes.join()).toContain('心态');

    // 请求叙述
    await api.requestNarration();
    expect(env.globals.lastSlash).toBe('/trigger');
    expect(env.chat[env.chat.length - 1].role).toBe('user');

    // 卸载
    env.pagehide.forEach(fn => fn());
    expect(env.w.document.getElementById('f1m-panel-root')).toBeNull();
  });
});
