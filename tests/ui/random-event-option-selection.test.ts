// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import RandomEventPanel from '../../src/ui/panel/components/RandomEventPanel.vue';
import { store } from '../../src/ui/panel/bridge';

const mounted: App[] = [];

afterEach(() => {
  for (const app of mounted) app.unmount();
  mounted.length = 0;
  document.body.innerHTML = '';
  store.randomEventOpen = false;
  store.view = null;
  store.status = null;
  delete (window as any).F1Manager;
});

describe('随机事件预设选项', () => {
  it('只高亮最后选择的选项并同步输入框', async () => {
    store.status = { revisionId: 'rev-1', generating: false, settings: { engineerProxyPreset: 'fixture' } } as never;
    store.view = {
      randomEvents: {
        current: {
          id: 'event-1', kind: 'driver_injury', category: 'problem', status: 'awaiting_player', title: '测试事件', detail: '测试', prompt: '选择方案',
          answerOptions: ['方案 A', '方案 B'], playerAnswer: null, mainReply: null, outcomeSummary: null, effects: [], generationError: null,
          totalDialogueTurns: 2, completedDialogueTurns: 0, dialogue: [], roundKey: 'test',
        },
      },
    } as never;
    (window as any).F1Manager = { status: () => store.status, view: () => store.view, getSpecialNegotiation: () => null };
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(RandomEventPanel, { mode: 'modal' });
    mounted.push(app);
    app.mount(host);
    await nextTick();

    const options = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.startsWith('方案'));
    options[0].click();
    await nextTick();
    expect(options[0].classList.contains('selected')).toBe(true);
    expect(options[0].getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('方案 A');

    options[1].click();
    await nextTick();
    expect(options[0].classList.contains('selected')).toBe(false);
    expect(options[0].getAttribute('aria-pressed')).toBe('false');
    expect(options[1].classList.contains('selected')).toBe(true);
    expect(options[1].getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('方案 B');
  });
});
