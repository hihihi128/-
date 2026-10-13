<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { call, peek, store } from '../bridge';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; settings: [] }>();

const dialog = ref<HTMLElement | null>(null);
const description = ref('');
const results = ref<Array<{ op: string; target: string; requested: unknown; applied: unknown; reason: string; ok: boolean; note: string }>>([]);
const responseMessage = ref('');
const selectedApi = ref<'main' | 'secondary'>('main');
let returnFocus: HTMLElement | null = null;

const supernatural = computed(() => store.view?.supernatural ?? null);
const caps = computed(() => supernatural.value?.caps);
const canSubmit = computed(() => !!description.value.trim() && description.value.length <= 1000 && !!supernatural.value?.available && !store.busy && !store.status?.generating);
const recent = computed(() => (store.view?.aiLog ?? []).filter(entry => entry.source === 'supernatural').slice(-8).reverse());

const cards = computed(() => {
  const c = caps.value;
  return [
    { title: '人物状态', cap: `心态 ±${c?.morale ?? 10} · 信任 ±${c?.trust ?? 10} · 体能 ±${c?.fitness ?? 20}`, text: '仅限本队正式与储备车手，最终数值保持在 0–100。' },
    { title: '人员与车手能力', cap: '每名对象合计 ±1', text: '可微调车手六项属性或当前员工技能，不改变合同与身份。' },
    { title: '车队与资金', cap: `董事会 ±${c?.board ?? 8} · 媒体/士气 ±${c?.media ?? 10} · 资金 ±$${c?.funds ?? 3}M`, text: '资金保持在 $0–500M，不影响成本帽支出记录。' },
    { title: '研发进度', cap: `最多提前 ${c?.researchWeeks ?? 1} 周`, text: '仅限现有设计项目，最多推进到最后一周，不能直接交付。' },
    { title: '天气倾向', cap: `单次 ±${Math.round((c?.weatherTendency ?? .1) * 100)} 个百分点`, text: '仅在进入比赛周末前调整公开降雨倾向，不读取或改写隐藏天气。' },
    { title: '临时赛车调校', cap: `单项 ±${c?.carSetup ?? 10}，本站总偏移 ±${c?.carSetupOffset ?? 15}`, text: '仅影响本站未来计算中的调校信心和轮胎知识，周末后失效。' },
  ];
});

watch(() => props.open, async open => {
  if (!open) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const settings = peek(api => api.getSettings());
  selectedApi.value = settings?.engineerApi === 'secondary' ? 'secondary' : 'main';
  responseMessage.value = '';
  results.value = [];
  await nextTick();
  dialog.value?.querySelector<HTMLElement>('textarea')?.focus();
});

function close() {
  emit('close');
  nextTick(() => returnFocus?.focus());
}

function keydown(event: KeyboardEvent) {
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
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

async function submit() {
  const revisionId = store.status?.revisionId;
  if (!revisionId || !canSubmit.value) return;
  const result = await call(api => api.requestSupernaturalIntervention({
    description: description.value.trim(),
    expectedRevisionId: revisionId,
    api: selectedApi.value,
  }), false);
  if (!result) return;
  responseMessage.value = result.message;
  results.value = result.results ?? [];
  if (result.ok) description.value = '';
}

function openSettings() {
  emit('settings');
  close();
}
</script>

<template>
  <div v-if="open" class="supernatural-backdrop" @mousedown.self="close">
    <section ref="dialog" class="supernatural-dialog" role="dialog" aria-modal="true" aria-labelledby="supernatural-title" @keydown="keydown">
      <header class="dialog-head">
        <div>
          <h2 id="supernatural-title">超自然干预</h2>
          <div class="small muted">明确描述你的人设能力如何影响当前局面。引擎只执行白名单内的受限变化。</div>
        </div>
        <button type="button" aria-label="关闭超自然干预" @click="close">✕</button>
      </header>

      <div class="dialog-scroll stack">
        <div class="notice warn small">
          <b>不限发动次数，但每次有硬上限。</b>
          不能直接修改名次、比赛结果、零件性能、合同、隐藏天气或随机数。
        </div>

        <div class="grid g2 whitelist">
          <article v-for="card in cards" :key="card.title" class="card stack-s">
            <div class="spread"><b>{{ card.title }}</b><span class="badge team">{{ card.cap }}</span></div>
            <div class="small muted">{{ card.text }}</div>
          </article>
        </div>

        <div class="card stack-s">
          <div class="spread">
            <h3>描述本次干预</h3>
            <span class="badge" :class="supernatural?.available ? 'ok' : 'bad'">{{ supernatural?.available ? '当前可用' : '当前不可用' }}</span>
          </div>
          <div v-if="supernatural?.reason" class="notice bad small">{{ supernatural.reason }}</div>
          <textarea v-model="description" rows="5" maxlength="1000" placeholder="例如：我让车手在事故后恢复冷静，并让空气中的水汽略微增加……"></textarea>
          <div class="spread tiny muted">
            <span>由所选策略 API 生成严格指令，随后由引擎逐条验证。</span>
            <span class="mono">{{ description.length }}/1000</span>
          </div>
          <div class="spread api-row">
            <div class="small">当前 API：<b>{{ selectedApi === 'secondary' ? '副 API' : '主 API' }}</b></div>
            <button type="button" class="small ghost" @click="openSettings">前往 API 设置</button>
          </div>
          <button type="button" class="primary invoke" :disabled="!canSubmit" @click="submit">{{ store.busy ? '生成并校验中…' : '生成并执行干预' }}</button>
        </div>

        <div v-if="responseMessage || results.length" class="card stack-s result-card">
          <h3>本次结果</h3>
          <div class="notice small" :class="results.some(row => row.ok) ? 'ok' : 'bad'">{{ responseMessage }}</div>
          <div v-for="(row, index) in results" :key="index" class="result-row small" :class="row.ok ? 'accepted' : 'rejected'">
            <div class="spread"><b>{{ row.op }} · {{ row.target || '—' }}</b><span class="badge" :class="row.ok ? 'ok' : 'bad'">{{ row.ok ? '已应用' : '已拒绝' }}</span></div>
            <div>请求：{{ row.requested ?? '—' }} · 实际：{{ row.applied ?? '—' }}</div>
            <div v-if="row.reason || row.note" class="tiny muted">{{ row.reason }}<template v-if="row.reason && row.note"> · </template>{{ row.note }}</div>
          </div>
        </div>

        <details v-if="recent.length" class="card recent">
          <summary>最近干预记录（{{ recent.length }}）</summary>
          <div v-for="(entry, index) in recent" :key="index" class="result-row tiny" :class="entry.ok ? 'accepted' : 'rejected'">{{ entry.text }}</div>
        </details>
      </div>
    </section>
  </div>
</template>

<style scoped>
.supernatural-backdrop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 20px; background: rgba(0,0,0,.72); backdrop-filter: blur(3px); }
.supernatural-dialog { width: min(820px, 96vw); max-height: min(820px, 94vh); display: flex; flex-direction: column; overflow: hidden; background: var(--carbon); border: 1px solid var(--line2); border-radius: 8px; box-shadow: 0 28px 80px rgba(0,0,0,.8); }
.dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: linear-gradient(90deg, #321243, #17131d 55%, #111319); }
.dialog-head button { min-width: 38px; min-height: 38px; }
.dialog-scroll { overflow: auto; padding: 14px; }
.whitelist .card { border-color: #3c2d49; }
.whitelist .card::before { background: linear-gradient(180deg, var(--purple), transparent); }
.api-row { padding-top: 4px; border-top: 1px solid var(--line); }
.invoke { min-height: 42px; }
.result-row { display: grid; gap: 3px; padding: 8px 10px; border-left: 3px solid var(--line2); background: var(--bg2); }
.result-row.accepted { border-left-color: var(--green); }
.result-row.rejected { border-left-color: var(--neg); }
.recent summary { cursor: pointer; }
.recent[open] summary { margin-bottom: 8px; }
@media (max-width: 767px) {
  .supernatural-backdrop { align-items: end; padding: 6px; padding-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 6px); }
  .supernatural-dialog { width: 100%; max-height: min(778px, calc(100dvh - var(--tabbar-h) - env(safe-area-inset-bottom) - 12px)); }
  .dialog-head { padding: 12px; }
  .dialog-scroll { padding: 10px; }
  .whitelist { grid-template-columns: 1fr; }
  .badge.team { white-space: normal; text-align: right; }
}
</style>
