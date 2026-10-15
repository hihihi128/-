// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import type { GameView } from '../../src/engine/view';
import { store } from '../../src/ui/panel/bridge';
import LiveRaceDesk from '../../src/ui/panel/components/LiveRaceDesk.vue';
import { narrationPauseView } from '../fixtures/live-race-narration';

const mounted: App[] = [];
function wetGridView(): GameView {
  const view = narrationPauseView('grid');
  const live = view.weekend!.liveRace!;
  live.pendingDecision!.startTyreOptions = [view.rules.wetCompound, view.rules.fullWetCompound];
  live.pendingDecision!.eligibleDriverIds = live.playerCars.map(car => car.driverId);
  return view;
}
function dryGridView(): GameView {
  const view = narrationPauseView('grid');
  const live = view.weekend!.liveRace!;
  live.pendingDecision!.startTyreOptions = [...view.rules.dryCompounds, view.rules.wetCompound, view.rules.fullWetCompound];
  live.pendingDecision!.eligibleDriverIds = live.playerCars.map(car => car.driverId);
  return view;
}
function mount(view: GameView, dispatch = vi.fn(async () => ({ ok: true, message: '已确认' }))) {
  store.connected = true;
  store.view = view;
  store.status = { generating: false, settings: { engineerApi: 'main' } } as never;
  store.busy = false;
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

afterEach(() => {
  mounted.splice(0).forEach(app => app.unmount());
  document.body.replaceChildren();
  delete (window as any).F1Manager;
  store.connected = false;
  store.status = null;
  store.view = null;
  store.busy = false;
});

describe('wet-grid starting tyre choices', () => {
  it('requires an independent native radio choice for each player car before confirming', async () => {
    const view = wetGridView();
    const { host, dispatch } = mount(view);
    await nextTick();

    const groups = host.querySelectorAll('fieldset.grid-tyre-choice');
    expect(groups).toHaveLength(view.weekend!.liveRace!.playerCars.length);
    expect(host.textContent).toContain('不会产生进站时间或进站次数');
    const confirm = host.querySelector<HTMLButtonElement>('.confirm')!;
    expect(confirm.disabled).toBe(true);
    expect(confirm.classList.contains('sticky-ready')).toBe(false);
    expect(host.querySelectorAll<HTMLInputElement>('input[type="radio"]')).toHaveLength(groups.length * 2);

    const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const firstDriverId = radios[0].name.replace('grid-tyre-', '');
    const secondDriverId = radios[3].name.replace('grid-tyre-', '');
    radios[0].click();
    await nextTick();
    expect(confirm.disabled).toBe(true);
    expect(confirm.classList.contains('sticky-ready')).toBe(false);
    radios[3].click();
    await nextTick();
    expect(confirm.disabled).toBe(false);
    expect(confirm.classList.contains('sticky-ready')).toBe(false);
    confirm.click();
    await nextTick();

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'RESOLVE_RACE_DECISION', drivers: expect.arrayContaining([
      expect.objectContaining({ driverId: firstDriverId, pit: 'auto', startCompound: view.rules.wetCompound }),
      expect.objectContaining({ driverId: secondDriverId, pit: 'auto', startCompound: view.rules.fullWetCompound, paceMode: 'balanced', energyMode: 'balanced', pitTiming: 'standard' }),
    ]) }));
  });

  it('disables wet-grid selectors and confirmation while the panel is busy', async () => {
    const { host } = mount(wetGridView());
    store.busy = true;
    await nextTick();
    expect(host.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.confirm')!.disabled).toBe(true);
  });

  it('defaults dry-grid choices to the fitted tyres and keeps team orders available', async () => {
    const view = dryGridView();
    const { host, dispatch } = mount(view);
    await nextTick();
    expect(host.textContent).toContain('干地发车也可以主动选择半雨胎或全雨胎');
    expect(host.textContent).toContain('车队指令');
    const confirm = host.querySelector<HTMLButtonElement>('.confirm')!;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await nextTick();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'RESOLVE_RACE_DECISION',
      drivers: expect.arrayContaining(view.weekend!.liveRace!.playerCars.map(car => expect.objectContaining({ driverId: car.driverId, startCompound: car.tyre }))),
      orders: { mode: 'free', favorDriverId: null },
    }));
  });
});
