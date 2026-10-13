/**
 * F1 领队模拟器 · 后端脚本入口（酒馆助手「角色脚本」）
 *
 * 运行环境：酒馆助手脚本 iframe（<script type="module">），可直接使用酒馆助手全局接口。
 * 构建时 panel.html 会被内联成字符串（见 scripts/build.mjs）。
 */
import PANEL_HTML from '../../dist/f1m-panel.html';
import { createApi } from './api';
import { CHANGE_EVENT, F1Controller } from './controller';
import { createTavernEnv } from './env';
import { PanelHost } from './panelHost';

declare const $: any;
declare const errorCatched: <T extends (...a: any[]) => any>(fn: T) => T;

const BTN_PANEL = 'F1管理面板';
const BTN_NARRATE = 'AI叙述';

let panel: PanelHost | null = null;
let unsubscribePanelStatus: (() => void) | null = null;

function init(): void {
  unsubscribePanelStatus?.();
  unsubscribePanelStatus = null;
  panel?.destroy();
  panel = null;
  const env = createTavernEnv();
  const ctrl = new F1Controller(env);
  ctrl.init();
  const doc = env.hostDocument();
  if (doc) panel = new PanelHost(doc, PANEL_HTML);
  const updatePanelStatus = () => {
    const status = ctrl.status();
    const hud = ctrl.hud(ctrl.latestFloor());
    const view = ctrl.view();
    panel?.updateStatus({
      hasGame: status.hasGame,
      teamLabel: hud.team?.name,
      teamColor: hud.team?.color,
      year: view?.season.year,
      round: view ? view.season.roundIndex + 1 : undefined,
      roundCount: view?.season.rounds,
      trackLabel: hud.season?.track,
      phaseLabel: view?.season.phaseLabel,
      pendingNarration: hud.pending,
      generating: status.generating,
    });
  };
  unsubscribePanelStatus = ctrl.subscribe(updatePanelStatus);
  updatePanelStatus();
  const api = createApi(ctrl, () => panel);
  env.exposeGlobal('F1Manager', api);
  env.ensureButtons([BTN_PANEL, BTN_NARRATE]);
  env.on(env.buttonEvent(BTN_PANEL), () => panel?.toggle());
  env.on(env.buttonEvent(BTN_NARRATE), async () => {
    const r = await ctrl.requestNarration();
    if (!r.ok) env.toast('warning', r.message);
  });
  // 通知已渲染的状态条刷新（脚本晚于楼层加载时）
  env.emit(CHANGE_EVENT, 'backend_ready');
  if (!ctrl.status().hasGame && env.lastMessageId() <= 0) {
    env.toast('info', '点击输入框附近的「F1管理面板」按钮，选择车队开始新赛季。');
  }
  console.info('[F1M] 后端已加载');
}

$(() => {
  errorCatched(init)();
});

$(window).on('pagehide', () => {
  unsubscribePanelStatus?.();
  unsubscribePanelStatus = null;
  panel?.destroy();
  panel = null;
  try {
    delete (window.parent as any).F1Manager;
  } catch {
    /* 忽略 */
  }
});
