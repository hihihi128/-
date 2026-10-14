<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { DriverPlan } from '../../../engine/types';
import { call } from '../bridge';

interface ReviewIssue {
  code?: string;
  severity?: 'info' | 'warning' | 'error';
  message?: string;
}

interface ReviewPayload {
  verdict?: 'sound' | 'changes_recommended';
  summary?: string;
  issues?: ReviewIssue[];
  correctedPlan?: Partial<DriverPlan> | null;
}

interface ReviewResult {
  ok: boolean;
  message: string;
  reviewId?: string;
  api?: 'secondary';
  originalPlan?: Partial<DriverPlan>;
  review?: ReviewPayload;
  originalPrediction?: Record<string, unknown> | null;
  correctedPrediction?: Record<string, unknown> | null;
}

interface ReviewApi {
  requestStrategyReview(request: { driverId: string; expectedRevisionId?: string }): Promise<ReviewResult>;
  applyStrategyReview(request: { reviewId: string; expectedRevisionId?: string }): Promise<{ ok: boolean; message: string }>;
  discardStrategyReview(request: { reviewId: string }): Promise<{ ok: boolean; message: string }>;
}

const props = defineProps<{
  driverId: string;
  driverName: string;
  plan: DriverPlan;
  expectedRevisionId?: string | null;
  raceLaps?: number;
  canReview: boolean;
  unavailableReason?: string;
}>();

const emit = defineEmits<{ close: []; applied: [] }>();

type ReviewState = 'idle' | 'loading' | 'sound' | 'changes' | 'error' | 'stale' | 'applying' | 'applied' | 'kept';
const state = ref<ReviewState>('idle');
const result = ref<ReviewResult | null>(null);
const closed = ref(false);
const dialog = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);

const review = computed(() => result.value?.review ?? null);
const originalPlan = computed(() => result.value?.originalPlan ?? props.plan);
const correctedPlan = computed(() => review.value?.correctedPlan ?? null);
const issues = computed(() => review.value?.issues ?? []);
const canApply = computed(() => state.value === 'changes' && !!result.value?.reviewId && !!correctedPlan.value);
const statusMessage = computed(() => {
  if (state.value === 'idle' && !props.canReview) return props.unavailableReason ?? '请先使用“听工程师”生成当前工程师策略。';
  if (state.value === 'loading') return '正在通过副 API 检查当前工程师方案…';
  if (state.value === 'sound') return review.value?.summary ?? '方案通过检查，当前策略不需要更正。';
  if (state.value === 'changes') return review.value?.summary ?? '发现可更正的策略问题。';
  if (state.value === 'stale') return result.value?.message ?? '点评已过期，当前策略未改变。请重新请求点评。';
  if (state.value === 'applying') return '正在应用已校验的更正策略…';
  if (state.value === 'applied') return result.value?.message ?? '更正策略已应用。';
  if (state.value === 'kept') return '已保留原策略，当前策略未改变。';
  return result.value?.message ?? '请求失败，当前策略未改变。';
});

function apiCall<T>(fn: (api: ReviewApi) => T | Promise<T>): Promise<T | null> {
  return call(api => fn(api as unknown as ReviewApi), false);
}

function planText(plan: Partial<DriverPlan> | null | undefined): string {
  if (!plan) return '—';
  const tyres = Array.isArray(plan.tyrePlan) && plan.tyrePlan.length ? plan.tyrePlan.join(' → ') : '轮胎方案未提供';
  const pace = ({ conserve: '保守', balanced: '均衡', push: '进攻' } as Record<string, string>)[plan.paceMode ?? ''] ?? plan.paceMode ?? '—';
  const pit = ({ early: '提前', standard: '按计划', late: '推迟' } as Record<string, string>)[plan.pitTiming ?? ''] ?? plan.pitTiming ?? '—';
  return `${tyres} · ${pace} · ${pit} · 安全车${plan.scReaction ? '响应' : '不响应'}`;
}

function predictionText(prediction: Record<string, unknown> | null | undefined): string {
  if (!prediction) return '本地预测暂不可用';
  const cost = typeof prediction.cost === 'number' ? `${prediction.cost.toFixed(1)}s` : null;
  const delta = typeof prediction.delta === 'number' ? `${prediction.delta > 0 ? '+' : ''}${prediction.delta.toFixed(1)}s` : null;
  const stints = Array.isArray(prediction.stints) ? `预计分段 ${prediction.stints.join(' / ')} 圈` : null;
  const stops = typeof prediction.stops === 'number' ? `${prediction.stops} 停` : null;
  return [cost, delta, stints, stops].filter(Boolean).join(' · ') || '本地预测已重算';
}

async function discardPending(): Promise<void> {
  const reviewId = result.value?.reviewId;
  if (!reviewId) return;
  await apiCall(api => api.discardStrategyReview({ reviewId }));
}

async function requestReview(): Promise<void> {
  if (!props.canReview) {
    state.value = 'error';
    result.value = { ok: false, message: props.unavailableReason ?? '请先使用“听工程师”生成当前工程师策略。' };
    return;
  }
  closed.value = false;
  state.value = 'loading';
  result.value = null;
  const response = await apiCall(api => api.requestStrategyReview({ driverId: props.driverId, expectedRevisionId: props.expectedRevisionId ?? undefined }));
  if (closed.value) {
    if (response?.reviewId) await apiCall(api => api.discardStrategyReview({ reviewId: response.reviewId! }));
    return;
  }
  if (!response) {
    state.value = 'error';
    result.value = { ok: false, message: '点评请求未返回结果，当前策略未改变。请重试。' };
    return;
  }
  result.value = response;
  if (!response.ok) {
    state.value = /过期|已变化|stale/i.test(response.message) ? 'stale' : 'error';
    return;
  }
  state.value = response.review?.verdict === 'changes_recommended' && response.review?.correctedPlan ? 'changes' : 'sound';
}

async function applyReview(): Promise<void> {
  const reviewId = result.value?.reviewId;
  if (!reviewId || !canApply.value) return;
  state.value = 'applying';
  const response = await apiCall(api => api.applyStrategyReview({ reviewId, expectedRevisionId: props.expectedRevisionId ?? undefined }));
  if (!response) {
    state.value = 'error';
    result.value = { ...(result.value ?? { ok: false, message: '' }), ok: false, message: '应用更正策略失败，当前策略未改变。请重试。' };
    return;
  }
  result.value = { ...(result.value ?? { ok: false, message: '' }), ...response };
  if (!response.ok) {
    state.value = /过期|已变化|stale/i.test(response.message) ? 'stale' : 'error';
    return;
  }
  state.value = 'applied';
  emit('applied');
}

async function keepOriginal(): Promise<void> {
  if (state.value === 'loading' || state.value === 'applying') return;
  await discardPending();
  state.value = 'kept';
}

async function close(): Promise<void> {
  closed.value = true;
  if (state.value !== 'applied') await discardPending();
  emit('close');
}

function trapFocus(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    void close();
    return;
  }
  if (event.key !== 'Tab' || !dialog.value) return;
  const focusable = Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  await nextTick();
  closeButton.value?.focus();
});
onUnmounted(() => { closed.value = true; });
</script>

<template>
  <div class="strategy-review-backdrop" @click.self="close">
    <section ref="dialog" class="strategy-review-dialog" role="dialog" aria-modal="true" aria-labelledby="strategy-review-title" aria-describedby="strategy-review-description" tabindex="-1" @keydown="trapFocus">
      <header class="strategy-review-head">
        <div>
          <div class="row"><h2 id="strategy-review-title">策略点评</h2><span class="badge">固定使用副 API</span></div>
          <p id="strategy-review-description" class="small muted">检查当前工程师方案；只有你明确确认后才会更正策略。</p>
        </div>
        <button ref="closeButton" class="small ghost strategy-review-close" aria-label="关闭策略点评并保留原策略" @click="close">✕</button>
      </header>

      <div class="strategy-review-body">
        <div class="strategy-review-context spread">
          <div><b>{{ driverName }}</b><div class="tiny muted">正赛 {{ raceLaps ?? '—' }} 圈 · 当前工程师策略</div></div>
          <span class="badge">赛前</span>
        </div>

        <section class="strategy-review-plan">
          <div class="small muted">当前工程师方案</div>
          <b>{{ planText(originalPlan) }}</b>
          <div class="tiny muted">本地预测：{{ predictionText(result?.originalPrediction) }}</div>
        </section>

        <section v-if="state === 'idle'" class="notice strategy-review-notice">
          <b>准备检查</b><div class="small">点评固定使用已配置的副 API，不会自动应用任何方案。</div>
          <div v-if="!canReview" class="tiny neg">{{ unavailableReason ?? '请先使用“听工程师”生成当前工程师策略。' }}</div>
        </section>
        <section v-else-if="state === 'loading' || state === 'applying'" class="notice strategy-review-notice" aria-live="polite"><b>{{ statusMessage }}</b><div class="tiny muted">请勿重复提交，当前策略保持不变。</div></section>
        <section v-else-if="state === 'sound' || state === 'applied' || state === 'kept'" class="notice ok strategy-review-notice" aria-live="polite"><b>{{ statusMessage }}</b><div class="tiny">{{ state === 'sound' ? '副 API 未建议更改，当前工程师策略保持不变。' : state === 'applied' ? '只修改了该车手的正赛策略。' : '未提交任何策略改动。' }}</div></section>
        <section v-else-if="state === 'error' || state === 'stale'" class="notice bad strategy-review-notice" role="alert"><b>{{ statusMessage }}</b><div class="tiny">当前策略未改变。</div></section>

        <section v-if="state === 'changes' || state === 'applied'" class="strategy-review-results">
          <div class="spread"><h3>点评结论</h3><span class="badge warn">{{ issues.length }} 个问题</span></div>
          <p class="small">{{ review?.summary }}</p>
          <ul v-if="issues.length" class="strategy-review-issues"><li v-for="(issue, index) in issues" :key="index"><b>{{ issue.severity === 'error' ? '严重：' : issue.severity === 'warning' ? '注意：' : '' }}</b>{{ issue.message ?? issue.code ?? '未提供说明' }}</li></ul>
          <div class="strategy-review-compare">
            <div class="strategy-review-plan"><div class="small muted">原方案 · 当前使用</div><b>{{ planText(originalPlan) }}</b><div class="tiny muted">预测：{{ predictionText(result?.originalPrediction) }}</div></div>
            <div class="strategy-review-plan corrected"><div class="small">更正方案 · 已通过合法性校验</div><b>{{ planText(correctedPlan) }}</b><div class="tiny muted">预测：{{ predictionText(result?.correctedPrediction) }}</div></div>
          </div>
        </section>

        <p class="tiny muted strategy-review-source">点评来源：副 API · 当前工程师方案、本站练习与赛道数据。预测不保证比赛结果。</p>
      </div>

      <footer class="strategy-review-foot">
        <span class="tiny muted">{{ state === 'changes' ? `仅修改 ${driverName} 的正赛策略` : '关闭等同保留原策略' }}</span>
        <button v-if="state === 'idle'" class="primary" :disabled="!canReview" @click="requestReview">开始点评</button>
        <button v-else-if="state === 'error' || state === 'stale'" class="primary" @click="requestReview">重试点评</button>
        <template v-else-if="state === 'changes'">
          <button @click="keepOriginal">保留原策略</button>
          <button class="primary" :disabled="!canApply" @click="applyReview">使用更正策略</button>
        </template>
        <button v-else-if="state === 'sound' || state === 'applied' || state === 'kept'" @click="close">关闭</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.strategy-review-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 18px; background: #000b; backdrop-filter: blur(4px); }
.strategy-review-dialog { display: flex; flex-direction: column; width: min(850px, 100%); max-height: min(760px, calc(100vh - 36px)); overflow: hidden; background: var(--carbon-card); border: 1px solid var(--line2); border-top: 3px solid var(--team); box-shadow: 0 18px 60px #000; }
.strategy-review-head, .strategy-review-foot { padding: 16px 20px; border-bottom: 1px solid var(--line); }
.strategy-review-head { display: flex; justify-content: space-between; gap: 12px; }
.strategy-review-head p { margin: 4px 0 0; }
.strategy-review-close { flex: none; min-width: 36px; }
.strategy-review-body { overflow-y: auto; padding: 16px 20px; }
.strategy-review-body > * + * { margin-top: 14px; }
.strategy-review-context { padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.strategy-review-plan { padding: 10px; border: 1px solid var(--line2); background: var(--bg); }
.strategy-review-plan > * + * { margin-top: 4px; }
.strategy-review-plan.corrected { border-color: #1f5a3a; }
.strategy-review-notice > * + * { margin-top: 4px; }
.strategy-review-results > * + * { margin-top: 8px; }
.strategy-review-issues { margin: 0; padding-left: 20px; }
.strategy-review-issues li + li { margin-top: 5px; }
.strategy-review-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.strategy-review-source { padding-top: 10px; border-top: 1px solid var(--line); }
.strategy-review-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--line); border-bottom: 0; background: #0b0d12; }
.strategy-review-foot > span { margin-right: auto; }
.strategy-review-foot button { min-height: 38px; }
@media (max-width: 640px) {
  .strategy-review-backdrop { padding: 8px; align-items: stretch; }
  .strategy-review-dialog { width: 100%; max-height: none; height: calc(100vh - 16px); }
  .strategy-review-head, .strategy-review-body, .strategy-review-foot { padding-left: 12px; padding-right: 12px; }
  .strategy-review-close { min-width: 44px; min-height: 44px; }
  .strategy-review-compare { grid-template-columns: 1fr; gap: 8px; }
  .strategy-review-foot { display: grid; grid-template-columns: 1fr 1fr; position: sticky; bottom: 0; }
  .strategy-review-foot > span { grid-column: 1 / -1; margin: 0; }
  .strategy-review-foot button { min-height: 44px; }
}
</style>
