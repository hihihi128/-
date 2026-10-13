/**
 * 内存版「酒馆」：在浏览器开发页与 Node 测试中模拟酒馆助手接口、聊天楼层、swipe 与事件。
 */
import YAML from 'yaml';
import type { ChatMsg, TavernEnv, TextGenerationOptions, WorldbookText } from '../src/tavern/env';

type Fn = (...args: any[]) => any;

interface Msg {
  role: 'user' | 'assistant' | 'system';
  swipes: string[];
  swipe_id: number;
  variables: Array<Record<string, any>>;
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export class FakeTavern implements TavernEnv {
  messages: Msg[] = [];
  chatVars: Record<string, any> = {};
  scriptVars: Record<string, any> = {};
  localSecrets: Record<string, string> = {};
  listeners = new Map<string, Fn[]>();
  generating = false;
  injected = new Map<string, { content: string; depth: number; role: string; scan: boolean }>();
  toasts: Array<[string, string]> = [];
  created: string[] = [];
  triggered = 0;
  generated: Array<{ prompt: string; options?: TextGenerationOptions }> = [];
  worldbook: WorldbookText[];
  worldbookSyncs: Array<{ prefix: string; disabledNames: string[] }> = [];
  emitted: string[] = [];

  events = {
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_UPDATED: 'message_updated',
    CHAT_CHANGED: 'chat_id_changed',
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    GENERATION_ENDED: 'generation_ended',
  };

  /** 事件总线监听者（开发页里的状态条/面板用） */
  bus = new Map<string, Fn[]>();

  constructor(worldbook: WorldbookText[], firstMessage = '欢迎来到围场。\n\n<F1M_HUD/>') {
    this.worldbook = worldbook;
    this.messages.push({ role: 'assistant', swipes: [firstMessage], swipe_id: 0, variables: [{}] });
  }

  // ── TavernEnv ──
  getChatVars() { return clone(this.chatVars); }
  setChatVars(v: Record<string, any>) { this.chatVars = clone(v); }
  getMessageVars(id: number) { const m = this.messages[id]; return m ? clone(m.variables[m.swipe_id] ?? {}) : {}; }
  setMessageVars(id: number, v: Record<string, any>) { const m = this.messages[id]; if (!m) throw new Error(`no message ${id}`); m.variables[m.swipe_id] = clone(v); }
  getMessageSwipeVars(id: number) { const m = this.messages[id]; return m ? clone(m.swipes.map((_, i) => m.variables[i] ?? {})) : []; }
  getScriptVars() { return clone(this.scriptVars); }
  setScriptVars(v: Record<string, any>) { this.scriptVars = clone(v); }
  getLocalSecret(name: string) { return this.localSecrets[name] ?? ''; }
  setLocalSecret(name: string, value: string) { if (value) this.localSecrets[name] = value; else delete this.localSecrets[name]; }
  lastMessageId() { return this.messages.length - 1; }
  getMessage(id: number): ChatMsg | null { const m = this.messages[id]; return m ? { message_id: id, role: m.role, message: m.swipes[m.swipe_id], is_hidden: false } : null; }
  async setMessageText(id: number, text: string) { const m = this.messages[id]; m.swipes[m.swipe_id] = text; }
  async createUserMessage(text: string) { this.created.push(text); this.messages.push({ role: 'user', swipes: [text], swipe_id: 0, variables: [{}] }); await this.fire(this.events.MESSAGE_SENT, this.messages.length - 1); }
  async triggerGeneration() { this.triggered++; }
  async generateText(prompt: string, options?: TextGenerationOptions) {
    this.generated.push({ prompt, options: clone(options) });
    return '工程师建议采用这套方案，并根据赛道变化保留临场调整空间。';
  }
  isGenerating() { return this.generating; }
  chatId() { return 'chat-1'; }
  userName() { return '玩家'; }
  inject(id: string, content: string, depth: number, role: string, scan: boolean) { this.injected.set(id, { content, depth, role, scan }); }
  uninject(id: string) { this.injected.delete(id); }
  registerMacro() {}
  async readWorldbookEntries(prefix: string) { const entries = this.worldbook.filter(e => e.name.startsWith(prefix)); return { entries, origin: '测试世界书' }; }
  async syncWorldbookEntryStates(prefix: string, disabledNames: string[]) {
    this.worldbookSyncs.push({ prefix, disabledNames: [...disabledNames] });
    const disabled = new Set(disabledNames);
    let found = 0;
    let changed = 0;
    for (const entry of this.worldbook) {
      if (!entry.name.startsWith(prefix)) continue;
      found++;
      const enabled = !disabled.has(entry.name);
      if (entry.enabled === enabled) continue;
      entry.enabled = enabled;
      changed++;
    }
    return { found, changed };
  }
  parseYaml(text: string) { return YAML.parse(text); }
  on(event: string, fn: Fn) { const arr = this.listeners.get(event) ?? []; arr.push(fn); this.listeners.set(event, arr); }
  emit(event: string, ...args: any[]) {
    this.emitted.push(event);
    for (const fn of this.bus.get(event) ?? []) {
      try { fn(...args); } catch { /* 忽略 */ }
    }
  }
  /** 供开发页订阅（模拟酒馆 eventSource） */
  busOn(event: string, fn: Fn) { const arr = this.bus.get(event) ?? []; arr.push(fn); this.bus.set(event, arr); }
  busOff(event: string, fn: Fn) { this.bus.set(event, (this.bus.get(event) ?? []).filter(f => f !== fn)); }
  toast(level: string, msg: string) { this.toasts.push([level, msg]); }
  buttonEvent(name: string) { return `button:${name}`; }
  ensureButtons() {}
  exposeGlobal() {}
  hostDocument() { return null; }

  // ── 模拟玩家/酒馆行为 ──
  async fire(event: string, ...args: any[]) { for (const fn of this.listeners.get(event) ?? []) await fn(...args); }

  async userSays(text: string) {
    this.messages.push({ role: 'user', swipes: [text], swipe_id: 0, variables: [{}] });
    await this.fire(this.events.MESSAGE_SENT, this.messages.length - 1);
  }

  /** 模拟一次正常生成：先触发生成前事件，再追加 AI 回复 */
  async aiReplies(text: string, type = 'normal') {
    await this.fire(this.events.GENERATION_AFTER_COMMANDS, type, {}, false);
    this.messages.push({ role: 'assistant', swipes: [text], swipe_id: 0, variables: [{}] });
    const id = this.messages.length - 1;
    await this.fire(this.events.MESSAGE_RECEIVED, id, type);
    await this.fire(this.events.GENERATION_ENDED, this.messages.length);
    return id;
  }

  /**
   * 按酒馆流式生成的真实顺序模拟一次生成（normal / continue）：
   * 先建一个占位文本为「...」的 AI 楼层（continue 则续写最后一楼），收尾时先发 GENERATION_ENDED（不等待），再发 MESSAGE_RECEIVED；
   * 在第一个字之前停止生成（text 为空）时，占位楼层「...」会留下，且不会发 MESSAGE_RECEIVED。
   */
  async aiStreams(text: string, type: 'normal' | 'continue' = 'normal') {
    await this.fire(this.events.GENERATION_AFTER_COMMANDS, type, {}, false);
    let id = this.messages.length - 1;
    if (type === 'continue') {
      // 酒馆以「发给 AI 的版本」为前缀拼接续写：不发给 AI 的正则已去掉指令块与状态条占位符
      const m = this.messages[id];
      const prompted = m.swipes[m.swipe_id].replace(/<F1M_UPDATE>[\s\S]*?<\/F1M_UPDATE>/gi, '').split('<F1M_HUD/>').join('').trim();
      m.swipes[m.swipe_id] = prompted + text;
    } else {
      this.messages.push({ role: 'assistant', swipes: ['...'], swipe_id: 0, variables: [{}] });
      id = this.messages.length - 1;
      if (text) this.messages[id].swipes[0] = text;
    }
    const ended = this.fire(this.events.GENERATION_ENDED, this.messages.length);
    if (text) await this.fire(this.events.MESSAGE_RECEIVED, id, type);
    await ended;
    await new Promise(r => setTimeout(r, 0)); // 等待事件处理里未被等待的异步部分
    return id;
  }

  /** 模拟在最后一楼右滑生成新 swipe */
  async swipeNew(text: string) {
    const id = this.messages.length - 1;
    const m = this.messages[id];
    m.swipes.push('');
    m.swipe_id = m.swipes.length - 1;
    await this.fire(this.events.MESSAGE_SWIPED, id);
    await this.fire(this.events.GENERATION_AFTER_COMMANDS, 'swipe', {}, false);
    m.swipes[m.swipe_id] = text;
    await this.fire(this.events.MESSAGE_RECEIVED, id, 'swipe');
    return id;
  }

  async swipeTo(id: number, idx: number) {
    this.messages[id].swipe_id = idx;
    await this.fire(this.events.MESSAGE_SWIPED, id);
  }

  async deleteFrom(id: number) {
    this.messages.splice(id);
    await this.fire(this.events.MESSAGE_DELETED, this.messages.length);
  }

  async editMessage(id: number, text: string) {
    const m = this.messages[id];
    m.swipes[m.swipe_id] = text;
    await this.fire(this.events.MESSAGE_EDITED, id);
  }
}
