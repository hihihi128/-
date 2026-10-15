// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { act, advanceUntil, newTestGame } from '../helpers';
import { buildView } from '../../src/engine/view';
import { store } from '../../src/ui/panel/bridge';
import Weekend from '../../src/ui/panel/views/Weekend.vue';

const mounted: App[] = [];

function qualifyingView(kind: 'qualifying' | 'sprint_qualifying') {
  let state = advanceUntil(newTestGame(kind === 'qualifying' ? 314 : 322), value => value.season.phase === kind, 1200);
  state = act(state, { type: 'START_QUALIFYING', kind });
  const live = state.weekend!.liveQualifying!;
  const playerIds = state.teams[state.meta.playerTeamId].cars.map(car => car.driverId).filter((id): id is string => !!id);
  const survivor = playerIds[0];
  const eliminated = playerIds[1];
  live.alive = [survivor, ...live.alive.filter(id => !playerIds.includes(id))];
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
});

describe('segmented qualifying tyre selection UI', () => {
  it.each([
    'qualifying',
    'sprint_qualifying',
  ] as const)('keeps %s status visible for eliminated and surviving drivers', async kind => {
    const { view, survivor, eliminated } = qualifyingView(kind);
    const host = mountWeekend(view);
    await nextTick();

    const survivorName = view.weekend!.drivers.find(driver => driver.driverId === survivor)!.driverName;
    const eliminatedName = view.weekend!.drivers.find(driver => driver.driverId === eliminated)!.driverName;
    const survivorCard = driverCard(host, survivorName);
    const eliminatedCard = driverCard(host, eliminatedName);
    expect(survivorCard.querySelectorAll('select')).toHaveLength(1);
    expect(eliminatedCard.textContent).toContain('该车手已被淘汰');
    expect(eliminatedCard.querySelectorAll('select')).toHaveLength(0);
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
});
