<script setup lang="ts">
const props = defineProps<{ tab: string }>();
const emit = defineEmits<{ select: [tab: string] }>();
const tabs = [
  ['overview', '总览', '⌂'],
  ['weekend', '比赛周末', '◷'],
  ['drivers', '车手', '♙'],
  ['car', '赛车', '⌁'],
  ['rnd', '研发', '⌘'],
  ['more', '更多', '•••'],
] as const;
function active(id: string) { return id === 'more' ? ['more', 'standings', 'saves'].includes(props.tab) : props.tab === id; }
</script>

<template>
  <nav class="mobile-tabbar" aria-label="主导航">
    <button v-for="[id, label, icon] in tabs" :key="id" type="button" :class="{ on: active(id) }" @click="emit('select', id)">
      <span class="tab-icon" aria-hidden="true">{{ icon }}</span><span>{{ label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.mobile-tabbar { display: none; }
@media (max-width: 767px) { .mobile-tabbar { position: absolute; inset: auto 0 0; z-index: 20; display: grid; grid-template-columns: repeat(6, 1fr); height: calc(var(--tabbar-h) + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); background: rgba(6,7,10,.98); border-top: 1px solid var(--line); }.mobile-tabbar button { position: relative; border: 0; border-radius: 0; background: transparent; padding: 3px 0 2px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; color: var(--muted); font-size: 10px; }.mobile-tabbar button.on { color: var(--text); }.mobile-tabbar button.on::before { content: ''; position: absolute; top: 0; left: 20%; right: 20%; height: 3px; background: var(--team); transform: skewX(var(--skew)); box-shadow: 0 0 9px var(--team-glow); }.tab-icon { height: 22px; font: 800 19px/1 var(--font-display); color: currentColor; }.mobile-tabbar button.on .tab-icon { color: var(--team-ink); } }
</style>
