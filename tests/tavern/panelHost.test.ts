// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { PanelHost } from '../../src/tavern/panelHost';

function pointer(type: string, x: number, y: number): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

function setViewport(width: number, height: number): void {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: width },
    innerHeight: { configurable: true, value: height },
  });
}

describe('PanelHost 迷你状态卡', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.head.querySelector('#f1m-panel-style')?.remove();
    localStorage.clear();
    setViewport(1024, 768);
  });

  it('最小化时保留同一个 iframe，并在状态更新后恢复原面板', () => {
    const host = new PanelHost(document, '<!doctype html><title>F1 领队管理面板</title>');
    host.updateStatus({
      hasGame: true,
      teamLabel: '测试车队',
      teamColor: '#e10600',
      year: 2026,
      round: 3,
      roundCount: 24,
      trackLabel: '墨尔本',
      phaseLabel: '赛前准备',
      pendingNarration: 2,
      generating: false,
    });
    host.open();
    const root = document.getElementById('f1m-panel-root')!;
    const frame = root.querySelector('iframe')!;
    const srcdoc = frame.srcdoc;

    host.minimize();
    expect(host.isOpen()).toBe(false);
    expect(root.classList.contains('f1m-minimized')).toBe(true);
    expect(root.querySelector('iframe')).toBe(frame);
    expect(frame.srcdoc).toBe(srcdoc);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(root.textContent).toContain('测试车队');
    expect(root.textContent).toContain('待叙述 2');

    host.updateStatus({ hasGame: false, pendingNarration: 0, generating: true });
    expect(root.textContent).toContain('未开局');
    expect(root.textContent).toContain('AI 生成中');

    host.restore();
    expect(host.isOpen()).toBe(true);
    expect(root.classList.contains('f1m-minimized')).toBe(false);
    expect(root.querySelector('iframe')).toBe(frame);
    expect(frame.srcdoc).toBe(srcdoc);
    expect(frame.hasAttribute('aria-hidden')).toBe(false);
  });

  it('拖动迷你卡会单独保存位置且不会误恢复面板', () => {
    setViewport(800, 600);
    const host = new PanelHost(document, '<!doctype html>');
    host.open();
    host.minimize();
    const root = document.getElementById('f1m-panel-root')!;
    const handle = root.querySelector('.f1m-mini-handle') as HTMLElement;
    const body = root.querySelector('.f1m-mini-body') as HTMLElement;
    Object.assign(handle, { setPointerCapture: () => undefined });
    root.getBoundingClientRect = () => ({
      x: Number.parseFloat(root.style.left) || 0,
      y: Number.parseFloat(root.style.top) || 0,
      left: Number.parseFloat(root.style.left) || 0,
      top: Number.parseFloat(root.style.top) || 0,
      right: 0,
      bottom: 0,
      width: 320,
      height: 178,
      toJSON: () => ({}),
    });

    handle.dispatchEvent(pointer('pointerdown', 10, 10));
    handle.dispatchEvent(pointer('pointermove', 900, 900));
    handle.dispatchEvent(pointer('pointerup', 900, 900));
    expect(root.style.left).toBe('472px');
    expect(root.style.top).toBe('414px');
    expect(JSON.parse(localStorage.getItem('f1m-panel-mini-geom')!)).toEqual({ left: 472, top: 414 });

    body.click();
    expect(host.isOpen()).toBe(false);
    body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(host.isOpen()).toBe(true);
    host.minimize();
    (root.querySelector('[data-act="restore"]') as HTMLButtonElement).click();
    expect(host.isOpen()).toBe(true);
  });

  it('clamps a stored mini position after a viewport resize and cleans up the host', () => {
    setViewport(1000, 700);
    localStorage.setItem('f1m-panel-mini-geom', JSON.stringify({ left: 900, top: 650 }));
    const host = new PanelHost(document, '<!doctype html>');
    host.open();
    host.minimize();
    const root = document.getElementById('f1m-panel-root')!;
    root.getBoundingClientRect = () => ({
      x: Number.parseFloat(root.style.left) || 0,
      y: Number.parseFloat(root.style.top) || 0,
      left: Number.parseFloat(root.style.left) || 0,
      top: Number.parseFloat(root.style.top) || 0,
      right: 0,
      bottom: 0,
      width: 320,
      height: 178,
      toJSON: () => ({}),
    });
    setViewport(500, 300);
    window.dispatchEvent(new Event('resize'));
    expect(root.style.left).toBe('132px');
    expect(root.style.top).toBe('98px');

    host.destroy();
    expect(document.getElementById('f1m-panel-root')).toBeNull();
    expect(document.getElementById('f1m-panel-style')).toBeNull();
  });
});
