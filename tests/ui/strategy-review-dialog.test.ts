// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import type { DriverPlan } from '../../src/engine/types';
import { store } from '../../src/ui/panel/bridge';
import StrategyReviewDialog from '../../src/ui/panel/components/StrategyReviewDialog.vue';

const mounted: App[] = [];
const plan: DriverPlan = {
  practiceProgram: 'setup',
  qualiApproach: 'standard',
  strategySource: 'engineer',
  tyrePlan: ['medium', 'hard'],
  paceMode: 'balanced',
  pitTiming: 'standard',
  scReaction: true,
  sprintTyre: 'auto',
};

function mount(api: Record<string, unknown>, canReview = true) {
  store.connected = true;
  store.status = { revisionId: 'rev-1', generating: false, settings: { engineerApi: 'main' } } as never;
  store.view = null;
  store.busy = false;
  (window as any).F1Manager = {
    status: () => store.status,
    view: () => null,
    getSpecialNegotiation: () => null,
    ...api,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(StrategyReviewDialog, {
    driverId: 'd1', driverName: '测试车手', plan, expectedRevisionId: 'rev-1', raceLaps: 57, canReview,
  });
  mounted.push(app);
  app.mount(host);
  return host;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await nextTick();
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

describe('strategy review dialog', () => {
  it('uses only the review API and applies a correction after explicit confirmation', async () => {
    const requestStrategyReview = vi.fn(async () => ({
      ok: true, message: '发现问题', reviewId: 'review-1', api: 'secondary', originalPlan: plan,
      review: { verdict: 'changes_recommended', summary: '首段过长', issues: [{ severity: 'warning', message: '胎耗过高' }], correctedPlan: { ...plan, tyrePlan: ['soft', 'hard'], paceMode: 'conserve' } },
      originalPrediction: { cost: 5100, pitLaps: [24] }, correctedPrediction: { cost: 5090, pitLaps: [18] },
    }));
    const applyStrategyReview = vi.fn(async () => ({ ok: true, message: '已应用' }));
    const discardStrategyReview = vi.fn(async () => ({ ok: true, message: '已保留' }));
    const host = mount({ requestStrategyReview, applyStrategyReview, discardStrategyReview });

    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    (host.querySelector('button.primary') as HTMLButtonElement).click();
    await flush();

    expect(requestStrategyReview).toHaveBeenCalledWith({ driverId: 'd1', expectedRevisionId: 'rev-1' });
    expect(host.textContent).toContain('固定使用副 API');
    expect(host.textContent).toContain('首段过长');
    expect(host.textContent).toContain('使用更正策略');
    const apply = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '使用更正策略')!;
    apply.click();
    await flush();

    expect(applyStrategyReview).toHaveBeenCalledWith({ reviewId: 'review-1', expectedRevisionId: 'rev-1' });
    expect(discardStrategyReview).not.toHaveBeenCalled();
    expect(host.textContent).toContain('已应用');
  });

  it('keeps the original plan on close or retryable failure', async () => {
    const discardStrategyReview = vi.fn(async () => ({ ok: true, message: '已保留' }));
    const requestStrategyReview = vi.fn(async () => ({ ok: true, message: '无须更正', reviewId: 'review-2', review: { verdict: 'sound', summary: '策略合理' } }));
    const host = mount({ requestStrategyReview, applyStrategyReview: vi.fn(), discardStrategyReview });
    (host.querySelector('button.primary') as HTMLButtonElement).click();
    await flush();
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();

    expect(discardStrategyReview).toHaveBeenCalledWith({ reviewId: 'review-2' });
    expect(host.textContent).toContain('策略合理');

    const failure = mount({ requestStrategyReview: vi.fn(async () => ({ ok: false, message: '副 API 未配置' })), applyStrategyReview: vi.fn(), discardStrategyReview: vi.fn() });
    (failure.querySelector('button.primary') as HTMLButtonElement).click();
    await flush();
    expect(failure.textContent).toContain('当前策略未改变');
    expect([...failure.querySelectorAll('button')].some(button => button.textContent === '重试点评')).toBe(true);
  });

  it('explains why a non-engineer strategy cannot be reviewed', async () => {
    const host = mount({ requestStrategyReview: vi.fn(), applyStrategyReview: vi.fn(), discardStrategyReview: vi.fn() }, false);
    expect(host.textContent).toContain('请先使用“听工程师”');
    expect((host.querySelector('button.primary') as HTMLButtonElement).disabled).toBe(true);
  });
});
