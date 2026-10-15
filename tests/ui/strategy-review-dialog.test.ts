// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  const onClose = vi.fn();
  const app = createApp(StrategyReviewDialog, {
    driverId: 'd1', driverName: '测试车手', plan, expectedRevisionId: 'rev-1', raceLaps: 57, canReview,
    onClose,
  });
  mounted.push(app);
  app.mount(host);
  return Object.assign(host, { onClose });
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
    expect(host.onClose).not.toHaveBeenCalled();
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].some(button => button.textContent === '确认并关闭')).toBe(true);

    [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '确认并关闭')!.click();
    await flush();
    expect(host.onClose).toHaveBeenCalledOnce();
  });

  it('does not dismiss by any path while applying, then shows confirmation', async () => {
    let resolveApply!: (result: { ok: boolean; message: string }) => void;
    const applyStrategyReview = vi.fn(() => new Promise<{ ok: boolean; message: string }>(resolve => { resolveApply = resolve; }));
    const discardStrategyReview = vi.fn(async () => ({ ok: true, message: '已保留' }));
    const host = mount({
      requestStrategyReview: vi.fn(async () => ({
        ok: true, message: '发现问题', reviewId: 'review-applying', api: 'secondary', originalPlan: plan,
        review: { verdict: 'changes_recommended', summary: '首段过长', issues: [], correctedPlan: { ...plan, tyrePlan: ['soft', 'hard'] } },
      })),
      applyStrategyReview, discardStrategyReview,
    });
    (host.querySelector('button.primary') as HTMLButtonElement).click();
    await flush();
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '使用更正策略')!.click();
    await flush();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const closeButton = host.querySelector<HTMLButtonElement>('[aria-label="关闭策略点评并保留原策略"]')!;
    expect(host.textContent).toContain('正在提交，请勿关闭此窗口');
    expect(closeButton.disabled).toBe(true);
    host.querySelector<HTMLElement>('.strategy-review-backdrop')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    closeButton.click();
    await flush();
    expect(host.onClose).not.toHaveBeenCalled();
    expect(discardStrategyReview).not.toHaveBeenCalled();

    resolveApply({ ok: true, message: '已应用副 API 更正的工程师策略' });
    await flush();
    expect(host.textContent).toContain('更正已应用，请确认后关闭');
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].some(button => button.textContent === '确认并关闭')).toBe(true);
  });

  it('cycles Shift+Tab from the dialog container to its final control', async () => {
    const host = mount({ requestStrategyReview: vi.fn(), applyStrategyReview: vi.fn(), discardStrategyReview: vi.fn() });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const finalControl = host.querySelector<HTMLButtonElement>('button.primary')!;
    dialog.focus();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(finalControl);
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
    expect(failure.textContent).toContain('连接/API 设置中配置副 API 的代理、URL 和密钥');
    expect([...failure.querySelectorAll('button')].some(button => button.textContent === '重试点评')).toBe(true);
  });

  it('explains why a non-engineer strategy cannot be reviewed', async () => {
    const host = mount({ requestStrategyReview: vi.fn(), applyStrategyReview: vi.fn(), discardStrategyReview: vi.fn() }, false);
    expect(host.textContent).toContain('请先使用“听工程师”');
    expect((host.querySelector('button.primary') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders one perfect-strategy entry and restores current secondary-review provenance', () => {
    const weekend = readFileSync(resolve(process.cwd(), 'src/ui/panel/views/Weekend.vue'), 'utf8');
    expect(weekend).toContain('v-if="d.plan.strategySource === \'engineer\'" class="small review-entry"');
    expect(weekend).toContain('v-if="d.plan.strategySource === \'perfect\'" class="engineer-actions"');
    expect((weekend.match(/d\.plan\.strategySource === 'perfect'.{0,240}策略点评/s) ?? []).length).toBe(1);
    expect(weekend).toContain("function currentStrategyReview(d: WeekendDriverView): DriverPlan['strategyReview'] | null");
    expect(weekend).toContain('副 API 点评更正');
  });
});
