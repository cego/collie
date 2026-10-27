<script setup lang="ts">
import type { Flow, FlowRun, RunDetail } from "../../../../src/board-model";
import type { PlacedTask } from "../../../src/shared/flock";
import type { FlowSelection } from "../../../src/shared/flow";
import {
  inspectorPart,
  inspectorParts,
  quietWork,
  shownPart,
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
  focusing: boolean;
  /** Nothing above it in the work pane, so it says when it has nothing to show. */
  alone: boolean;
}>();
const emit = defineEmits<{ open: [run: string, tab: string, agent?: string]; focus: [] }>();
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
const showing = computed(() => shownPart(part.value, parts.value));
const full = computed(() =>
  showing.value === "terminal" && live.value
    ? "Full Terminal"
    : showing.value === "log"
      ? "Full Log"
      : showing.value === "evidence" && detail.value !== null
        ? "Full Evidence"
        : null,
);
const openFull = () =>
  showing.value === "terminal"
    ? emit("open", run.value, "terminal", props.node.agent ?? undefined)
    : emit("open", run.value, showing.value);
</script>

<template>
  <TerminalTab
    v-if="showing === 'terminal' && live && shown"
    :key="`${run} ${node.agent}`"
    class="min-h-0 flex-1"
    :placed="placed"
    :went-to-pane="false"
    :agent="node.agent ?? undefined"
    @focus="emit('focus')"
  >
    <template #lead
      ><StepParts
        :parts="parts"
        :part="showing"
        :node="node"
        :focusing="focusing"
        @pick="part = $event"
    /></template>
    <template #tail
      ><StepTools :full="full" :focusing="focusing" @full="openFull" @focus="emit('focus')"
    /></template>
  </TerminalTab>
  <div v-else class="flex min-h-0 flex-1 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StepParts
        :parts="parts"
        :part="showing"
        :node="node"
        :focusing="focusing"
        @pick="part = $event"
      />
      <StepTools :full="full" :focusing="focusing" @full="openFull" @focus="emit('focus')" />
    </div>
    <template v-if="showing === 'log' && detail !== null">
      <p v-if="log.older !== null" class="text-sm text-muted">{{ log.older }}</p>
      <LogTab :tail="log.panel" fill class="min-h-0 flex-1" />
    </template>
    <div
      v-else-if="showing === 'evidence' && detail !== null"
      class="min-h-0 flex-1 overflow-y-auto"
    >
      <EvidenceTab :detail="detail" :installation="placed.installation" :verifications="proofs" />
    </div>
    <p v-else-if="detail === null && showing !== 'terminal'" class="text-sm text-muted">
      Loading this Run's work…
    </p>
    <p v-else-if="parts.length === 0 && alone" class="text-sm text-muted" data-testid="flow-quiet">
      {{ quietWork(node) }}
    </p>
  </div>
</template>
