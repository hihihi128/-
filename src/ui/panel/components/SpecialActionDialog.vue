<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, clone, refresh, store } from '../bridge';
import type { Action } from '../../../engine/types';

type DialogState = 'idle' | 'submitting' | 'stale' | 'action_error' | 'applied' | 'narrating' | 'narration_error';
type NarrationStatus = 'not_requested' | 'pending' | 'completed' | 'failed' | 'stale';

interface SpecialActionResult {
  ok: boolean;
  message: string;
  requestId: string;
  actionApplied: boolean;
  actionRevisionId?: string;
  narrationStatus: NarrationStatus;
}

interface SpecialActionApi {
  executeSpecialAction(request: { requestId: string; action: Action; contextText: string; expectedRevisionId?: string }): Promise<SpecialActionResult>;
  retrySpecialActionNarration(request: { requestId: string; expectedRevisionId?: string }): Promise<SpecialActionResult>;
}

const props = defineProps<{
  action: Action;
  title: string;
  subject?: string;
  hint: string;
  expectedRevisionId?: string | null;
}>();

const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLElement | null>(null);
const contextText = ref('');
const state = ref<DialogState>('idle');
const message = ref('');
const requestId = ref('');
const actionRevisionId = ref<string | undefined>();
const actionSubmitted = ref(false);
const opener = ref<HTMLElement | null>(null);
const initialRevision = props.expectedRevisionId ?? undefined;

const trimmedContext = computed(() => contextText.value.trim());
const characterCount = computed(() => contextText.value.length);
const isSubmitting = computed(() => state.value === 'submitting');
const canClose = computed(() => !isSubmitting.value);
const isOverLimit = computed(() => characterCount.value > 1000);
const primaryLabel = computed(() => trimmedContext.value ? '执行并叙述' : '直接执行');
const statusText = computed(() => {
  if (state.value === 'submitting') return '正在执行既定动作，请勿关闭或重复提交。';
  if (state.value === 'narrating') return '动作已执行，主聊天正在叙述结果。你可关闭后前往聊天查看进度。';
  if (state.value === 'narration_error') return message.value || '动作已执行，叙述未完成。';
  if (state.value === 'action_error') return message.value || '动作未执行。请检查当前规则后重试。';
  if (state.value === 'stale') return message.value || '当前状态已变化，请关闭后重新选择动作。';
  if (state.value === 'applied') return message.value || '动作已执行。';
  return '数值按所选动作结算；补充内容只用于剧情表达，不会改变动作效果。';
});

function makeRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `special-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getApi(): SpecialActionApi | null {
  return api() as unknown as SpecialActionApi | null;
}

function applyResult(result: SpecialActionResult): void {
  message.value = result.message;
  requestId.value = result.requestId || requestId.value;
  actionRevisionId.value = result.actionRevisionId ?? actionRevisionId.value;
  actionSubmitted.value ||= result.actionApplied;

  if (result.narrationStatus === 'stale') {
    state.value = 'stale';
  } else if (!result.actionApplied) {
    state.value = 'action_error';
  } else if (result.narrationStatus === 'pending') {
    state.value = 'narrating';
  } else if (result.narrationStatus === 'failed') {
    state.value = 'narration_error';
  } else {
    state.value = 'applied';
  }
}

async function execute(): Promise<void> {
  if (isSubmitting.value || actionSubmitted.value) return;
  if (isOverLimit.value) {
    state.value = 'action_error';
    message.value = '补充内容不能超过 1000 字符。';
    return;
  }
  const backend = getApi();
  if (!backend) {
    state.value = 'action_error';
    message.value = '没有找到后端脚本，无法执行动作。';
    return;
  }

  state.value = 'submitting';
  message.value = '';
  requestId.value = makeRequestId();
  try {
    const result = clone(await backend.executeSpecialAction({
      requestId: requestId.value,
      action: props.action,
      contextText: trimmedContext.value,
      expectedRevisionId: props.expectedRevisionId ?? undefined,
    }));
    applyResult(result);
  } catch (error) {
    state.value = 'action_error';
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    refresh();
  }
}

async function retryNarration(): Promise<void> {
  if (state.value !== 'narration_error' || !requestId.value) return;
  const backend = getApi();
  if (!backend) return;
  state.value = 'narrating';
  try {
    const result = clone(await backend.retrySpecialActionNarration({
      requestId: requestId.value,
      expectedRevisionId: actionRevisionId.value ?? store.status?.revisionId ?? undefined,
    }));
    applyResult(result);
  } catch (error) {
    state.value = 'narration_error';
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    refresh();
  }
}

function close(): void {
  if (!canClose.value) return;
  emit('close');
}

function trapFocus(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab' || !dialog.value) return;
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(() => store.status?.revisionId, revision => {
  if (!actionSubmitted.value && state.value === 'idle' && revision && initialRevision && revision !== initialRevision) {
    state.value = 'stale';
    message.value = '当前状态已变化，请关闭后重新选择动作。';
  }
});

watch(() => store.status?.specialAction, specialAction => {
  if (!specialAction || specialAction.requestId !== requestId.value || !actionSubmitted.value) return;
  message.value = specialAction.message;
  actionRevisionId.value = specialAction.actionRevisionId ?? actionRevisionId.value;
  if (specialAction.narrationStatus === 'pending') state.value = 'narrating';
  else if (specialAction.narrationStatus === 'completed' || specialAction.narrationStatus === 'not_requested') state.value = 'applied';
  else if (specialAction.narrationStatus === 'failed') state.value = 'narration_error';
  else if (specialAction.narrationStatus === 'stale') state.value = 'stale';
});

onMounted(() => {
  opener.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void nextTick(() => dialog.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus());
});
onUnmounted(() => opener.value?.isConnected && opener.value.focus());
</script>

<template>
  <div class="special-action-backdrop" role="presentation" @click.self="close">
    <section ref="dialog" class="special-action-dialog" role="dialog" aria-modal="true" aria-labelledby="special-action-title" aria-describedby="special-action-description" tabindex="-1" @keydown="trapFocus">
      <header class="special-action-head">
        <div>
          <div class="tiny muted">特殊机制 / FIA 行动</div>
          <h2 id="special-action-title">{{ title }}</h2>
          <p v-if="subject" class="small">对象：<b>{{ subject }}</b></p>
        </div>
        <button class="small ghost special-action-close" :disabled="!canClose" aria-label="关闭特殊动作确认" @click="close">✕</button>
      </header>

      <div class="special-action-body">
        <section class="special-action-rule">
          <b>规则提示</b>
          <p id="special-action-description" class="small">{{ hint }}</p>
          <p class="tiny muted">数值按所选动作结算；补充内容仅用于剧情表达。</p>
        </section>

        <template v-if="state === 'idle' || state === 'action_error'">
          <label class="special-action-field">
            <span>同时想做/说什么（可选）</span>
            <textarea v-model="contextText" :disabled="isSubmitting" rows="5" placeholder="例如：说明你希望如何表达这次决定；不会改变数值结算。" />
          </label>
          <div class="special-action-count" :class="{ over: isOverLimit }">{{ characterCount }}/1000</div>
        </template>

        <section v-if="state !== 'idle'" class="notice special-action-status" :class="{ ok: state === 'applied', warn: state === 'narrating', bad: state === 'stale' || state === 'action_error' || state === 'narration_error' }" :aria-live="state === 'submitting' || state === 'narrating' ? 'polite' : 'assertive'">
          <b>{{ statusText }}</b>
          <div v-if="state === 'narration_error'" class="small">动作已执行，无法重新执行；你只能重试叙述或关闭。</div>
          <div v-else-if="state === 'action_error'" class="small">动作没有执行，已保留你的补充内容。</div>
        </section>
      </div>

      <footer class="special-action-foot">
        <span class="tiny muted">{{ isSubmitting ? '提交中，所有关闭路径已锁定' : state === 'narration_error' ? '动作结果不会因叙述失败而回滚' : '关闭、取消或按 Escape 都不会提交未执行的动作' }}</span>
        <template v-if="state === 'idle' || state === 'action_error'">
          <button :disabled="isSubmitting" @click="close">取消</button>
          <button class="primary" :disabled="isSubmitting || isOverLimit" @click="execute">{{ primaryLabel }}</button>
        </template>
        <button v-else-if="state === 'narration_error'" class="primary" @click="retryNarration">仅重试叙述</button>
        <button v-else-if="state !== 'submitting' && state !== 'narrating'" @click="close">关闭</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.special-action-backdrop { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 18px; background: #000c; backdrop-filter: blur(5px); }
.special-action-dialog { display: flex; flex-direction: column; width: min(600px, 100%); max-height: min(760px, calc(100dvh - 36px)); overflow: hidden; background: var(--carbon-card); border: 1px solid var(--line2); border-top: 3px solid var(--team); box-shadow: 0 24px 72px #000; }
.special-action-head, .special-action-foot { padding: 16px 20px; background: #0b0d12; }
.special-action-head { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); }
.special-action-head h2, .special-action-head p { margin: 3px 0 0; overflow-wrap: anywhere; }
.special-action-close { flex: none; min-width: 38px; min-height: 38px; }
.special-action-body { overflow-y: auto; padding: 18px 20px; }
.special-action-body > * + * { margin-top: 14px; }
.special-action-rule { padding: 12px; border-left: 3px solid var(--team); background: var(--bg); }
.special-action-rule p { margin: 5px 0 0; }
.special-action-field { display: grid; gap: 8px; font-size: 13px; font-weight: 700; }
.special-action-field textarea { width: 100%; min-height: 112px; resize: vertical; font: inherit; line-height: 1.55; }
.special-action-count { text-align: right; font: 12px var(--mono); color: var(--muted); }
.special-action-count.over { color: var(--red); font-weight: 700; }
.special-action-status > * + * { margin-top: 5px; }
.special-action-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--line); }
.special-action-foot > span { margin-right: auto; }
.special-action-foot button { min-height: 38px; }
@media (max-width: 640px) {
  .special-action-backdrop { align-items: stretch; padding: 8px; }
  .special-action-dialog { width: 100%; max-height: none; height: calc(100dvh - 16px); }
  .special-action-head, .special-action-body, .special-action-foot { padding-left: 12px; padding-right: 12px; }
  .special-action-close, .special-action-foot button { min-height: 44px; }
  .special-action-foot { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .special-action-foot > span { grid-column: 1 / -1; margin: 0; }
  .special-action-foot > button:only-child { grid-column: 1 / -1; }
}
</style>
