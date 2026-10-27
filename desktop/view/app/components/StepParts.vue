<script setup lang="ts">
import type { FlowRun } from "../../../../src/board-model";
import type { InspectorPart, InspectorTab } from "../../../src/shared/step-inspector";
defineProps<{
  parts: ReadonlyArray<InspectorTab>;
  part: InspectorPart;
  node: FlowRun;
  focusing: boolean;
}>();
const emit = defineEmits<{ pick: [part: InspectorPart] }>();
</script>

<template>
  <span v-if="focusing" class="flex min-w-0 items-center gap-2 text-sm font-semibold">
    <FlowGlyph :state="node.state" /><span class="truncate">{{ node.title }}</span>
  </span>
  <div v-if="parts.length > 0" class="flex shrink-0 gap-1" role="group" aria-label="Step work">
    <UButton
      v-for="one in parts"
      :key="one.value"
      :label="one.label"
      :variant="part === one.value ? 'soft' : 'ghost'"
      color="neutral"
      size="sm"
      :aria-pressed="part === one.value"
      @click="emit('pick', one.value)"
    />
  </div>
</template>
