/**
 * 悬浮管理面板宿主：在酒馆主页面里创建一个可拖动、可缩放的窗口，内嵌面板 iframe。
 * 面板 iframe 与酒馆同源，通过 window.parent.F1Manager 调用后端接口。
 */
const ROOT_ID = 'f1m-panel-root';
const STYLE_ID = 'f1m-panel-style';
const GEOM_KEY = 'f1m-panel-geom';
const MINI_GEOM_KEY = 'f1m-panel-mini-geom';
const MINI_MARGIN = 8;

type DisplayState = 'expanded' | 'minimized' | 'closed';
type ExpandedGeometry = Pick<CSSStyleDeclaration, 'left' | 'top' | 'width' | 'height'>;

export interface CompactStatus {
  hasGame: boolean;
  teamLabel?: string;
  teamColor?: string;
  year?: number;
  round?: number;
  roundCount?: number;
  trackLabel?: string;
  phaseLabel?: string;
  pendingNarration: number;
  generating: boolean;
}

const CSS = `
#${ROOT_ID}{position:fixed;z-index:9990;left:calc(50vw - 490px);top:6vh;width:980px;height:min(720px,88vh);
  max-width:100vw;max-height:100vh;min-width:340px;min-height:300px;display:flex;flex-direction:column;
  background:#0f1115;border:1px solid #2b303b;border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.65);overflow:hidden;resize:both}
#${ROOT_ID}.f1m-hidden{display:none}
#${ROOT_ID}.f1m-mobile{left:6px!important;top:max(6px,env(safe-area-inset-top))!important;width:calc(100vw - 12px)!important;height:calc(100dvh - max(12px,env(safe-area-inset-top) + env(safe-area-inset-bottom)))!important;border-radius:8px;resize:none;border:1px solid #2b303b}
#${ROOT_ID} .f1m-titlebar{flex:0 0 38px;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;
  background:linear-gradient(90deg,#e10600 0,#9e0b0b 28%,#16181d 70%);color:#fff;cursor:move;user-select:none;
  font:600 14px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;letter-spacing:.5px;touch-action:none}
#${ROOT_ID} .f1m-titlebar .f1m-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .f1m-titlebar button,#${ROOT_ID} .f1m-mini button{background:rgba(255,255,255,.08);border:0;color:#fff;width:30px;height:28px;border-radius:6px;
  font-size:16px;line-height:28px;cursor:pointer;padding:0}
#${ROOT_ID} .f1m-titlebar button:hover,#${ROOT_ID} .f1m-mini button:hover{background:rgba(255,255,255,.2)}
#${ROOT_ID} iframe{flex:1;border:0;width:100%;background:#0f1115;display:block}
#${ROOT_ID}.f1m-dragging iframe{pointer-events:none}
#${ROOT_ID} .f1m-mini{display:none}
#${ROOT_ID}.f1m-minimized{width:320px!important;height:178px!important;min-width:0;min-height:0;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);display:block;resize:none!important;overflow:hidden;border-radius:12px}
#${ROOT_ID}.f1m-minimized .f1m-titlebar,#${ROOT_ID}.f1m-minimized iframe{display:none}
#${ROOT_ID}.f1m-minimized .f1m-mini{height:100%;display:flex;flex-direction:column;color:#f3f5f7;background:linear-gradient(135deg,#181c24,#0e1015);font:13px/1.35 system-ui,-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
#${ROOT_ID} .f1m-mini-handle{height:38px;display:flex;align-items:center;gap:8px;padding:0 12px;background:linear-gradient(90deg,#e10600,#8d1010 58%,#1b1e24);cursor:move;touch-action:none;user-select:none}
#${ROOT_ID} .f1m-mini-handle strong{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}
#${ROOT_ID} .f1m-mini-body{flex:1;display:grid;grid-template-columns:1fr auto;grid-template-rows:auto 1fr;gap:8px 12px;padding:12px;cursor:pointer;outline:none}
#${ROOT_ID} .f1m-mini-body:focus-visible{box-shadow:inset 0 0 0 2px #fff}
#${ROOT_ID} .f1m-mini-season{color:#c8ced8;font-size:12px}
#${ROOT_ID} .f1m-mini-track{font-size:16px;font-weight:700;align-self:end;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .f1m-mini-meta{color:#aeb6c5;font-size:12px;text-align:right;align-self:end}
@media (max-width:767px){#${ROOT_ID}.f1m-minimized{width:360px!important;height:194px!important;min-width:0!important;min-height:0!important;border-radius:12px;resize:none!important}}
`;

export class PanelHost {
  private root: HTMLElement | null = null;
  private frame: HTMLIFrameElement | null = null;
  private loaded = false;
  private pendingTab: string | null = null;
  private displayState: DisplayState = 'closed';
  private compactStatus: CompactStatus = { hasGame: false, pendingNarration: 0, generating: false };
  private focusBeforeMinimize: HTMLElement | null = null;
  private expandedGeometry: ExpandedGeometry | null = null;

  constructor(
    private doc: Document,
    private html: string,
  ) {}

  private get win(): Window {
    return this.doc.defaultView ?? window;
  }

  private isMobile(): boolean {
    return this.win.innerWidth < 768;
  }

  private ensure(): void {
    if (this.root && this.doc.contains(this.root)) return;
    this.doc.getElementById(ROOT_ID)?.remove();
    if (!this.doc.getElementById(STYLE_ID)) {
      const style = this.doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      this.doc.head.appendChild(style);
    }
    const root = this.doc.createElement('div');
    root.id = ROOT_ID;
    root.className = 'f1m-hidden';
    root.innerHTML = `<div class="f1m-titlebar"><span class="f1m-title">F1 领队 · 管理面板</span>
      <button type="button" data-act="min" title="最小化面板" aria-label="最小化面板">−</button>
      <button type="button" data-act="reload" title="刷新面板" aria-label="刷新面板">⟳</button>
      <button type="button" data-act="max" title="最大化/还原" aria-label="最大化或还原">⤢</button>
      <button type="button" data-act="close" title="关闭" aria-label="关闭面板">✕</button></div>
      <div class="f1m-mini" aria-label="F1 领队迷你状态卡">
        <div class="f1m-mini-handle" aria-label="拖动迷你状态卡"><strong></strong><button type="button" data-act="restore" title="恢复面板" aria-label="恢复管理面板">↗</button></div>
        <div class="f1m-mini-body" role="button" tabindex="0" aria-label="恢复管理面板">
          <span class="f1m-mini-season"></span><span class="f1m-mini-phase"></span>
          <span class="f1m-mini-track"></span><span class="f1m-mini-meta"></span>
        </div>
      </div>`;
    const frame = this.doc.createElement('iframe');
    frame.setAttribute('title', 'F1 领队管理面板');
    root.appendChild(frame);
    this.doc.body.appendChild(root);
    this.root = root;
    this.frame = frame;
    this.loaded = false;
    this.restoreGeometry();
    this.renderStatus();
    this.bind();
  }

  private bind(): void {
    const root = this.root!;
    const bar = root.querySelector('.f1m-titlebar') as HTMLElement;
    const miniHandle = root.querySelector('.f1m-mini-handle') as HTMLElement;
    const miniRestore = root.querySelector('[data-act="restore"]') as HTMLButtonElement;
    const miniBody = root.querySelector('.f1m-mini-body') as HTMLElement;
    bar.addEventListener('click', ev => {
      const act = (ev.target as HTMLElement).closest('button')?.getAttribute('data-act');
      if (act === 'close') this.close();
      if (act === 'max') this.toggleMax();
      if (act === 'reload') this.reload();
      if (act === 'min') this.minimize();
    });
    this.bindDrag(bar, false, ev => !!(ev.target as HTMLElement).closest('button'));
    this.bindDrag(miniHandle, true, ev => !!(ev.target as HTMLElement).closest('button'));
    miniRestore.addEventListener('click', () => this.restore());
    miniBody.addEventListener('click', () => this.restore());
    miniBody.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      this.restore();
    });
    root.addEventListener('mouseup', () => this.saveGeometry());
    this.win.addEventListener('resize', this.onResize);
    this.win.addEventListener('orientationchange', this.onResize);
  }

  private bindDrag(handle: HTMLElement, mini: boolean, skip?: (ev: PointerEvent) => boolean): void {
    const root = this.root!;
    let start: { x: number; y: number; left: number; top: number } | null = null;
    const end = () => {
      if (!start) return;
      start = null;
      root.classList.remove('f1m-dragging');
      if (mini) {
        this.clampMiniPosition();
        this.saveMiniGeometry();
      } else {
        this.saveGeometry();
      }
    };
    handle.addEventListener('pointerdown', ev => {
      if (skip?.(ev) || (!mini && this.isMobile())) return;
      const rect = root.getBoundingClientRect();
      start = { x: ev.clientX, y: ev.clientY, left: rect.left, top: rect.top };
      root.classList.add('f1m-dragging');
      handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener('pointermove', ev => {
      if (!start) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (mini) {
        const { left, top } = this.clampMiniCoordinates(start.left + dx, start.top + dy);
        root.style.left = `${left}px`;
        root.style.top = `${top}px`;
      } else {
        const left = Math.min(Math.max(start.left + dx, -root.offsetWidth + 120), this.win.innerWidth - 120);
        const top = Math.min(Math.max(start.top + dy, 0), this.win.innerHeight - 40);
        root.style.left = `${left}px`;
        root.style.top = `${top}px`;
      }
    });
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  }

  private onResize = () => {
    if (!this.root) return;
    const mobile = this.isMobile();
    this.root.classList.toggle('f1m-mobile', mobile && this.displayState !== 'minimized');
    if (this.displayState === 'minimized') this.clampMiniPosition();
    // An iframe's CSS media query can retain a desktop layout viewport even
    // when its host is narrow. Mirror the host mode into the panel document
    // so component styles can respond to the actual usable panel width.
    this.frame?.contentDocument?.documentElement.classList.toggle('f1m-mobile', mobile);
  };

  private saveGeometry(): void {
    if (!this.root || this.isMobile() || this.displayState !== 'expanded' || this.root.dataset.max === '1') return;
    const r = this.root.getBoundingClientRect();
    try {
      this.win.localStorage.setItem(GEOM_KEY, JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height }));
    } catch {
      /* 隐私模式 */
    }
  }

  private rememberExpandedGeometry(): void {
    if (!this.root) return;
    const { left, top, width, height } = this.root.style;
    this.expandedGeometry = { left, top, width, height };
  }

  private restoreExpandedGeometry(): void {
    if (!this.root || !this.expandedGeometry) return;
    Object.assign(this.root.style, this.expandedGeometry);
    this.expandedGeometry = null;
  }

  private restoreGeometry(): void {
    const root = this.root!;
    root.classList.toggle('f1m-mobile', this.isMobile());
    try {
      const g = JSON.parse(this.win.localStorage.getItem(GEOM_KEY) ?? 'null');
      if (g && g.width > 300 && g.height > 250) {
        const w = this.win;
        root.style.width = `${Math.min(g.width, w.innerWidth)}px`;
        root.style.height = `${Math.min(g.height, w.innerHeight)}px`;
        root.style.left = `${Math.min(Math.max(g.left, 0), Math.max(0, w.innerWidth - 200))}px`;
        root.style.top = `${Math.min(Math.max(g.top, 0), Math.max(0, w.innerHeight - 80))}px`;
      }
    } catch {
      /* 忽略 */
    }
  }

  private miniSize(): { width: number; height: number } {
    return this.isMobile() ? { width: 360, height: 194 } : { width: 320, height: 178 };
  }

  private clampMiniCoordinates(left: number, top: number): { left: number; top: number } {
    const size = this.miniSize();
    const width = Math.min(size.width, Math.max(1, this.win.innerWidth - MINI_MARGIN * 2));
    const height = Math.min(size.height, Math.max(1, this.win.innerHeight - MINI_MARGIN * 2));
    const maxLeft = Math.max(MINI_MARGIN, this.win.innerWidth - width - MINI_MARGIN);
    const maxTop = Math.max(MINI_MARGIN, this.win.innerHeight - height - MINI_MARGIN);
    return {
      left: Math.min(Math.max(left, MINI_MARGIN), maxLeft),
      top: Math.min(Math.max(top, MINI_MARGIN), maxTop),
    };
  }

  private clampMiniPosition(): void {
    if (!this.root) return;
    const rect = this.root.getBoundingClientRect();
    const { left, top } = this.clampMiniCoordinates(rect.left, rect.top);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  private restoreMiniGeometry(): void {
    let left = this.win.innerWidth - this.miniSize().width - 24;
    let top = Math.max(MINI_MARGIN, this.win.innerHeight - this.miniSize().height - 24);
    try {
      const saved = JSON.parse(this.win.localStorage.getItem(MINI_GEOM_KEY) ?? 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) ({ left, top } = saved);
    } catch {
      /* 忽略 */
    }
    const clamped = this.clampMiniCoordinates(left, top);
    this.root!.style.left = `${clamped.left}px`;
    this.root!.style.top = `${clamped.top}px`;
  }

  private saveMiniGeometry(): void {
    if (!this.root) return;
    const rect = this.root.getBoundingClientRect();
    try {
      this.win.localStorage.setItem(MINI_GEOM_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch {
      /* 隐私模式 */
    }
  }

  private toggleMax(): void {
    if (!this.root || this.displayState !== 'expanded') return;
    const maxed = this.root.dataset.max === '1';
    if (maxed) {
      this.root.dataset.max = '0';
      this.restoreGeometry();
    } else {
      this.saveGeometry();
      this.root.dataset.max = '1';
      Object.assign(this.root.style, { left: '0px', top: '0px', width: '100vw', height: '100vh' });
    }
  }

  private load(): void {
    if (!this.frame || this.loaded) return;
    this.loaded = true;
    this.frame.addEventListener(
      'load',
      () => {
        this.onResize();
        if (this.pendingTab) this.sendTab(this.pendingTab);
        this.sendVisibility(this.displayState === 'expanded');
        this.pendingTab = null;
      },
      { once: true },
    );
    this.frame.srcdoc = this.html;
  }

  private sendTab(tab: string): void {
    try {
      this.frame?.contentWindow?.postMessage({ type: 'f1m:tab', tab }, '*');
    } catch {
      /* 忽略 */
    }
  }

  private sendVisibility(visible: boolean): void {
    try {
      this.frame?.contentWindow?.postMessage({ type: 'f1m:visibility', visible }, '*');
    } catch {
      /* 忽略 */
    }
  }

  private renderStatus(): void {
    if (!this.root) return;
    const status = this.compactStatus;
    const team = this.root.querySelector('.f1m-mini-handle strong') as HTMLElement;
    const season = this.root.querySelector('.f1m-mini-season') as HTMLElement;
    const phase = this.root.querySelector('.f1m-mini-phase') as HTMLElement;
    const track = this.root.querySelector('.f1m-mini-track') as HTMLElement;
    const meta = this.root.querySelector('.f1m-mini-meta') as HTMLElement;
    if (!status.hasGame) {
      team.style.color = '';
      team.textContent = 'F1 领队 · 未开局';
      season.textContent = '点击恢复面板，选择车队开始赛季';
      phase.textContent = '';
      track.textContent = '管理面板待命';
      meta.textContent = status.generating ? 'AI 生成中' : '';
      return;
    }
    team.textContent = status.teamLabel ?? 'F1 领队';
    team.style.color = status.teamColor ?? '';
    season.textContent = status.year && status.round && status.roundCount ? `${status.year} 赛季 · 第 ${status.round}/${status.roundCount} 站` : '';
    phase.textContent = status.phaseLabel ?? '';
    track.textContent = status.trackLabel || '赛程准备中';
    const pending = status.pendingNarration > 0 ? `待叙述 ${status.pendingNarration}` : '';
    meta.textContent = [status.generating ? 'AI 生成中' : '', pending].filter(Boolean).join(' · ');
  }

  updateStatus(status: CompactStatus): void {
    this.compactStatus = { ...status };
    this.renderStatus();
  }

  isOpen(): boolean {
    return this.displayState === 'expanded';
  }

  open(tab?: string): void {
    this.ensure();
    if (this.displayState === 'minimized') this.restore();
    this.displayState = 'expanded';
    this.root!.classList.remove('f1m-hidden', 'f1m-minimized');
    this.root!.classList.toggle('f1m-mobile', this.isMobile());
    this.frame?.removeAttribute('aria-hidden');
    if (this.frame) this.frame.tabIndex = 0;
    this.sendVisibility(true);
    if (!this.loaded) {
      this.pendingTab = tab ?? null;
      this.load();
    } else if (tab) {
      this.sendTab(tab);
    }
  }

  minimize(): void {
    this.ensure();
    if (this.displayState !== 'expanded') return;
    const active = this.doc.activeElement;
    this.focusBeforeMinimize = active instanceof HTMLElement ? active : null;
    this.rememberExpandedGeometry();
    this.displayState = 'minimized';
    this.root!.classList.remove('f1m-hidden', 'f1m-mobile');
    this.root!.classList.add('f1m-minimized');
    this.frame?.setAttribute('aria-hidden', 'true');
    if (this.frame) this.frame.tabIndex = -1;
    this.sendVisibility(false);
    this.restoreMiniGeometry();
    (this.root!.querySelector('.f1m-mini-body') as HTMLElement).focus();
  }

  restore(): void {
    if (!this.root || this.displayState !== 'minimized') return;
    this.displayState = 'expanded';
    this.root.classList.remove('f1m-minimized');
    this.restoreExpandedGeometry();
    this.root.classList.toggle('f1m-mobile', this.isMobile());
    this.frame?.removeAttribute('aria-hidden');
    if (this.frame) this.frame.tabIndex = 0;
    this.sendVisibility(true);
    const focusTarget = this.focusBeforeMinimize?.isConnected ? this.focusBeforeMinimize : (this.root.querySelector('[data-act="min"]') as HTMLElement);
    focusTarget?.focus();
    this.focusBeforeMinimize = null;
  }

  close(): void {
    if (!this.root) return;
    this.restoreExpandedGeometry();
    this.displayState = 'closed';
    this.root.classList.remove('f1m-minimized');
    this.root.classList.add('f1m-hidden');
    this.root.classList.toggle('f1m-mobile', this.isMobile());
    this.frame?.removeAttribute('aria-hidden');
    if (this.frame) this.frame.tabIndex = 0;
    this.sendVisibility(false);
  }

  toggle(tab?: string): void {
    if (this.isOpen()) this.close();
    else this.open(tab);
  }

  reload(): void {
    if (!this.frame) return;
    this.loaded = false;
    this.load();
  }

  destroy(): void {
    this.win.removeEventListener('resize', this.onResize);
    this.win.removeEventListener('orientationchange', this.onResize);
    this.root?.remove();
    this.doc.getElementById(STYLE_ID)?.remove();
    this.root = null;
    this.frame = null;
    this.displayState = 'closed';
  }
}
