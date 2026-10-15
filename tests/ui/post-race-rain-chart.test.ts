// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from 'vue';
import RainHistoryChart from '../../src/ui/panel/components/RainHistoryChart.vue';

const mounted: App[] = [];
function mount(history: number[]) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(RainHistoryChart, { history });
  mounted.push(app);
  app.mount(host);
  return host;
}

afterEach(() => {
  mounted.splice(0).forEach(app => app.unmount());
  document.body.replaceChildren();
});

describe('post-race rain chart', () => {
  it('shows lap-by-lap rainfall and a useful review summary', () => {
    const host = mount([0, .1, .45, .8, .3, 0]);
    expect(host.textContent).toContain('比赛降雨复盘');
    expect(host.textContent).toContain('共 4 圈有明显降雨');
    expect(host.textContent).toContain('峰值 80%');
    expect(host.textContent).toContain('第 4 圈');
    expect(host.querySelector('.rain-line')?.getAttribute('d')).toContain('L');
    expect(host.querySelector('figure')?.getAttribute('aria-label')).toContain('峰值 80%');
  });

  it('keeps a dry race visible as a flat review chart', () => {
    const host = mount([0, 0, 0]);
    expect(host.textContent).toContain('全程无明显降雨');
    expect(host.textContent).toContain('第 3 圈');
  });
});
