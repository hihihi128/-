// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import CarTopdown from '../../src/ui/panel/components/CarTopdown.vue';
import MobileTabBar from '../../src/ui/panel/components/MobileTabBar.vue';
import TimingTower from '../../src/ui/panel/components/TimingTower.vue';

const mounted: Array<ReturnType<typeof createApp>> = [];

function mount(component: Parameters<typeof createApp>[0], props: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(component, props);
  mounted.push(app);
  app.mount(host);
  return host;
}

afterEach(() => {
  mounted.splice(0).forEach(app => app.unmount());
  document.body.replaceChildren();
});

describe('转播界面组件', () => {
  it('赛车俯视图显示公开值、锁定状态，并从热点选择零件', async () => {
    let selected = '';
    const host = mount(CarTopdown, {
      parts: [
        { type: 'front_wing', name: '前翼', specId: 'fw1', version: 1, perf: 82, rel: 90, verified: true, expected: null },
        { type: 'floor', name: '底板', specId: 'fl1', version: 2, perf: 78, rel: 88, verified: false, expected: [76, 80] },
        { type: 'ice', name: '内燃机', specId: 'pu1', version: 1, perf: 91, rel: 86, verified: true, expected: null },
      ],
      projects: [{ partType: 'floor' }],
      selected: 'front_wing',
      lockedParts: ['ice'],
      onSelect: (partType: string) => { selected = partType; },
    });

    expect(host.querySelector('#val-front_wing')?.textContent).toBe('82.0');
    expect(host.querySelector('#val-floor')?.textContent).toBe('76~80');
    expect(host.querySelector('#val-ice')?.textContent).toBe('锁定');
    expect(host.querySelector('#part-front_wing')?.classList.contains('is-selected')).toBe(true);
    expect(host.querySelector('#label-floor')?.classList.contains('is-rnd')).toBe(true);
    expect(host.querySelector('#part-ice')?.getAttribute('tabindex')).toBe('-1');
    expect(host.querySelector('#label-ice')?.classList.contains('perf-locked')).toBe(true);

    host.querySelector('#part-floor')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(selected).toBe('floor');
  });

  it('手机标签栏发送所选页面并正确标记更多页面', async () => {
    let selected = '';
    const host = mount(MobileTabBar, {
      tab: 'standings',
      onSelect: (tab: string) => { selected = tab; },
    });
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(6);
    expect(buttons[5].classList.contains('on')).toBe(true);
    buttons[1].click();
    await nextTick();
    expect(selected).toBe('weekend');
  });

  it('完赛排名塔显示短名、轮胎和状态，并由遮罩关闭', async () => {
    const host = mount(TimingTower, {
      view: {
        season: { roundIndex: 1 },
        player: { team: { id: 'ferrari' } },
        teams: [{ id: 'ferrari', short: 'FER', name: '法拉利', color: '#e10600' }],
        drivers: [{ id: 'leclerc', short: 'LEC', name: '夏尔·勒克莱尔', teamColor: '#e10600', isPlayerTeam: true }],
        standings: {
          drivers: [{ pos: 1, driverId: 'leclerc', name: '夏尔·勒克莱尔', color: '#e10600', points: 25 }],
          teams: [{ pos: 1, teamId: 'ferrari', name: '法拉利', color: '#e10600', points: 25 }],
        },
        weekend: {
          isCurrent: true,
          sprint: null,
          race: {
            kind: 'race',
            laps: 57,
            fastestLap: { driverId: 'leclerc' },
            classification: [{ driverId: 'leclerc', pos: 1, status: 'finished', gap: '', pits: 1, tyres: ['M'] }],
          },
        },
        labels: { tyres: { M: { short: 'M' } } },
      },
    });

    expect(host.textContent).toContain('完赛');
    expect(host.textContent).toContain('LEADER');
    expect(host.textContent).toContain('LEC');
    expect(host.textContent).toContain('M');
    expect(host.textContent).not.toContain('LIVE');

    host.querySelector<HTMLElement>('.tower-strip')?.click();
    await nextTick();
    expect(host.querySelector('.tower-open')).not.toBeNull();
    const backdrop = host.querySelector<HTMLElement>('.tower-backdrop');
    expect(backdrop).not.toBeNull();
    backdrop?.click();
    await nextTick();
    expect(host.querySelector('.tower-open')).toBeNull();
    expect(host.querySelector('.tower-backdrop')).toBeNull();
  });

  it('实时比赛时计时塔优先显示公开实时顺序，不混用完赛分类', () => {
    const host = mount(TimingTower, {
      view: {
        season: { roundIndex: 1 },
        player: { team: { id: 'ferrari' } },
        teams: [{ id: 'ferrari', short: 'FER', name: '法拉利', color: '#e10600' }],
        drivers: [{ id: 'leclerc', short: 'LEC', name: '夏尔·勒克莱尔', teamColor: '#e10600', isPlayerTeam: true }],
        standings: { drivers: [{ pos: 3, driverId: 'leclerc', name: '夏尔·勒克莱尔', color: '#e10600', points: 15 }], teams: [] },
        weekend: {
          isCurrent: true,
          race: { kind: 'race', laps: 57, fastestLap: null, classification: [{ driverId: 'leclerc', pos: 3, status: 'finished', gap: '+5.0', pits: 1, tyres: ['M'] }] },
          sprint: null,
          liveRace: { kind: 'race', completedLaps: 12, totalLaps: 57, timing: [{ driverId: 'leclerc', pos: 1, status: 'running', gap: '领跑', tyre: 'I', pits: 0 }] },
        },
        labels: { tyres: { I: { short: 'I' }, M: { short: 'M' } } },
      },
    });

    expect(host.textContent).toContain('LIVE · L12/57');
    expect(host.textContent).toContain('领跑');
    expect(host.textContent).toContain('I');
    expect(host.textContent).not.toContain('完赛顺序来自已完成的比赛模拟');
  });
});
