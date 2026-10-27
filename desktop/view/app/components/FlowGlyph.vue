<script setup lang="ts">
import type { FlowState } from "../../../../src/board-model";
defineProps<{ state: FlowState }>();
const colors: Record<FlowState, string> = {
  done: "text-success",
  running: "text-info",
  "needs-you": "text-warning",
  waiting: "text-muted",
  failed: "text-error",
  stopped: "text-muted",
  "not-run": "text-dimmed",
  expected: "text-muted",
};
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    class="size-5 shrink-0"
    :class="colors[state]"
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <template
      v-if="state === 'done' || state === 'failed' || state === 'stopped' || state === 'needs-you'"
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <g :class="state === 'needs-you' ? 'text-neutral-950' : 'text-inverted'">
        <path v-if="state === 'done'" d="m7 12 3 3 7-7" />
        <path v-else-if="state === 'failed'" d="m8 8 8 8m0-8-8 8" />
        <rect
          v-else-if="state === 'stopped'"
          x="8"
          y="8"
          width="8"
          height="8"
          rx="1"
          fill="currentColor"
          stroke="none"
        />
        <template v-else>
          <path d="M12 6v7" />
          <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
        </template>
      </g>
    </template>
    <g v-else-if="state === 'running'" class="flow-turn">
      <circle cx="12" cy="12" r="10" class="opacity-30" />
      <path d="M12 2a10 10 0 0 1 10 10" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </g>
    <template v-else>
      <circle cx="12" cy="12" r="10" :stroke-dasharray="state === 'expected' ? '3 3' : undefined" />
      <path v-if="state === 'waiting'" d="M12 7v5l3 2" />
      <path v-else-if="state === 'not-run'" d="m5 5 14 14" />
    </template>
  </svg>
</template>

<style scoped>
.flow-turn {
  transform-origin: center;
  /* Stepped: Desktop composites in software, where a smooth turn repaints every frame. */
  animation: flow-turn 6s steps(12) infinite;
}
@keyframes flow-turn {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .flow-turn {
    animation: none;
  }
}
</style>
