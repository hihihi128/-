<script setup lang="ts">
import { computed } from 'vue';
import { store } from '../bridge';

const props = defineProps<{ c: string }>();
const t = computed(() => store.view?.labels.tyres[props.c]);
</script>

<template>
  <span class="tyre" :style="{ borderColor: t?.color ?? '#888', color: t?.color ?? '#888' }" :title="t?.name ?? c">{{ t?.short ?? c }}</span>
</template>

<style scoped>
.tyre {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid;
  font-size: 10px;
  font-weight: 800;
  background: #111;
}
</style>
