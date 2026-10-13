// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';
import { dispatch } from '../../src/engine/actions';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { buildStatePrompt } from '../../src/engine/prompt';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { store } from '../../src/ui/panel/bridge';
import Overview from '../../src/ui/panel/views/Overview.vue';
import { cardSources } from '../helpers';

function game(): GameState {
  const loaded = normalizeDatabase(cardSources());
  if (!loaded.db) throw new Error('card database failed to load');
  return createGame(loaded.db, { playerTeamId: 'williams', principalName: '测试领队', seed: 123, gameId: 'williams-stale-focus', now: 1 });
}

afterEach(() => {
  store.view = null;
  document.body.replaceChildren();
});

describe('威廉姆斯本站预算方向', () => {
  it('跨站后不会向提示词或总览泄漏上一站的预算方向', async () => {
    let state = game();
    const focused = dispatch(state, { type: 'WILLIAMS_BUDGET_FOCUS', focus: 'facilities' }, { now: 1 });
    expect(focused.ok).toBe(true);
    state = focused.state;
    expect(state.williams!.focusRound).toBe(`${state.season.number}-${state.season.roundIndex}`);

    state.season.roundIndex += 1;
    const prompt = buildStatePrompt(state);
    expect(prompt).toContain('本站预算方向 尚未决定');
    expect(prompt).not.toContain('本站预算方向 设施');

    store.view = buildView(state);
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(Overview);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain('本站方向：尚未决定');
    expect(host.textContent).not.toContain('本站方向：设施更新');
    app.unmount();
  });
});
