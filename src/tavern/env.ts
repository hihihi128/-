/**
 * 酒馆环境抽象层。
 *
 * 后端逻辑只通过 TavernEnv 访问酒馆助手 (Tavern Helper) 接口，
 * 这样控制器可以在 Node 里用假环境做集成测试，真正运行时由 createTavernEnv() 绑定到全局接口。
 */

export interface ChatMsg {
  message_id: number;
  role: 'user' | 'assistant' | 'system';
  message: string;
  is_hidden: boolean;
}

export interface WorldbookText {
  name: string;
  content: string;
  book: string;
}

export interface TextGenerationOptions {
  proxyPreset?: string;
  apiUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface TavernEnv {
  getChatVars(): Record<string, any>;
  setChatVars(vars: Record<string, any>): void;
  getMessageVars(id: number): Record<string, any>;
  setMessageVars(id: number, vars: Record<string, any>): void;
  /** 某楼所有分支（swipe）的变量 */
  getMessageSwipeVars(id: number): Array<Record<string, any>>;
  getScriptVars(): Record<string, any>;
  setScriptVars(vars: Record<string, any>): void;
  /** Device-local secret storage. Values must never be written into card or save variables. */
  getLocalSecret(name: string): string;
  setLocalSecret(name: string, value: string): void;
  lastMessageId(): number;
  getMessage(id: number): ChatMsg | null;
  setMessageText(id: number, text: string): Promise<void>;
  createUserMessage(text: string): Promise<void>;
  triggerGeneration(): Promise<void>;
  /** 独立文本生成。空配置使用酒馆当前主 API。 */
  generateText(prompt: string, options?: TextGenerationOptions): Promise<string>;
  isGenerating(): boolean;
  chatId(): string;
  userName(): string;
  inject(id: string, content: string, depth: number, role: 'system' | 'user' | 'assistant', scan: boolean): void;
  uninject(id: string): void;
  registerMacro(regex: RegExp, fn: () => string): void;
  /** 读取名字以 prefix 开头的世界书条目（角色卡绑定的世界书 → 全局世界书 → 角色卡内嵌世界书） */
  readWorldbookEntries(prefix: string): Promise<{ entries: WorldbookText[]; origin: string }>;
  parseYaml(text: string): unknown;
  on(event: string, fn: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
  toast(level: 'info' | 'success' | 'warning' | 'error', msg: string): void;
  buttonEvent(name: string): string;
  ensureButtons(names: string[]): void;
  exposeGlobal(name: string, value: unknown): void;
  hostDocument(): Document | null;
  events: {
    MESSAGE_RECEIVED: string;
    MESSAGE_SENT: string;
    MESSAGE_SWIPED: string;
    MESSAGE_DELETED: string;
    MESSAGE_EDITED: string;
    MESSAGE_UPDATED: string;
    CHAT_CHANGED: string;
    GENERATION_AFTER_COMMANDS: string;
    GENERATION_ENDED: string;
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const getVariables: (opt: any) => Record<string, any>;
declare const replaceVariables: (v: Record<string, any>, opt: any) => void;
declare const getChatMessages: (range: string | number, opt?: any) => any[];
declare const setChatMessages: (msgs: any[], opt?: any) => Promise<void>;
declare const createChatMessages: (msgs: any[], opt?: any) => Promise<void>;
declare const getLastMessageId: () => number;
declare const triggerSlash: (cmd: string) => Promise<string>;
declare const generateRaw: (options: Record<string, unknown>) => Promise<string>;
declare const injectPrompts: (p: any[], opt?: any) => { uninject: () => void };
declare const uninjectPrompts: (ids: string[]) => void;
declare const registerMacroLike: (re: RegExp, fn: (...a: any[]) => string) => unknown;
declare const getCharWorldbookNames: (c: string) => { primary: string | null; additional: string[] };
declare const getGlobalWorldbookNames: () => string[];
declare const getWorldbook: (name: string) => Promise<Array<{ name: string; content: string; enabled: boolean }>>;
declare const eventOn: (e: string, fn: (...a: any[]) => void) => unknown;
declare const eventEmit: (e: string, ...a: any[]) => Promise<void>;
declare const getButtonEvent: (name: string) => string;
declare const appendInexistentScriptButtons: (b: Array<{ name: string; visible: boolean }>) => void;
declare const initializeGlobal: (name: string, v: unknown) => void;
declare const substitudeMacros: (t: string) => string;
declare const tavern_events: Record<string, string>;
declare const builtin: { duringGenerating?: () => boolean };
declare const toastr: Record<string, (msg: string, title?: string) => void>;
declare const YAML: { parse: (t: string) => unknown };
declare const SillyTavern: any;

export function createTavernEnv(): TavernEnv {
  const ev = (k: string, fallback: string) => (typeof tavern_events !== 'undefined' && tavern_events[k]) || fallback;
  return {
    getChatVars: () => getVariables({ type: 'chat' }) ?? {},
    setChatVars: v => replaceVariables(v, { type: 'chat' }),
    getMessageVars: id => {
      try {
        return getVariables({ type: 'message', message_id: id }) ?? {};
      } catch {
        return {};
      }
    },
    setMessageVars: (id, v) => replaceVariables(v, { type: 'message', message_id: id }),
    getMessageSwipeVars: id => {
      try {
        const m = getChatMessages(id, { include_swipes: true })[0];
        return (m?.swipes_data as Array<Record<string, any>>) ?? [];
      } catch {
        return [];
      }
    },
    getScriptVars: () => getVariables({ type: 'script' }) ?? {},
    setScriptVars: v => replaceVariables(v, { type: 'script' }),
    getLocalSecret: name => {
      try {
        return localStorage.getItem(`f1m:secret:${name}`) ?? '';
      } catch {
        return '';
      }
    },
    setLocalSecret: (name, value) => {
      if (value) localStorage.setItem(`f1m:secret:${name}`, value);
      else localStorage.removeItem(`f1m:secret:${name}`);
    },
    lastMessageId: () => {
      try {
        return getLastMessageId();
      } catch {
        return -1;
      }
    },
    getMessage: id => {
      if (id < 0) return null;
      try {
        const m = getChatMessages(id)[0];
        return m ? { message_id: m.message_id, role: m.role, message: m.message ?? '', is_hidden: !!m.is_hidden } : null;
      } catch {
        return null;
      }
    },
    setMessageText: (id, text) => setChatMessages([{ message_id: id, message: text }], { refresh: 'affected' }),
    createUserMessage: text => createChatMessages([{ role: 'user', message: text }]),
    triggerGeneration: async () => {
      await triggerSlash('/trigger');
    },
    generateText: async (prompt, options) => {
      if (typeof generateRaw !== 'function') throw new Error('当前酒馆助手版本不支持独立生成');
      const customApi = options?.proxyPreset
        ? { proxy_preset: options.proxyPreset, ...(options.model ? { model: options.model } : {}) }
        : options && (options.apiUrl || options.apiKey || options.model)
          ? {
              ...(options.apiUrl ? { apiurl: options.apiUrl, source: 'openai' } : {}),
              ...(options.apiKey ? { key: options.apiKey } : {}),
              ...(options.model ? { model: options.model } : {}),
            }
          : undefined;
      return String(await generateRaw({
        user_input: '请给出策略建议。',
        should_stream: false,
        ordered_prompts: [{ role: 'system', content: prompt }, 'user_input'],
        max_chat_history: 0,
        ...(customApi ? { custom_api: customApi } : {}),
      })).trim();
    },
    isGenerating: () => {
      try {
        return !!builtin?.duringGenerating?.();
      } catch {
        return false;
      }
    },
    chatId: () => {
      try {
        return String(SillyTavern.getCurrentChatId?.() ?? SillyTavern.chatId ?? '');
      } catch {
        return '';
      }
    },
    userName: () => {
      try {
        return substitudeMacros('{{user}}') || SillyTavern.name1 || '领队';
      } catch {
        return '领队';
      }
    },
    inject: (id, content, depth, role, scan) => {
      injectPrompts([{ id, position: 'in_chat', depth, role, content, should_scan: scan }]);
    },
    uninject: id => uninjectPrompts([id]),
    registerMacro: (re, fn) => {
      if (typeof registerMacroLike === 'function') registerMacroLike(re, () => fn());
    },
    readWorldbookEntries: async prefix => {
      const out: WorldbookText[] = [];
      const books: string[] = [];
      try {
        const cw = getCharWorldbookNames('current');
        if (cw.primary) books.push(cw.primary);
        books.push(...cw.additional);
      } catch {
        /* 没有打开角色卡 */
      }
      try {
        for (const g of getGlobalWorldbookNames()) if (!books.includes(g)) books.push(g);
      } catch {
        /* 忽略 */
      }
      for (const book of books) {
        try {
          const entries = await getWorldbook(book);
          for (const e of entries) if (e.name?.trim().startsWith(prefix)) out.push({ name: e.name.trim(), content: e.content ?? '', book });
        } catch {
          /* 世界书不存在 */
        }
      }
      if (out.length) return { entries: out, origin: `世界书：${[...new Set(out.map(e => e.book))].join('、')}` };
      // 回退：角色卡内嵌世界书（未导入为世界书文件时）
      try {
        const ch = SillyTavern.characters?.[SillyTavern.characterId];
        const embedded = ch?.data?.character_book?.entries ?? [];
        for (const e of embedded) {
          const name = String(e.comment ?? e.name ?? '').trim();
          if (name.startsWith(prefix)) out.push({ name, content: String(e.content ?? ''), book: '角色卡内嵌' });
        }
      } catch {
        /* 忽略 */
      }
      return { entries: out, origin: out.length ? '角色卡内嵌世界书' : '未找到' };
    },
    parseYaml: text => YAML.parse(text),
    on: (e, fn) => {
      eventOn(e, fn);
    },
    emit: (e, ...a) => {
      void eventEmit(e, ...a);
    },
    toast: (level, msg) => {
      try {
        toastr[level]?.(msg, 'F1 领队模拟器');
      } catch {
        console.info('[F1M]', msg);
      }
    },
    buttonEvent: name => getButtonEvent(name),
    ensureButtons: names => {
      try {
        appendInexistentScriptButtons(names.map(name => ({ name, visible: true })));
      } catch {
        /* 旧版酒馆助手 */
      }
    },
    exposeGlobal: (name, value) => initializeGlobal(name, value),
    hostDocument: () => {
      try {
        return window.parent?.document ?? null;
      } catch {
        return null;
      }
    },
    events: {
      MESSAGE_RECEIVED: ev('MESSAGE_RECEIVED', 'message_received'),
      MESSAGE_SENT: ev('MESSAGE_SENT', 'message_sent'),
      MESSAGE_SWIPED: ev('MESSAGE_SWIPED', 'message_swiped'),
      MESSAGE_DELETED: ev('MESSAGE_DELETED', 'message_deleted'),
      MESSAGE_EDITED: ev('MESSAGE_EDITED', 'message_edited'),
      MESSAGE_UPDATED: ev('MESSAGE_UPDATED', 'message_updated'),
      CHAT_CHANGED: ev('CHAT_CHANGED', 'chat_id_changed'),
      GENERATION_AFTER_COMMANDS: ev('GENERATION_AFTER_COMMANDS', 'GENERATION_AFTER_COMMANDS'),
      GENERATION_ENDED: ev('GENERATION_ENDED', 'generation_ended'),
    },
  };
}
