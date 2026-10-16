// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import type { GameView } from '../../src/engine/view';
import { store } from '../../src/ui/panel/bridge';
import LiveRaceDesk from '../../src/ui/panel/components/LiveRaceDesk.vue';
import { runningLiveRaceView } from '../fixtures/live-race-narration';

const mounted: App[] = [];

function mount(view: GameView) {
  const dispatch = vi.fn(async (_action: unknown) => ({ ok: true, message: '已执行' }));
  store.connected = true;
  store.view = view;
  store.status = { generating: false, settings: { engineerApi: 'main' } } as never;
  store.busy = false;
  store.panelVisible = true;
  store.tab = 'weekend';
  (window as any).F1Manager = {
    dispatch,
    status: () => store.status,
    view: () => store.view,
    getSpecialNegotiation: () => null,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(LiveRaceDesk);
  mounted.push(app);
  app.mount(host);
  return { host, dispatch };
}

async function flushUi() {
  await Promise.resolve();
  await nextTick();
}

function continueButton(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('继续比赛'))!;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

afterEach(() => {
  mounted.splice(0).forEach(app => app.unmount());
  document.body.replaceChildren();
  delete (window as any).F1Manager;
  store.connected = false;
  store.status = null;
  store.view = null;
  store.busy = false;
  store.panelVisible = true;
  store.tab = 'overview';
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.useRealTimers();
});

describe('live-race timeline lifecycle', () => {
  it('mounts a restored lap-zero race paused until the player continues', async () => {
    const view = runningLiveRaceView();
    view.weekend!.liveRace!.completedLaps = 0;
    const { host, dispatch } = mount(view);
    await flushUi();

    expect(host.textContent).toContain('时间轴已暂停');
    expect(continueButton(host)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatch).not.toHaveBeenCalled();

    continueButton(host).click();
    await flushUi();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ type: 'ADVANCE_RACE', until: 'next_lap' });
  });

  it('stops the timeline when the panel or page becomes hidden', async () => {
    const { host, dispatch } = mount(runningLiveRaceView());
    await flushUi();
    continueButton(host).click();
    await flushUi();

    store.panelVisible = false;
    await flushUi();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatch).not.toHaveBeenCalled();

    store.panelVisible = true;
    await flushUi();
    continueButton(host).click();
    await flushUi();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushUi();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('时间轴已暂停');
  });

  it('stops when another game or race session replaces the active view', async () => {
    const initial = runningLiveRaceView();
    const { host, dispatch } = mount(initial);
    await flushUi();
    continueButton(host).click();
    await flushUi();

    const replacement = structuredClone(initial);
    replacement.gameId = `${initial.gameId}-replacement`;
    replacement.weekend!.liveRace!.id = `${initial.weekend!.liveRace!.id}:replacement`;
    store.view = replacement;
    await flushUi();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(dispatch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('时间轴已暂停');
  });

  it('stops when a restored revision rolls the same race session backward', async () => {
    const initial = runningLiveRaceView();
    initial.weekend!.liveRace!.revision = 8;
    const { host, dispatch } = mount(initial);
    await flushUi();
    continueButton(host).click();
    await flushUi();

    const restored = structuredClone(initial);
    restored.weekend!.liveRace!.revision = 7;
    store.view = restored;
    await flushUi();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(dispatch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('时间轴已暂停');
  });
});
