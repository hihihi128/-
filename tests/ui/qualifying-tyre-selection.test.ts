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
  state = act(state, { type: kind === 'qualifying' ? 'RUN_QUALIFYING' : 'RUN_SPRINT_QUALIFYING' });
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
  return [...host.querySelectorAll<HTMLElement>('.card.stack-s')].find(card => card.querySelector('h3')?.textContent === driverName)!;
}

function qualifyingBlock(card: HTMLElement, segment: string): HTMLElement {
  return [...card.querySelectorAll<HTMLElement>('.block.stack-s')].find(block => block.querySelector('.label')?.textContent === `${segment} 实体轮胎组`)!;
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
    ['qualifying', 'Q2', 2],
    ['sprint_qualifying', 'SQ2', 1],
  ] as const)('keeps %s status visible for eliminated and surviving drivers', async (kind, segment, runs) => {
    const { view, survivor, eliminated } = qualifyingView(kind);
    const host = mountWeekend(view);
    await nextTick();

    const survivorName = view.weekend!.drivers.find(driver => driver.driverId === survivor)!.driverName;
    const eliminatedName = view.weekend!.drivers.find(driver => driver.driverId === eliminated)!.driverName;
    const survivorCard = driverCard(host, survivorName);
    const eliminatedCard = driverCard(host, eliminatedName);
    const survivorQualifying = qualifyingBlock(survivorCard, segment);
    const eliminatedQualifying = qualifyingBlock(eliminatedCard, segment);

    expect(survivorQualifying.querySelectorAll('select')).toHaveLength(runs);
    expect(eliminatedQualifying.textContent).toContain('该车手已在本次排位中被淘汰');
    expect(eliminatedQualifying.querySelectorAll('select')).toHaveLength(0);
  });
});
