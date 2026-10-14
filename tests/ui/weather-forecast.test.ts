// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import RaceWeatherForecast from '../../src/ui/panel/components/RaceWeatherForecast.vue';
import RainIntensityGauge from '../../src/ui/panel/components/RainIntensityGauge.vue';
import { intensitySegments, validRange } from '../../src/ui/panel/weatherPresentation';

const mounted: App[] = [];
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

describe('rain intensity presentation', () => {
  it('keeps observed intensity segmented, including partial low rain', () => {
    expect(intensitySegments(0)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(intensitySegments(.05)[0]).toBe(.5);
    expect(intensitySegments(.5).filter(Boolean)).toHaveLength(5);
    expect(intensitySegments(1).every(segment => segment === 1)).toBe(true);

    const host = mount(RainIntensityGauge, { mode: 'observed', value: .05 });
    const gauge = host.querySelector('[role="meter"]')!;
    expect(gauge.getAttribute('aria-valuenow')).toBe('5');
    expect(gauge.getAttribute('aria-valuetext')).toContain('5%');
    expect(host.querySelectorAll('.level-segment')).toHaveLength(10);
  });

  it('renders forecast intensity as a range, not a midpoint or observed meter', () => {
    expect(validRange([.4, .41])).toEqual([40, 41]);
    expect(validRange([1, 1])).toEqual([100, 100]);
    expect(validRange([.7, .2])).toBeNull();

    const host = mount(RainIntensityGauge, { mode: 'forecast', range: [.4, .41], horizonLaps: 6, issuedLap: 12 });
    expect(host.querySelector('[role="meter"]')).toBeNull();
    expect(host.textContent).toContain('40–41%');
    expect(host.querySelector('.range-band')).not.toBeNull();
    expect(host.querySelector('figure')?.getAttribute('aria-label')).toContain('不确定');

    const unavailable = mount(RainIntensityGauge, { mode: 'observed', value: Number.NaN });
    expect(unavailable.textContent).toContain('暂不可用');
    expect(unavailable.querySelector('[role="meter"]')?.getAttribute('aria-valuetext')).not.toContain('null');
  });

  it('separates probability and confidence from the two intensity gauges and clips the arrival window', async () => {
    const host = mount(RaceWeatherForecast, {
      rain: .05,
      surface: 'damp',
      completedLaps: 18,
      totalLaps: 20,
      forecast: { issuedLap: 18, horizonLaps: 6, rainProbability: .8, intensityRange: [.4, .6], arrivalLaps: [1, 5], confidence: .55 },
    });
    await nextTick();
    expect(host.querySelectorAll('.rain-gauge')).toHaveLength(2);
    expect(host.textContent).toContain('降雨概率 80%');
    expect(host.textContent).toContain('预报置信度 55%');
    expect((host.querySelector('.arrival-band') as HTMLElement).style.width).not.toBe('0%');
    expect(host.textContent).not.toContain('每圈强度');
  });
});
