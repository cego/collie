<script setup lang="ts">
import type { Flow, FlowRun, RunDetail } from "../../../../src/board-model";
import type { PlacedTask } from "../../../src/shared/flock";
import type { FlowSelection } from "../../../src/shared/flow";
import {
  inspectorPart,
  inspectorParts,
  stepEvidence,
  stepLines,
  type InspectorPart,
} from "../../../src/shared/step-inspector";
const props = defineProps<{
  flow: Flow;
  node: FlowRun;
  selected: FlowSelection;
  detail: RunDetail | null;
  placed: PlacedTask;
  shown: boolean;
  asked: { part: InspectorPart; serial: number } | null;
}>();
const emit = defineEmits<{ open: [run: string, tab: string, agent?: string] }>();
const row = computed(
  () => props.flow.lanes.find((one) => one.run === props.selected.run) ?? props.flow.lanes.at(-1),
);
const run = computed(() => row.value?.run ?? props.placed.task.run);
const detail = computed(() => (props.detail?.id === run.value ? props.detail : null));
const placed = computed(() => ({
  ...props.placed,
  task: { ...props.placed.task, run: run.value },
}));
const live = computed(
  () =>
    props.placed.asOf === null &&
    props.node.agent != null &&
    props.placed.task.agents.some((one) => one.name === props.node.agent),
);
const starts = computed(() =>
  (row.value?.nodes ?? [])
    .flatMap((node) => [node.log, ...node.runs.map((one) => one.log)])
    .filter((line): line is number => line != null),
);
const log = computed(() =>
  stepLines(detail.value?.tail ?? null, detail.value?.logStart ?? 1, props.node.log, starts.value),
);
const proofs = computed(() =>
  stepEvidence(
    detail.value?.verifications ?? [],
    props.selected.node,
    props.selected.item === null ? null : props.node,
  ),
);
const parts = computed(() =>
  inspectorParts(props.node, live.value, log.value.count, proofs.value.length),
);
const part = ref<InspectorPart>(inspectorPart(props.node, live.value));
watch(
  () => [props.selected.run, props.selected.node, props.selected.item],
  () => (part.value = inspectorPart(props.node, live.value)),
);
watch(
  () => props.asked,
  (asked) => {
    if (asked !== null) part.value = asked.part;
  },
  { immediate: true },
);
watch(live, (now) => {
  if (part.value === "terminal" && !now) part.value = inspectorPart(props.node, now);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <div v-if="parts.length > 0" class="flex flex-wrap gap-1" role="group" aria-label="Step work">
      <UButton
        v-for="one in parts"
        :key="one.value"
        :label="one.label"
        :variant="part === one.value ? 'soft' : 'ghost'"
        color="neutral"
        size="sm"
        :aria-pressed="part === one.value"
        @click="part = one.value"
      />
    </div>
    <template v-if="part === 'terminal' && live">
      <TerminalTab
        v-if="shown"
        class="min-h-64"
        :placed="placed"
        :went-to-pane="false"
        :agent="node.agent ?? undefined"
      />
      <UButton
        variant="link"
        class="self-start"
        label="Full Terminal"
        @click="emit('open', run, 'terminal', node.agent ?? undefined)"
      />
    </template>
    <template v-else-if="part === 'log'">
      <p v-if="log.older !== null" class="text-sm text-muted">{{ log.older }}</p>
      <LogTab v-if="detail !== null" :tail="log.panel" />
      <UButton
        variant="link"
        class="self-start"
        label="Full Log"
        @click="emit('open', run, 'log')"
      />
    </template>
    <template v-else-if="part === 'evidence' && detail !== null"
      ><EvidenceTab
        :detail="detail"
        :installation="placed.installation"
        :verifications="proofs" /><UButton
        variant="link"
        class="self-start"
        label="Full Evidence"
        @click="emit('open', run, 'evidence')"
    /></template>
    <p v-if="detail === null && part !== 'terminal'" class="text-sm text-muted">
      Loading this Run's work…
    </p>
  </div>
</template>
