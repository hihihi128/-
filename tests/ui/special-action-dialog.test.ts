// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SpecialActionDialog from '../../src/ui/panel/components/SpecialActionDialog.vue';
import { store } from '../../src/ui/panel/bridge';

const mounted: App[] = [];

function mount(api: Record<string, unknown>) {
  store.status = { revisionId: 'rev-1', generating: false } as never;
  store.view = null;
  store.negotiation = null;
  const host = document.createElement('div');
  document.body.append(host);
  const onClose = vi.fn();
  (window as any).F1Manager = {
    status: () => store.status,
    view: () => store.view,
    getSpecialNegotiation: () => null,
    ...api,
  };
  const app = createApp(SpecialActionDialog, {
    action: { type: 'FIA_DEBATE', stance: 'support' },
    title: '支持 FIA 议题',
    subject: '涡轮起压时间',
    hint: '必须遵守当前会议的强制立场。',
    expectedRevisionId: 'rev-1',
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

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text);
  if (!found) throw new Error(`missing button ${text}`);
  return found;
}

afterEach(() => {
  mounted.splice(0).forEach(app => app.unmount());
  document.body.replaceChildren();
  delete (window as any).F1Manager;
  store.status = null;
  store.view = null;
  store.negotiation = null;
  store.busy = false;
});

describe('special action dialog', () => {
  it('opens without executing and sends trimmed context only after explicit confirmation', async () => {
    const executeSpecialAction = vi.fn(async request => ({ ok: true, message: '动作已执行', requestId: request.requestId, actionApplied: true, narrationStatus: 'not_requested' }));
    const host = mount({ executeSpecialAction, retrySpecialActionNarration: vi.fn() });
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;

    expect(executeSpecialAction).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(host.textContent).toContain('对象：');
    expect(host.textContent).toContain('涡轮起压时间');
    textarea.value = '  以安全为先说明立场  ';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(button(host, '执行并叙述')).toBeTruthy();
    button(host, '执行并叙述').click();
    await flush();

    expect(executeSpecialAction).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'FIA_DEBATE', stance: 'support' },
      contextText: '以安全为先说明立场',
      expectedRevisionId: 'rev-1',
    }));
    expect(host.textContent).toContain('动作已执行');
  });

  it('retains the draft when action execution fails and rejects text over 1000 characters', async () => {
    const executeSpecialAction = vi.fn(async request => ({ ok: false, message: '本周已经表态', requestId: request.requestId, actionApplied: false, narrationStatus: 'not_requested' }));
    const host = mount({ executeSpecialAction, retrySpecialActionNarration: vi.fn() });
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'x'.repeat(1001);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(button(host, '执行并叙述').disabled).toBe(true);
    expect(host.textContent).toContain('1001/1000');

    textarea.value = '保留这段话';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    button(host, '执行并叙述').click();
    await flush();
    expect(host.textContent).toContain('本周已经表态');
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('保留这段话');
    expect(host.querySelector('textarea')?.getAttribute('aria-describedby')).toContain('special-action-input-error');
    button(host, '执行并叙述').click();
    await flush();
    expect(executeSpecialAction).toHaveBeenCalledTimes(2);
    expect(executeSpecialAction.mock.calls[1][0]).toMatchObject({ expectedRevisionId: 'rev-1' });
    expect(executeSpecialAction.mock.calls[1][0].requestId).toBe(executeSpecialAction.mock.calls[0][0].requestId);
  });

  it('freezes the opening revision, turns idle and action errors stale, and permits exactly 1000 trimmed characters', async () => {
    const executeSpecialAction = vi.fn(async request => ({ ok: false, message: '暂不可执行', requestId: request.requestId, actionApplied: false, narrationStatus: 'not_requested' }));
    const host = mount({ executeSpecialAction, retrySpecialActionNarration: vi.fn() });
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = `  ${'x'.repeat(1000)}  `;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(host.textContent).toContain('1000/1000');
    expect(button(host, '执行并叙述').disabled).toBe(false);
    button(host, '执行并叙述').click();
    await flush();
    expect(executeSpecialAction).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevisionId: 'rev-1', contextText: 'x'.repeat(1000) }));

    store.status = { revisionId: 'rev-2', generating: false } as never;
    await flush();
    expect(host.textContent).toContain('当前状态已变化');
    expect([...host.querySelectorAll('button')].some(item => item.textContent?.trim() === '执行并叙述')).toBe(false);
  });

  it('reconciles a bridge exception by its stable request id instead of blindly resubmitting', async () => {
    let requestId = '';
    const executeSpecialAction = vi.fn(async request => {
      requestId = request.requestId;
      throw new Error('bridge disconnected');
    });
    const host = mount({
      executeSpecialAction,
      retrySpecialActionNarration: vi.fn(),
      status: () => ({ revisionId: 'rev-2', generating: false, specialAction: { requestId, message: '动作已执行', actionApplied: true, actionRevisionId: 'rev-2', narrationStatus: 'not_requested' } }),
    });
    button(host, '直接执行').click();
    await flush();
    expect(executeSpecialAction).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('动作已执行');
    expect([...host.querySelectorAll('button')].some(item => item.textContent?.trim() === '直接执行')).toBe(false);
  });

  it('locks dismiss controls during submission and only retries narration after an applied action fails', async () => {
    let resolveAction!: (value: any) => void;
    const executeSpecialAction = vi.fn(() => new Promise(resolve => { resolveAction = resolve; }));
    const retrySpecialActionNarration = vi.fn(async request => ({ ok: true, message: '叙述完成', requestId: request.requestId, actionApplied: true, narrationStatus: 'completed' }));
    const host = mount({ executeSpecialAction, retrySpecialActionNarration });
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = '请如实叙述';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    button(host, '执行并叙述').click();
    await flush();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(host.textContent).toContain('正在执行既定动作');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="关闭特殊动作确认"]')?.disabled).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    host.querySelector<HTMLElement>('.special-action-backdrop')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.onClose).not.toHaveBeenCalled();

    resolveAction({ ok: false, message: '动作已执行，叙述未完成', requestId: 'special-1', actionApplied: true, actionRevisionId: 'rev-2', narrationStatus: 'failed' });
    await flush();
    expect(host.textContent).toContain('动作已执行，无法重新执行');
    expect([...host.querySelectorAll('button')].some(item => item.textContent?.includes('执行并叙述'))).toBe(false);
    button(host, '仅重试叙述').click();
    await flush();
    expect(retrySpecialActionNarration).toHaveBeenCalledWith({ requestId: 'special-1', expectedRevisionId: 'rev-2' });
    expect(host.textContent).toContain('叙述完成');
  });

  it('uses Escape as cancellation and keeps existing input panels outside the new flow', async () => {
    const host = mount({ executeSpecialAction: vi.fn(), retrySpecialActionNarration: vi.fn() });
    host.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(host.onClose).toHaveBeenCalledOnce();

    const overview = readFileSync(resolve(process.cwd(), 'src/ui/panel/views/Overview.vue'), 'utf8');
    for (const action of ['START_MCLAREN_FIX', 'MERCEDES_POLITICS', 'RED_BULL_RETAIN_GP', 'ASTON_CRISIS', 'RACING_BULLS_SELECT_RESERVE', 'AUDI_ALLIANCE', 'ALPINE_MANAGEMENT', 'HAAS_BALANCE', 'WILLIAMS_BUDGET_FOCUS']) {
      expect(overview).toContain(`openSpecialAction({ type: '${action}'`);
    }
    expect(overview).toContain('<RandomEventPanel mode="card" />');
    expect(overview).toContain('<NegotiationPanel kind="fia_roundtable" :preferred-choice="fiaChoice" />');
    expect(overview).toContain("@click=\"fiaChoice = 'support'\"");
    expect(overview).not.toContain("openSpecialAction({ type: 'FIA_DEBATE'");
    expect(overview).toContain(':fallback-focus="overviewRoot"');
    expect(overview).not.toMatch(/@click="act\(\{ type: '(?:START_MCLAREN_FIX|MERCEDES_POLITICS|RED_BULL_RETAIN_GP|ASTON_CRISIS|RACING_BULLS_SELECT_RESERVE|AUDI_ALLIANCE|ALPINE_MANAGEMENT|HAAS_BALANCE|WILLIAMS_BUDGET_FOCUS|FIA_DEBATE)/);
  });

  it('moves focus to dialog status after submit and offers a close path while narrating', async () => {
    const host = mount({ executeSpecialAction: vi.fn(async request => ({ ok: true, message: '叙述已开始', requestId: request.requestId, actionApplied: true, actionRevisionId: 'rev-2', narrationStatus: 'pending' })), retrySpecialActionNarration: vi.fn() });
    button(host, '直接执行').click();
    await flush();
    expect(document.activeElement).toBe(host.querySelector('[data-special-action-status]'));
    expect(button(host, '关闭')).toBeTruthy();
    button(host, '关闭').click();
    expect(host.onClose).toHaveBeenCalledOnce();
  });
});
