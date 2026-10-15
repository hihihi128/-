<script setup lang="ts">
import { computed } from 'vue';
import carBlueprint from '../../../../docs/designs/broadcast-ui/car-topdown.svg?raw';
import type { PartView, ProjectView } from '../../../engine/view';

const props = defineProps<{
  parts: PartView[];
  projects: ProjectView[];
  selected: string;
  lockedParts?: string[];
}>();
const emit = defineEmits<{ select: [partType: string] }>();

const byType = computed(() => new Map(props.parts.map(part => [part.type, part])));
const locked = computed(() => new Set(props.lockedParts ?? []));
const range = computed(() => {
  const values = props.parts.filter(part => !locked.value.has(part.type)).map(part => part.perf);
  if (!values.length) return { min: 0, max: 1 };
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(5, high - low);
  const middle = (low + high) / 2;
  return { min: middle - span / 2, max: middle + span / 2 };
});

function perfClass(part: PartView | undefined, type: string): string {
  if (locked.value.has(type)) return 'perf-locked';
  if (!part) return 'perf-mid';
  const span = Math.max(0.01, range.value.max - range.value.min);
  const score = (part.perf - range.value.min) / span;
  if (score >= 0.76) return 'perf-top';
  if (score >= 0.51) return 'perf-good';
  if (score >= 0.26) return 'perf-mid';
  return 'perf-low';
}
function svg() {
  let result = carBlueprint;
  for (const type of byType.value.keys()) {
    const part = byType.value.get(type)!;
    const state = [perfClass(part, type), props.selected === type ? 'is-selected' : '', props.projects.some(project => project.partType === type) ? 'is-rnd' : '', part.version > 1 ? 'is-new' : ''].filter(Boolean).join(' ');
    result = result.replace(new RegExp(`(id="(?:part|label)-${type}" class="[^"]*)"`, 'g'), `$1 ${state}"`);
    const value = locked.value.has(type) ? '锁定' : part.verified ? part.perf.toFixed(1) : part.expected ? `${part.expected[0]}~${part.expected[1]}` : '—';
    result = result.replace(new RegExp(`(<text[^>]*id="val-${type}"[^>]*>)[^<]*(</text>)`), `$1${value}$2`);
    if (locked.value.has(type)) {
      result = result.replace(new RegExp(`(id="part-${type}"[^>]*?)tabindex="0"`), '$1tabindex="-1" aria-disabled="true"');
    }
  }
  return result;
}
function select(event: MouseEvent | KeyboardEvent) {
  const target = event.target as Element | null;
  const node = target?.closest<SVGGElement>('[data-part]');
  const type = node?.dataset.part;
  if (type && !locked.value.has(type)) emit('select', type);
}
</script>

<template>
  <div class="carbox" @click="select" @keydown.enter.prevent="select" @keydown.space.prevent="select" v-html="svg()"></div>
</template>

<style scoped>
.carbox { position: relative; background: radial-gradient(ellipse at 50% 45%, rgba(127,220,255,.08), transparent 70%), #05080d; border: 1px solid #12202c; padding: 4px; }
.carbox :deep(.car-svg) { display: block; width: 100%; height: auto; }
</style>
