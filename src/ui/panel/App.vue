<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { act, call, connect, store } from './bridge';
import Overview from './views/Overview.vue';
import Drivers from './views/Drivers.vue';
import Car from './views/Car.vue';
import Development from './views/Development.vue';
import Weekend from './views/Weekend.vue';
import Standings from './views/Standings.vue';
import Saves from './views/Saves.vue';
import NewGame from './views/NewGame.vue';
import TimingTower from './components/TimingTower.vue';
import MobileTabBar from './components/MobileTabBar.vue';
import SupernaturalPanel from './components/SupernaturalPanel.vue';
import RandomEventPanel from './components/RandomEventPanel.vue';

const tabs = [
  { id: 'overview', label: '总览' },
  { id: 'weekend', label: '比赛周末' },
  { id: 'drivers', label: '车手' },
  { id: 'car', label: '赛车' },
  { id: 'rnd', label: '研发与设施' },
  { id: 'standings', label: '积分榜' },
  { id: 'saves', label: '存档与设置' },
];

const view = computed(() => store.view);
const team = computed(() => view.value?.player.team);
const showNewGame = computed(() => store.connected && (!view.value || store.forceNewGame));
const generating = computed(() => !!store.status?.generating);
const dismissed = computed(() => view.value?.ferrari?.dismissed ?? view.value?.mercedes?.dismissed ?? null);
const supernaturalOpen = ref(false);

watch(
  () => team.value?.color,
  c => document.documentElement.style.setProperty('--team', c || '#e10600'),
  { immediate: true },
);

onMounted(() => connect());

async function advance() {
  if (!view.value?.next) return;
  if (view.value.season.phase === 'qualifying' || view.value.season.phase === 'sprint_qualifying') {
    store.tab = 'weekend';
    return;
  }
  await act({ type: 'ADVANCE' });
}

const advanceLabel = computed(() => {
  if (!view.value?.next) return '';
  const phase = view.value.season.phase;
  if (phase !== 'qualifying' && phase !== 'sprint_qualifying') return view.value.next.label;
  const live = view.value.weekend?.liveQualifying;
  const prefix = phase === 'sprint_qualifying' ? 'SQ' : 'Q';
  return `打开实时 ${prefix}${live?.segmentCount === 1 ? '' : (live?.segmentIndex ?? 0) + 1} 控制台`;
});

async function narrate() {
  await call(a => a.requestNarration());
}

function selectMobileTab(tab: string) {
  store.tab = tab;
}

function openSupernatural() {
  supernaturalOpen.value = true;
}

function supernaturalSettings() {
  store.tab = 'saves';
}
</script>

<template>
  <div class="app">
    <div v-if="!store.connected" class="center">
      <div class="notice bad" style="max-width: 520px">
        <b>无法连接后端</b>
        <p class="small">{{ store.error || '正在连接…' }}</p>
        <p class="small muted">本面板需要配合角色卡内置的「F1M 后端」酒馆助手脚本使用。</p>
      </div>
    </div>

    <NewGame v-else-if="showNewGame" />

    <template v-else-if="view && team">
      <RandomEventPanel mode="modal" />
      <header class="top">
        <div class="team-badge" :style="{ background: team.color }">{{ team.short }}</div>
        <div class="grow">
          <div class="title">
            {{ team.name }}
            <span class="muted small">领队 {{ view.meta.principalName }}</span>
          </div>
          <div class="small muted">
            {{ view.season.year }} 赛季 · 第 {{ view.season.roundIndex + 1 }}/{{ view.season.rounds }} 站
            <template v-if="view.round"> · {{ view.round.track.name }}（{{ view.round.track.type }}）</template>
            · <span class="badge team">{{ view.season.phaseLabel }}</span>
            <span v-if="view.round?.sprint" class="badge warn">冲刺赛周末</span>
          </div>
        </div>
        <div class="row actions">
          <button v-if="view.supernatural.enabled" class="small supernatural-entry" :disabled="store.busy || generating || !!dismissed || !!view.flags.fired" @click="openSupernatural">超自然干预</button>
          <button v-if="view.narration.length" class="small" :disabled="generating" :title="'待叙述：' + view.narration.map(n => n.title).join('、')" @click="narrate">
            让 AI 叙述（{{ view.narration.length }}）
          </button>
          <button v-if="view.next" class="primary" :disabled="store.busy || generating" @click="advance">▶ {{ advanceLabel }}</button>
        </div>
      </header>
      <div v-if="generating" class="notice warn small" style="margin: 0 12px 8px">AI 正在生成回复，生成结束前面板只读。</div>
      <div v-if="store.status?.fallback" class="notice warn small" style="margin: 0 12px 8px">当前楼层原本的存档版本已被清理，正在使用最早仍保留的版本。</div>
      <div v-if="dismissed" class="notice bad small" style="margin: 0 12px 8px">
        你已被解除领队职务：{{ dismissed }}。本局结束，请在「存档」中读档或重新开局。
      </div>
      <div v-else-if="view.flags.fired" class="notice bad small" style="margin: 0 12px 8px">董事会已解除你的领队职务（剧情）。你仍可以继续游玩或在「存档」中读档。</div>
      <div class="broadcast-shell">
        <TimingTower :view="view" />
        <div class="panel-main">
          <nav class="tabs">
            <button v-for="t in tabs" :key="t.id" :class="{ on: store.tab === t.id }" @click="store.tab = t.id">{{ t.label }}</button>
          </nav>
          <main class="content">
            <div v-if="store.tab === 'more'" class="mobile-more card">
              <h3>更多</h3>
              <button @click="store.tab = 'standings'">积分榜</button>
              <button v-if="view.supernatural.enabled" class="supernatural-entry" :disabled="store.busy || generating || !!dismissed || !!view.flags.fired" @click="openSupernatural">超自然干预</button>
              <button @click="store.tab = 'saves'">存档与设置</button>
            </div>
            <Saves v-else-if="store.tab === 'saves'" />
            <!-- 被法拉利撤职后本局只读：禁用除存档页以外的所有操作控件 -->
            <fieldset v-else class="readonly-lock" :disabled="!!dismissed">
              <Overview v-if="store.tab === 'overview'" />
              <Weekend v-else-if="store.tab === 'weekend'" />
              <Drivers v-else-if="store.tab === 'drivers'" />
              <Car v-else-if="store.tab === 'car'" />
              <Development v-else-if="store.tab === 'rnd'" />
              <Standings v-else-if="store.tab === 'standings'" />
            </fieldset>
          </main>
        </div>
      </div>
      <MobileTabBar :tab="store.tab" @select="selectMobileTab" />
      <SupernaturalPanel :open="supernaturalOpen" @close="supernaturalOpen = false" @settings="supernaturalSettings" />
    </template>

    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.broadcast-shell {
  min-height: 0;
  flex: 1;
  display: flex;
}
.panel-main {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}
.center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  flex-wrap: wrap;
}
.team-badge {
  width: 46px;
  height: 46px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  color: #fff;
  letter-spacing: 0.5px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  flex: 0 0 auto;
}
.title {
  font-size: 17px;
  font-weight: 700;
}
.title .muted {
  font-weight: 400;
  margin-left: 6px;
}
.actions {
  margin-left: auto;
}
.supernatural-entry {
  border-color: color-mix(in srgb, var(--purple) 65%, var(--line));
  color: #ddb8ff;
  background: color-mix(in srgb, var(--purple) 12%, var(--bg3));
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs button {
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  padding: 8px 12px;
  color: var(--muted);
  white-space: nowrap;
}
.tabs button.on {
  color: var(--text);
  border-bottom-color: var(--team);
  font-weight: 600;
}
.content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
}
.mobile-more { display: grid; gap: 8px; }
.readonly-lock {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.readonly-lock:disabled :deep(:is(button, input, select, textarea)) {
  opacity: 0.5;
  cursor: not-allowed;
}
.toasts {
  position: fixed;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 50;
  max-width: min(420px, 90vw);
  pointer-events: none;
}
.toast {
  background: var(--bg3);
  border: 1px solid var(--line);
  border-left: 4px solid var(--blue);
  padding: 8px 12px;
  border-radius: 8px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
}
.toast.ok {
  border-left-color: var(--green);
}
.toast.err {
  border-left-color: var(--red);
}
@media (max-width: 767px) {
  .broadcast-shell { flex-direction: column; }
  .top { min-height: 56px; height: 56px; padding: 0 8px 0 0; flex-wrap: nowrap; gap: 8px; }
  .team-badge { height: 56px; width: 60px; min-width: 60px; border-radius: 0; font-size: 15px; }
  .top .grow { min-width: 0; overflow: hidden; }.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }.title .muted { display: none; }.top .small.muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.actions { margin-left: 0; flex-wrap: nowrap; }.actions button:not(.primary) { display: none; }.actions .primary { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 6px 8px; font-size: 11px; }
  .tabs { display: none; }.content { padding: 10px 12px calc(var(--tabbar-h) + 16px); }.mobile-more button { text-align: left; }
  .toasts { top: 66px; right: 12px; bottom: auto; left: 12px; max-width: none; }
  .toast:not(:last-child) { display: none; }
}
</style>
