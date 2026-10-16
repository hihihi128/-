<script setup lang="ts">
import { computed, ref } from 'vue';
import type { NegotiationKind } from '../../../tavern/negotiation';
import { call, peek, store } from '../bridge';

const props = defineProps<{ kind: NegotiationKind; preferredChoice?: string | null }>();
const apiChoice = ref<'main' | 'secondary'>(peek(api => api.getSettings().engineerApi) ?? 'main');
const text = ref('');
const mine = computed(() => store.negotiation?.kind === props.kind ? store.negotiation : null);
const otherActive = computed(() => store.negotiation?.status === 'active' && store.negotiation.kind !== props.kind);
const choiceRequired = computed(() => props.kind === 'fia_roundtable' && !props.preferredChoice);

async function start() {
  const result = await call(api => api.startSpecialNegotiation({ kind: props.kind, api: apiChoice.value, preferredChoice: props.preferredChoice ?? null }));
  if (result) store.negotiation = result.session;
}

async function send() {
  const current = mine.value;
  if (!current || !text.value.trim()) return;
  const message = text.value;
  text.value = '';
  const result = await call(api => api.sendSpecialNegotiationTurn({ text: message, sessionId: current.id }));
  if (result) store.negotiation = result.session;
  if (!result?.ok) text.value = message;
}

async function cancel() {
  const result = await call(api => api.cancelSpecialNegotiation());
  if (result) store.negotiation = result.session;
}
</script>

<template>
  <div class="negotiation stack-s">
    <div v-if="!mine" class="row wrap">
      <select v-model="apiChoice" class="small" :disabled="store.busy">
        <option value="secondary">副 API</option>
        <option value="main">主 API</option>
      </select>
      <button class="primary" :disabled="store.busy || otherActive || choiceRequired" @click="start">开始多轮 AI 谈判</button>
      <span v-if="props.preferredChoice" class="tiny muted">将按已选立场进行谈判。</span>
      <span v-else-if="choiceRequired" class="tiny muted">请先选择会议立场。</span>
      <span v-if="otherActive" class="tiny muted">请先完成当前的 {{ store.negotiation?.title }}。</span>
      <button v-if="otherActive" class="small" :disabled="store.busy" @click="cancel">取消当前谈判</button>
    </div>

    <template v-else>
      <div class="spread">
        <b class="small">{{ mine.title }}</b>
        <span class="badge" :class="mine.status === 'agreement' ? 'ok' : mine.status === 'breakdown' ? 'bad' : 'warn'">
          {{ mine.status === 'active' ? `${mine.round}/${mine.maxRounds} 轮` : mine.status === 'agreement' ? '已达成协议' : '谈判破裂' }}
        </span>
      </div>
      <div class="negotiation-log">
        <div v-for="(message, index) in mine.messages" :key="index" class="message" :class="message.role">
          <b>{{ message.speaker }}</b>
          <div>{{ message.text }}</div>
        </div>
      </div>
      <div v-if="mine.outcome" class="notice small" :class="mine.status === 'agreement' ? 'ok' : 'bad'">{{ mine.outcome }}</div>
      <template v-if="mine.status === 'active'">
        <textarea v-model="text" rows="3" maxlength="1000" placeholder="输入你的立场、条件或让步方案……" :disabled="store.busy" @keydown.ctrl.enter.prevent="send" />
        <div class="spread">
          <span class="tiny muted">至少 2 轮，最多 4 轮。Ctrl+Enter 发送。</span>
          <div class="row">
            <button class="small" :disabled="store.busy" @click="cancel">取消</button>
            <button class="primary" :disabled="store.busy || !text.trim()" @click="send">发送发言</button>
          </div>
        </div>
      </template>
      <button v-else class="small" :disabled="store.busy" @click="cancel">关闭谈判记录</button>
    </template>
  </div>
</template>

<style scoped>
.negotiation {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg) 88%, var(--team) 12%);
}
.negotiation-log {
  max-height: 260px;
  overflow: auto;
  display: grid;
  gap: 8px;
}
.message {
  padding: 8px;
  border-radius: 8px;
  background: var(--panel);
  font-size: 12px;
  line-height: 1.55;
}
.message.player {
  margin-left: 12%;
  border-right: 3px solid var(--team);
}
.message.counterparty {
  margin-right: 12%;
  border-left: 3px solid #ffb347;
}
textarea {
  width: 100%;
  resize: vertical;
}
</style>
