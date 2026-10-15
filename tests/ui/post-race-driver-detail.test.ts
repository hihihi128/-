// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { act, advanceUntil, newTestGame } from '../helpers';
import { buildView } from '../../src/engine/view';
import { store } from '../../src/ui/panel/bridge';
import Weekend from '../../src/ui/panel/views/Weekend.vue';

const mounted: App[] = [];

function mountWeekend(view: ReturnType<typeof buildView>) {
  store.connected = true;
  store.view = view;
  store.status = { generating: false, settings: { engineerApi: 'main' } } as never;
  store.busy = false;
  store.tab = 'weekend';
  (window as any).F1Manager = { dispatch: vi.fn(async () => ({ ok: true, message: 'ok' })) };
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(Weekend);
  mounted.push(app);
  app.mount(host);
  return host;
}

afterEach(() => {
  mounted.splice(0).forEach(app => app.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  delete (window as any).F1Manager;
});

describe('post-race driver details', () => {
  it('opens pit-stop laps and the selected driver position chart from the classification', async () => {
    let state = advanceUntil(newTestGame(891), value => value.season.phase === 'race', 1200);
    state = act(state, { type: 'RUN_RACE' });
    const result = state.weekend!.race!;
    const entry = result.classification.find(candidate => candidate.pitStops?.length)!;
    const host = mountWeekend(buildView(state));
    await nextTick();

    const button = [...host.querySelectorAll<HTMLButtonElement>('.result-driver')].find(candidate => candidate.textContent?.includes(state.drivers[entry.driverId].name))!;
    button.click();
    await nextTick();

    const detail = host.querySelector('.result-driver-detail')!;
    expect(detail.textContent).toContain('车手比赛详情');
    expect(detail.textContent).toContain(`第 ${entry.pitStops![0].lap} 圈`);
    expect(detail.textContent).toContain(`静止 ${entry.pitStops![0].actualStationary.toFixed(1)}s`);
    expect(detail.querySelector('.chart')).not.toBeNull();
    expect(result.lapChart[entry.driverId]).toHaveLength(result.laps);
  });
});
