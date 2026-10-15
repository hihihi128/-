// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import type { GameView } from '../../src/engine/view';
import { store } from '../../src/ui/panel/bridge';
import LiveRaceDesk from '../../src/ui/panel/components/LiveRaceDesk.vue';
import Weekend from '../../src/ui/panel/views/Weekend.vue';
import { IMPORTANT_RACE_PAUSES, narrationPauseView, postRaceNarrationView, runningLiveRaceView } from '../fixtures/live-race-narration';

const mounted: App[] = [];

function mount(component: Parameters<typeof createApp>[0], view: GameView, requestNarration: (text?: string) => Promise<{ ok: boolean; message: string }>) {
  store.connected = true;
  store.view = view;
  store.status = { generating: false, settings: { engineerApi: 'main' } } as never;
  store.busy = false;
  (window as any).F1Manager = { requestNarration };
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(component);
  mounted.push(app);
  app.mount(host);
  return host;
}

async function flushUi(): Promise<void> {
  await Promise.resolve();
  await nextTick();
}

afterEach(() => {
  mounted.splice(0).forEach(app => app.unmount());
  document.body.replaceChildren();
  delete (window as any).F1Manager;
  store.connected = false;
  store.status = null;
  store.view = null;
  store.busy = false;
});

describe('live-race main-chat narration', () => {
  it.each(IMPORTANT_RACE_PAUSES)('narrates the current %s pause without changing the race view', async (reason, label) => {
    const view = narrationPauseView(reason);
    const before = structuredClone(view.weekend!.liveRace);
    const prompts: string[] = [];
    const requestNarration = vi.fn(async (text?: string) => {
      prompts.push(text ?? '');
      return { ok: true, message: '已请求 AI 叙述' };
    });
    const host = mount(LiveRaceDesk, view, requestNarration);
    await nextTick();

    const button = host.querySelector<HTMLButtonElement>('.narrate-pause')!;
    expect(button.textContent).toContain('让 AI 叙述当前暂停');
    button.click();
    await flushUi();

    expect(requestNarration).toHaveBeenCalledTimes(1);
    expect(requestNarration).toHaveBeenCalledWith(expect.stringContaining(label));
    expect(prompts[0]).toContain('只写已经发生的事和当前可见信息');
    expect(prompts[0]).toContain('不要替领队作出任何策略选择');
    expect(prompts[0]).toContain('本次不要输出 <F1M_UPDATE> 指令');
    expect(view.weekend!.liveRace).toEqual(before);
  });

  it('offers race-result narration from the reachable post-race queue, not a removed live-race state', async () => {
    const requestNarration = vi.fn(async () => ({ ok: true, message: '已请求 AI 叙述' }));
    const postRace = postRaceNarrationView();
    expect(postRace.weekend!.liveRace).toBeNull();
    const host = mount(Weekend, postRace, requestNarration);
    await nextTick();

    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.includes('让 AI 叙述比赛结果'))!;
    expect(button.textContent).toContain('让 AI 叙述比赛结果');
    button.click();
    await flushUi();
    expect(requestNarration).toHaveBeenCalledTimes(1);
    expect(requestNarration).toHaveBeenCalledWith();
  });

  it('hides pause narration while a race is running', async () => {
    const host = mount(LiveRaceDesk, runningLiveRaceView(), vi.fn(async () => ({ ok: true, message: '已请求 AI 叙述' })));
    await nextTick();
    expect(host.querySelector('.narrate-pause')).toBeNull();
  });

  it('disables narration while a request is active and prevents a second request', async () => {
    let settle!: (value: { ok: boolean; message: string }) => void;
    const requestNarration = vi.fn(() => new Promise<{ ok: boolean; message: string }>(resolve => { settle = resolve; }));
    const host = mount(LiveRaceDesk, narrationPauseView('grid'), requestNarration);
    await nextTick();

    const button = host.querySelector<HTMLButtonElement>('.narrate-pause')!;
    button.click();
    await nextTick();
    expect(button.disabled).toBe(true);
    button.click();
    expect(requestNarration).toHaveBeenCalledTimes(1);

    settle({ ok: true, message: '已请求 AI 叙述' });
    await flushUi();
    expect(button.disabled).toBe(false);

    store.status = { generating: true } as never;
    await nextTick();
    expect(button.disabled).toBe(true);
  });
});
