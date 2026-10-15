// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { act, advanceUntil, newTestGame } from '../helpers';
import { buildView } from '../../src/engine/view';
import { store } from '../../src/ui/panel/bridge';
import AppPanel from '../../src/ui/panel/App.vue';
import Weekend from '../../src/ui/panel/views/Weekend.vue';

const mounted: App[] = [];

function qualifyingView(kind: 'qualifying' | 'sprint_qualifying', survivingPlayerCount = 1) {
  let state = advanceUntil(newTestGame(kind === 'qualifying' ? 314 : 322), value => value.season.phase === kind, 1200);
  state = act(state, { type: 'START_QUALIFYING', kind });
  const live = state.weekend!.liveQualifying!;
  const playerIds = state.teams[state.meta.playerTeamId].cars.map(car => car.driverId).filter((id): id is string => !!id);
  const survivor = playerIds[0];
  const eliminated = playerIds[1];
  live.alive = [...playerIds.slice(0, survivingPlayerCount), ...live.alive.filter(id => !playerIds.includes(id))];
  return { view: buildView(state), survivor, eliminated };
}

function mountWeekend(view: ReturnType<typeof buildView>) {
  store.connected = true;
  store.view = view;
  store.status = { generating: false, settings: { engineerApi: 'main' } } as never;
  store.busy = false;
  (window as any).F1Manager = { dispatch: vi.fn(async () => ({ ok: true, message: 'ok' })) };
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(Weekend);
  mounted.push(app);
  app.mount(host);
  return host;
}

function mountApp(view: ReturnType<typeof buildView>) {
  store.connected = true;
  store.view = view;
  store.status = { generating: false, settings: { engineerApi: 'main' } } as never;
  store.busy = false;
  store.tab = 'overview';
  store.panelVisible = true;
  (window as any).F1Manager = {
    dispatch: vi.fn(async () => ({ ok: true, message: 'ok' })),
    status: () => store.status,
    view: () => view,
    getSpecialNegotiation: () => null,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(AppPanel);
  mounted.push(app);
  app.mount(host);
  return host;
}

function driverCard(host: HTMLElement, driverName: string): HTMLElement {
  return [...host.querySelectorAll<HTMLElement>('.live-qualifying .driver-card')].find(card => card.textContent?.includes(driverName))!;
}

afterEach(() => {
  mounted.splice(0).forEach(app => app.unmount());
  document.body.replaceChildren();
  delete (window as any).F1Manager;
  store.connected = false;
  store.status = null;
  store.view = null;
  store.busy = false;
  store.tab = 'overview';
  store.panelVisible = true;
  window.dispatchEvent(new Event('pagehide'));
});

describe('segmented qualifying tyre selection UI', () => {
  it.each([
    'qualifying',
    'sprint_qualifying',
  ] as const)('hides the eliminated %s driver and keeps the survivor tyre panel', async kind => {
    const { view, survivor, eliminated } = qualifyingView(kind);
    const host = mountWeekend(view);
    await nextTick();

    const survivorName = view.weekend!.drivers.find(driver => driver.driverId === survivor)!.driverName;
    const eliminatedName = view.weekend!.drivers.find(driver => driver.driverId === eliminated)!.driverName;
    const survivorCard = driverCard(host, survivorName);
    expect(survivorCard.querySelectorAll('select')).toHaveLength(1);
    expect(driverCard(host, eliminatedName)).toBeUndefined();
  });

  it('hides both player tyre panels when both drivers are eliminated', async () => {
    const { view } = qualifyingView('qualifying', 0);
    const host = mountWeekend(view);
    await nextTick();

    expect(host.querySelectorAll('.live-qualifying .driver-card')).toHaveLength(0);
    expect(host.textContent).toContain('本队车手已全部淘汰');
    expect(host.textContent).toContain('结束排位赛');
  });

  it.each([
    'qualifying',
    'sprint_qualifying',
  ] as const)('dispatches top-level completion after both player drivers exit %s', async kind => {
    const { view } = qualifyingView(kind, 0);
    const host = mountApp(view);
    await nextTick();

    const button = [...host.querySelectorAll<HTMLButtonElement>('header .primary')].find(candidate => candidate.textContent?.includes('结束排位赛'));
    expect(button?.textContent).toContain('结束排位赛');
    button!.click();
    await Promise.resolve();

    expect((window as any).F1Manager.dispatch).toHaveBeenCalledWith({ type: 'SIMULATE_QUALIFYING', kind });
  });

  it('offers one-click automatic qualifying before the live desk starts', async () => {
    const state = advanceUntil(newTestGame(416), value => value.season.phase === 'qualifying', 1200);
    const host = mountWeekend(buildView(state));
    await nextTick();

    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === '模拟排位赛')!;
    button.click();
    await Promise.resolve();
    expect((window as any).F1Manager.dispatch).toHaveBeenCalledWith({ type: 'SIMULATE_QUALIFYING', kind: 'qualifying' });
  });

  it('clusters nearby track markers for the mobile layout', async () => {
    const { view } = qualifyingView('qualifying');
    const cars = view.weekend!.liveQualifying!.cars.slice(0, 4);
    cars.forEach((car, index) => {
      car.phase = 'flying_lap';
      car.progress = .4 + index * .02;
    });
    const host = mountWeekend(view);
    await nextTick();

    const cluster = [...host.querySelectorAll<HTMLButtonElement>('.mobile-marker.cluster')].find(button => button.textContent === '+4');
    expect(cluster).toBeTruthy();
    expect(cluster?.querySelector('em')).toBeNull();
    cluster?.click();
    await nextTick();
    expect(host.querySelectorAll('.mobile-cluster-picker button')).toHaveLength(4);
  });

  it('stages a physical set without releasing, then sends one guarded release action', async () => {
    let state = advanceUntil(newTestGame(414), value => value.season.phase === 'qualifying', 1200);
    state = act(state, { type: 'START_QUALIFYING', kind: 'qualifying' });
    const view = buildView(state);
    const host = mountWeekend(view);
    await nextTick();

    const dispatch = (window as any).F1Manager.dispatch as ReturnType<typeof vi.fn>;
    const select = host.querySelector<HTMLSelectElement>('.live-qualifying .driver-card select')!;
    select.dispatchEvent(new Event('change'));
    await nextTick();
    expect(dispatch).not.toHaveBeenCalled();

    const release = host.querySelector<HTMLButtonElement>('.live-qualifying .driver-card .release')!;
    release.click();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      type: 'RELEASE_QUALIFYING_CAR',
      sessionId: view.weekend!.liveQualifying!.id,
      expectedRevision: view.weekend!.liveQualifying!.revision,
      driverId: view.weekend!.liveQualifying!.cars.find(car => car.player)!.driverId,
      tyreSetId: select.value,
    });
  });

  it('pauses a restored running session instead of starting browser playback', async () => {
    let state = advanceUntil(newTestGame(415), value => value.season.phase === 'qualifying', 1200);
    state = act(state, { type: 'START_QUALIFYING', kind: 'qualifying' });
    let live = state.weekend!.liveQualifying!;
    state = act(state, { type: 'SET_QUALIFYING_CLOCK', sessionId: live.id, expectedRevision: live.revision, paused: false, speed: 8 });
    const view = buildView(state);
    mountWeekend(view);
    await nextTick();
    await Promise.resolve();

    const dispatch = (window as any).F1Manager.dispatch as ReturnType<typeof vi.fn>;
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SET_QUALIFYING_CLOCK',
      sessionId: view.weekend!.liveQualifying!.id,
      expectedRevision: view.weekend!.liveQualifying!.revision,
      paused: true,
      speed: 8,
    }));
    expect(dispatch.mock.calls.some(call => call[0]?.type === 'ADVANCE_QUALIFYING')).toBe(false);
  });
});
