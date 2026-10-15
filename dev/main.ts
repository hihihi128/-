/**
 * 本地开发页：在浏览器里用内存版「酒馆」运行真实的后端控制器、悬浮面板与楼层状态条。
 * 用法：npm run build（生成面板 HTML）→ npm run dev → 打开 http://localhost:5174
 */
import { FakeTavern } from './fakeTavern';
import { F1Controller, HUD_TAG, INJECT_ID } from '../src/tavern/controller';
import { createApi } from '../src/tavern/api';
import { PanelHost } from '../src/tavern/panelHost';
import panelHtml from '../dist/f1m-panel.html?raw';
import hudHtml from '../src/ui/hud/hud.html?raw';
import rules from '../src/card/worldbook/data-rules.yaml?raw';
import teams from '../src/card/worldbook/data-teams.yaml?raw';
import drivers from '../src/card/worldbook/data-drivers.yaml?raw';
import tracks from '../src/card/worldbook/data-tracks.yaml?raw';
import calendar from '../src/card/worldbook/data-calendar.yaml?raw';
import firstMes from '../src/card/first_mes.md?raw';

const book = 'F1 领队模拟器';
const env = new FakeTavern(
  [
    { name: '[F1M数据] 规则', content: rules, book },
    { name: '[F1M数据] 车队', content: teams, book },
    { name: '[F1M数据] 车手', content: drivers, book },
    { name: '[F1M数据] 赛道', content: tracks, book },
    { name: '[F1M数据] 赛历', content: calendar, book },
  ],
  firstMes,
);
const w = window as any;
w.__f1mFake = env;
// 模拟酒馆的 eventSource（面板通过 SillyTavern.getContext().eventSource 订阅变化）
w.SillyTavern = {
  getContext: () => ({ eventSource: { on: (e: string, fn: any) => env.busOn(e, fn), removeListener: (e: string, fn: any) => env.busOff(e, fn) } }),
};

const ctrl = new F1Controller(env);
ctrl.init();
const panel = new PanelHost(document, panelHtml);
w.F1Manager = createApi(ctrl, () => panel);

type WeeklyFixtureCategory = 'routine' | 'problem';
let weeklyFixtureCategory: WeeklyFixtureCategory = 'routine';

/**
 * Development-only deterministic responses for the real controller/panel path.
 * They keep browser checks independent of external model credentials while the
 * panel still talks to the same F1Manager API it uses in SillyTavern.
 */
const weeklyFixtureGenerateText = async (prompt: string) => {
  const state = ctrl.stateAt();
  const event = state?.randomEvents?.current;
  if (prompt.includes('随机事件编剧')) {
    return JSON.stringify({
      title: weeklyFixtureCategory === 'routine' ? '工程师的午餐邀请' : '供应商检测争议',
      prompt: weeklyFixtureCategory === 'routine'
        ? '这是一件没有危机的日常小事，工程师想在午餐时交流近况。'
        : '一批关键零件的检测结果不一致，需要你决定如何处理。',
      answerOptions: weeklyFixtureCategory === 'routine'
        ? ['接受邀请并聊聊近况', '礼貌婉拒并另约时间']
        : ['暂停使用并安排复查', '要求供应商立即说明'],
    });
  }
  if (prompt.includes('随机事件裁判') && state && event) {
    const team = state.teams[state.meta.playerTeamId];
    const target = Object.values(team.staff)[0];
    return JSON.stringify({
      eventId: event.id,
      outcome: 'resolved',
      summary: weeklyFixtureCategory === 'routine' ? '交流顺利结束，彼此多了一点了解。' : '复查流程完成，车队已控制风险。',
      effects: weeklyFixtureCategory === 'routine' && target?.id
        ? [{ op: 'affinity', targetId: target.id, delta: 0.05, reason: '轻松交流增进了了解' }]
        : [],
    });
  }
  return '工程师建议采用这套方案，并根据赛道变化保留临场调整空间。';
};

/** Browser tests call this once, then interact through the visible dev page. */
w.__f1mWeeklyEventFixture = {
  configure: async ({ category = 'routine', turns = 2 }: { category?: WeeklyFixtureCategory; turns?: 2 | 3 } = {}) => {
    weeklyFixtureCategory = category;
    env.generateText = weeklyFixtureGenerateText;
    ctrl.updateSettings({ engineerProxyPreset: 'dev-weekly-event-fixture', engineerModel: 'fixture-model' });
    if (!ctrl.stateAt()) await ctrl.newGame({ playerTeamId: 'haas', seed: 7003 });
    const saved = JSON.parse(ctrl.exportSave()!);
    saved.state.season.phase = 'pre_race';
    saved.state.rules.randomEvents = category === 'routine'
      ? { minPerWeek: 3, maxPerWeek: 3, routineWeight: 1, noneWeight: 0, driverInjuryWeight: 0, windTunnelWeight: 0, partIssueWeight: 0, minDialogueTurns: turns, maxDialogueTurns: turns }
      : { minPerWeek: 3, maxPerWeek: 3, routineWeight: 0, noneWeight: 0, driverInjuryWeight: 1, windTunnelWeight: 0, partIssueWeight: 0, minDialogueTurns: turns, maxDialogueTurns: turns };
    await ctrl.importSave(JSON.stringify(saved));
    return ctrl.status();
  },
};

// 开发页专用：给没有中文字体的截图环境加载 dev/public/cjk.ttf（文件不存在时自动忽略）
const FONT_CSS = `@font-face{font-family:'Noto Sans CJK SC';src:url('${location.origin}/cjk.ttf');font-weight:100 900;font-style:normal}@font-face{font-family:'Noto Sans CJK SC';src:url('${location.origin}/cjk.ttf');font-weight:100 900;font-style:italic}.mono{font-family:ui-monospace,Menlo,Consolas,'Noto Sans CJK SC',monospace!important}`;
function injectFont(doc: Document | null): void {
  if (!doc?.head || doc.getElementById('dev-cjk')) return;
  const s = doc.createElement('style');
  s.id = 'dev-cjk';
  s.textContent = FONT_CSS;
  doc.head.appendChild(s);
}
injectFont(document);
function hookPanelFont(): void {
  const f = document.querySelector('#f1m-panel-root iframe') as HTMLIFrameElement | null;
  if (f && !f.dataset.fontHooked) {
    f.dataset.fontHooked = '1';
    const applyPanelFont = () => injectFont(f.contentDocument);
    f.addEventListener('load', applyPanelFont);
    applyPanelFont();
  }
}
new MutationObserver(hookPanelFont).observe(document.body, { childList: true, subtree: true });
hookPanelFont();

const chat = document.getElementById('chat')!;
const input = document.getElementById('input') as HTMLTextAreaElement;
const status = document.getElementById('status')!;
const promptBox = document.getElementById('prompt')!;

const UPDATE_RE = /<F1M_UPDATE>([\s\S]*?)<\/F1M_UPDATE>/gi;

function hudFrame(id: number): HTMLIFrameElement {
  const f = document.createElement('iframe');
  const shim = `<style>${FONT_CSS}</style><script>
    window.getCurrentMessageId = function(){ return ${id}; };
    window.eventOn = function(e, fn){ parent.__f1mFake.busOn(e, fn); window.addEventListener('pagehide', function(){ parent.__f1mFake.busOff(e, fn); }); };
  </` + `script>`;
  f.srcdoc = hudHtml.replace('<head>', `<head>${shim}`);
  f.addEventListener('load', () => {
    const doc = f.contentDocument;
    if (!doc) return;
    const fit = () => (f.style.height = `${doc.body.scrollHeight + 2}px`);
    new ResizeObserver(fit).observe(doc.body);
    fit();
  });
  return f;
}

function renderChat(): void {
  chat.innerHTML = '';
  env.messages.forEach((m, id) => {
    const div = document.createElement('div');
    div.className = `mes ${m.role}`;
    const text = m.swipes[m.swipe_id] ?? '';
    const who = document.createElement('div');
    who.className = 'who';
    who.innerHTML = `<span>#${id} · ${m.role === 'user' ? '用户' : 'AI'}</span>`;
    if (m.swipes.length > 1) {
      const sw = document.createElement('span');
      sw.className = 'swipe';
      sw.innerHTML = `<button data-dir="-1">‹</button>${m.swipe_id + 1}/${m.swipes.length}<button data-dir="1">›</button>`;
      sw.querySelectorAll('button').forEach(b =>
        b.addEventListener('click', async () => {
          const next = Math.min(m.swipes.length - 1, Math.max(0, m.swipe_id + Number(b.dataset.dir)));
          await env.swipeTo(id, next);
          renderChat();
        }),
      );
      who.appendChild(sw);
    }
    div.appendChild(who);
    const body = document.createElement('div');
    body.className = 'text';
    body.textContent = text.replace(UPDATE_RE, '').split(HUD_TAG).join('').trim();
    div.appendChild(body);
    for (const m2 of text.matchAll(UPDATE_RE)) {
      const u = document.createElement('div');
      u.className = 'upd';
      u.textContent = `<F1M_UPDATE>${m2[1]}</F1M_UPDATE>`;
      div.appendChild(u);
    }
    if (text.includes(HUD_TAG)) div.appendChild(hudFrame(id));
    chat.appendChild(div);
  });
  const st = ctrl.status();
  status.textContent = `楼层 ${st.latestFloor + 1} · 版本 ${st.revisions} · ${st.hasGame ? '已开局' : '未开局'}`;
}

/** 模拟 LLM：叙述待叙述事件，并随机给出一条心态指令 */
function fakeAiText(): string {
  const s = ctrl.stateAt();
  if (!s) return '（模拟 AI）围场里一片忙碌，大家都在等待新领队的决定。';
  const randomEvent = s.randomEvents?.current;
  if (randomEvent?.status === 'awaiting_narration') {
    const turn = randomEvent.completedDialogueTurns + 1;
    return `（模拟主 API）${randomEvent.title}正在自然推进。第 ${turn}/${randomEvent.totalDialogueTurns} 轮中，相关人员认真回应了你的安排，并等待你的下一步回应。`;
  }
  const team = s.teams[s.meta.playerTeamId];
  const ev = s.narration.map(e => `「${e.title}」`).join('、');
  const d = team.cars[0]?.driverId;
  const lines = [`（模拟 AI）${ev ? `关于${ev}，` : ''}${team.name} 的车库里议论纷纷。工程师们把最新的数据摊在桌上，等你拍板。`];
  if (d) lines.push(`<F1M_UPDATE>\n{"op":"morale","driver":"${d}","delta":2,"reason":"领队在车库里的鼓励"}\n</F1M_UPDATE>`);
  return lines.join('\n\n');
}

env.triggerGeneration = async () => {
  env.triggered++;
  env.generating = true;
  setTimeout(async () => {
    env.generating = false;
    await env.aiReplies(fakeAiText());
    renderChat();
  }, 300);
};

document.getElementById('btn-panel')!.addEventListener('click', () => panel.toggle());
document.getElementById('btn-narrate')!.addEventListener('click', async () => {
  const r = await ctrl.requestNarration();
  if (!r.ok) alert(r.message);
  renderChat();
});
document.getElementById('btn-prompt')!.addEventListener('click', () => {
  promptBox.style.display = promptBox.style.display === 'block' ? 'none' : 'block';
  promptBox.textContent = env.injected.get(INJECT_ID)?.content ?? ctrl.promptForLatest() ?? '（未开局）';
});
document.getElementById('btn-user')!.addEventListener('click', async () => {
  if (!input.value.trim()) return;
  await env.userSays(input.value.trim());
  input.value = '';
  renderChat();
});
document.getElementById('btn-ai')!.addEventListener('click', async () => {
  if (!input.value.trim()) return;
  await env.aiReplies(input.value.trim());
  input.value = '';
  renderChat();
});
document.getElementById('btn-ai-auto')!.addEventListener('click', async () => {
  await env.aiReplies(fakeAiText());
  renderChat();
});
document.getElementById('btn-swipe')!.addEventListener('click', async () => {
  const last = env.messages[env.messages.length - 1];
  if (!last || last.role !== 'assistant') return alert('最后一楼不是 AI 回复');
  await env.swipeNew(input.value.trim() || fakeAiText());
  input.value = '';
  renderChat();
});
document.getElementById('btn-del')!.addEventListener('click', async () => {
  if (env.messages.length <= 1) return;
  await env.deleteFrom(env.messages.length - 1);
  renderChat();
});
env.busOn('f1m_changed', () => {
  const st = ctrl.status();
  status.textContent = `楼层 ${st.latestFloor + 1} · 版本 ${st.revisions} · ${st.hasGame ? '已开局' : '未开局'}`;
});

renderChat();
