<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { call, store } from '../bridge';

const props = withDefaults(defineProps<{ mode?: 'card' | 'modal' }>(), { mode: 'card' });
const event = computed(() => store.view?.randomEvents?.current ?? null);
const answer = ref('');
const failedMainReply = ref<string | null>(null);
const dialog = ref<HTMLElement | null>(null);
const secondaryConfigured = computed(() => {
  const settings = store.status?.settings;
  return !!settings?.engineerProxyPreset || (!!settings?.engineerApiUrl && !!settings?.engineerModel);
});

watch(() => [event.value?.id, event.value?.status] as const, ([id, status], previous) => {
  const [previousId, previousStatus] = previous ?? [];
  if (id && status === 'awaiting_player' && event.value?.category === 'problem' && (id !== previousId || previousStatus !== 'awaiting_player')) {
    store.randomEventOpen = true;
    answer.value = '';
    failedMainReply.value = null;
    void nextTick(() => dialog.value?.focus());
  }
}, { immediate: true });
watch(() => store.randomEventOpen, value => {
  if (value) void nextTick(() => dialog.value?.focus());
});

async function submit() {
  const current = event.value;
  const revisionId = store.status?.revisionId;
  if (!current || !revisionId || !answer.value.trim()) return;
  const result = await call(api => api.resolveRandomEvent({ eventId: current.id, answer: answer.value, expectedRevisionId: revisionId }));
  if (result && !result.ok) failedMainReply.value = result.mainReply;
}

async function skip() {
  const current = event.value;
  const revisionId = store.status?.revisionId;
  if (!current || !revisionId) return;
  await call(api => api.skipRandomEvent({ eventId: current.id, expectedRevisionId: revisionId }));
}

function effectLabel(effect: NonNullable<typeof event.value>['effects'][number]): string {
  const labels: Record<string, string> = {
    driver_fitness: '车手体能', driver_morale: '车手心态', funds: '资金', project_weeks: '研发周期',
    part_reliability: '零件可靠性', staff_skill: '员工技能', aero_hours: '风洞时长', affinity: '人物好感',
  };
  return `${labels[effect.op] ?? effect.op} ${effect.delta > 0 ? '+' : ''}${effect.delta}`;
}
</script>

<template>
  <div v-if="props.mode === 'card' && event" class="card stack-s special-card">
    <div class="spread">
      <h3>本周随机事件</h3>
      <span class="badge" :class="event.status === 'resolved' || event.status === 'none' ? 'ok' : event.status === 'unresolved' ? 'bad' : 'warn'">
        {{ event.status === 'none' ? '无事发生' : event.status === 'awaiting_player' ? '等待处理' : event.status === 'awaiting_narration' ? '等待聊天叙述' : event.status === 'resolved' ? '已解决' : event.status === 'unresolved' ? '未解决' : '生成中' }}
      </span>
    </div>
    <b>{{ event.title }}</b>
    <div v-if="event.kind !== 'none'" class="tiny muted">第 {{ event.completedDialogueTurns + (event.status === 'resolved' || event.status === 'unresolved' ? 0 : 1) }}/{{ event.totalDialogueTurns }} 轮 · {{ event.category === 'routine' ? '日常小事' : '需要处理的问题' }}</div>
    <div class="small">{{ event.status === 'resolved' || event.status === 'unresolved' ? event.outcomeSummary : event.prompt }}</div>
    <div v-if="event.effects.length" class="row wrap"><span v-for="(effect, index) in event.effects" :key="index" class="badge">{{ effectLabel(effect) }}</span></div>
    <button v-if="event.kind !== 'none'" class="small" @click="store.randomEventOpen = true">{{ event.status === 'awaiting_player' ? '处理事件' : '查看事件记录' }}</button>
  </div>

  <div v-if="props.mode === 'modal' && store.randomEventOpen && event && event.kind !== 'none'" class="event-backdrop" role="presentation" @click.self="store.randomEventOpen = false">
    <section ref="dialog" class="event-modal stack" role="dialog" aria-modal="true" aria-label="随机事件" tabindex="-1" @keydown.esc="store.randomEventOpen = false">
      <div class="spread"><div><div class="tiny muted">主聊天叙述 · 副 API 判定</div><h2>{{ event.title }}</h2></div><button aria-label="关闭" @click="store.randomEventOpen = false">×</button></div>
      <div class="tiny muted">{{ event.category === 'routine' ? '日常小事' : '需要处理的问题' }} · 第 {{ Math.min(event.completedDialogueTurns + 1, event.totalDialogueTurns) }}/{{ event.totalDialogueTurns }} 轮</div>
      <div v-if="!event.id.startsWith('legacy-random-event-') || event.status === 'awaiting_player'" class="notice warn">{{ event.prompt }}</div>
      <div v-if="event.generationError" class="tiny muted">随机事件准备、剧情或副 API 判定失败：{{ event.generationError }}</div>

      <template v-if="event.status === 'awaiting_player'">
        <div v-if="event.completedDialogueTurns === 0 && event.answerOptions.length" class="row wrap">
          <button
            v-for="(option, index) in event.answerOptions"
            :key="`${index}-${option}`"
            class="small"
            :class="{ selected: answer === option }"
            :aria-pressed="answer === option"
            :disabled="store.busy"
            @click="answer = option"
          >{{ option }}</button>
        </div>
        <div v-if="event.dialogue.length" class="stack-s"><div v-for="(turn, index) in event.dialogue" :key="index" class="dialog-line"><b>第 {{ index + 1 }} 轮</b><div>你：{{ turn.player }}</div><div>剧情：{{ turn.assistant }}</div></div></div>
        <label class="field"><span>{{ event.completedDialogueTurns === 0 ? '你的处理方案' : '你的后续回应' }}</span><textarea v-model="answer" rows="5" maxlength="1000" :placeholder="event.completedDialogueTurns === 0 ? '说明你的决定、执行方式和可接受代价……' : '根据上一轮剧情继续回应……'" :disabled="store.busy" /></label>
        <div v-if="failedMainReply" class="dialog-line"><b>上次主 API 剧情（副 API 判定失败）</b><div>{{ failedMainReply }}</div></div>
        <div v-else-if="event.generationError && event.mainReply" class="dialog-line"><b>上次主 API 剧情（副 API 判定失败）</b><div>{{ event.mainReply }}</div></div>
        <div v-if="!secondaryConfigured" class="notice warn small">尚未配置副 API。请前往“存档与设置”配置，或跳过本次事件。</div>
        <div class="spread"><span class="tiny muted">提交后由主 API 在正常聊天中继续剧情；最后一轮结束后，副 API 才会判定效果。</span><div class="row"><button class="small" :disabled="store.busy" @click="skip">跳过（无效果）</button><button class="primary" :disabled="store.busy || !answer.trim() || !secondaryConfigured" @click="submit">{{ event.completedDialogueTurns + 1 >= event.totalDialogueTurns ? '提交并完成剧情' : '提交并继续剧情' }}</button></div></div>
      </template>

      <template v-else-if="event.status === 'awaiting_narration'">
        <div class="notice warn"><b>正在等待主 API 的正常聊天剧情。</b><div>请等待酒馆生成结束；收到实际剧情后会自动交给副 API 做严格判定。</div></div>
      </template>

      <template v-else>
        <div v-for="(turn, index) in event.dialogue" :key="index" class="dialog-line"><b>第 {{ index + 1 }} 轮</b><div>你：{{ turn.player }}</div><div>剧情：{{ turn.assistant }}</div></div>
        <div class="notice" :class="event.status === 'resolved' ? 'ok' : 'bad'"><b>{{ event.status === 'resolved' ? '事件已解决' : '事件未解决' }}</b><div>{{ event.outcomeSummary }}</div></div>
        <div v-if="event.effects.length" class="stack-s"><div v-for="(effect, index) in event.effects" :key="index" class="small"><b>{{ effectLabel(effect) }}</b> · {{ effect.reason }}</div></div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.event-backdrop { position: fixed; inset: 0; z-index: 1100; display: grid; place-items: center; padding: 18px; background: #05070ddd; backdrop-filter: blur(5px); }
.event-modal { width: min(680px, 100%); max-height: min(88vh, 760px); overflow: auto; padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--bg2); box-shadow: 0 24px 70px #000b; }
.event-modal h2 { margin: 3px 0 0; }
.event-modal textarea { width: 100%; resize: vertical; }
.event-modal button.selected { border-color: var(--team); background: color-mix(in srgb, var(--team) 24%, var(--panel)); box-shadow: 0 0 0 1px var(--team); }
.dialog-line { padding: 12px; border-left: 3px solid var(--orange); background: var(--bg); border-radius: 8px; }
.dialog-line.player { border-left-color: var(--team); }
.dialog-line b, .dialog-line div { display: block; }
.dialog-line div { margin-top: 5px; line-height: 1.6; }
</style>
