<script setup lang="ts">
import type { Flow, FlowAction, RunDetail } from "../../../../src/board-model";
import type { InspectorPart } from "../../../src/shared/step-inspector";
import { desktopFlowAction, nextMove, type FlowActionView } from "../../../src/shared/flow-actions";
import type { PlacedTask } from "../../../src/shared/flock";
import type { Gesture } from "../../../src/shared/board-clicks";
import { inField, overlayOpen } from "../../../src/shared/board-clicks";
import {
  flowAnnouncements,
  flowKey,
  flowRows,
  inspectorOf,
  nodeAt,
  rowOrigin,
  selectEntry,
  selectNode,
  type FlowPick,
  type FlowSelection,
  type FlowSpot,
} from "../../../src/shared/flow";
import { workspaceKey } from "../../../src/shared/flow-layout";
const props = defineProps<{
  flow: Flow;
  placed: PlacedTask;
  shown: boolean;
  detail: RunDetail | null;
}>();
const emit = defineEmits<{
  run: [run: string];
  open: [run: string, tab: string, agent?: string];
  focusing: [focusing: boolean];
}>();
const { everyTask, now } = useFlock();
const cards = computed(() =>
  everyTask.value.map((one) => ({ key: one.key, machine: one.machine, runs: one.task.runs })),
);
const away = computed(
  () => new Set(everyTask.value.filter((one) => one.asOf !== null).map((one) => one.machine)),
);
const selected = ref<FlowSelection | null>(null);
const first = () => {
  const row = flowRows(props.flow).find((one) => one.nodes.length > 0);
  return (
    props.flow.current ?? (row === undefined ? null : { run: row.run, node: row.nodes[0]!.id })
  );
};
const focused = ref<FlowSpot | null>(first());
const info = computed(() =>
  selected.value === null ? null : inspectorOf(props.flow, selected.value, now.value),
);
const source = computed(() =>
  selected.value === null ? null : rowOrigin(props.flow, selected.value.run),
);
const map = ref<{
  focus: (spot: FlowSpot) => void;
  reveal: (spot: FlowSpot) => void;
  menu: (spot: FlowSpot) => void;
} | null>(null);
const page = usePage();
const gesture = inject<(done: Gesture, tab?: string) => void>("gesture")!;
const offering = ref<{ run: string; offer: string } | null>(null);
let partSerial = 0;
const requestedPart = ref<{ part: InspectorPart; serial: number } | null>(null);
const controls = useFlowActions(
  () => props.placed,
  (effect) => {
    if (effect.kind === "terminal" || effect.kind === "part") {
      requestedPart.value = {
        part: effect.kind === "terminal" ? "terminal" : effect.part,
        serial: ++partSerial,
      };
      emit("run", effect.run);
    } else if (effect.kind === "run") origin(effect.run, effect.machine ?? props.placed.machine);
    else if (effect.kind === "offer") offering.value = { run: effect.run, offer: effect.offer };
  },
);
const { asking } = controls;
const lane = computed(
  () =>
    props.flow.lanes.find((row) => row.run === selected.value?.run) ??
    (selected.value?.run === "release" ? props.flow.lanes.at(-1) : undefined),
);
const move = computed(() => nextMove(props.flow));
const moveAction = computed(() =>
  move.value === null
    ? null
    : desktopFlowAction(
        move.value.action,
        move.value.node,
        move.value.lane,
        props.placed.installation,
        props.placed.asOf === null,
      ),
);
const decision = computed(() => {
  if (info.value === null || lane.value === undefined || info.value.node.primary == null)
    return null;
  const effect = desktopFlowAction(
    info.value.node.primary,
    info.value.node,
    lane.value,
    props.placed.installation,
    props.placed.asOf === null,
  )?.effect;
  return effect?.kind === "answer" || effect?.kind === "proposal" ? effect : null;
});
const press = (action: FlowActionView, spot?: FlowSpot) =>
  controls.press(action, () => {
    if (spot !== undefined) {
      requestedPart.value = null;
      selected.value = { ...spot, item: null };
      emit("run", spot.run);
    }
  });
const actNode = (kind: FlowAction, spot: FlowSpot) => {
  const node = nodeAt(props.flow, spot);
  const row = props.flow.lanes.find((one) => one.run === spot.run) ?? props.flow.lanes.at(-1);
  if (node === null || row === undefined) return;
  const action = desktopFlowAction(
    kind,
    node,
    row,
    props.placed.installation,
    props.placed.asOf === null,
  );
  if (action !== null) press(action, spot);
};
/** The selected Step's work has the whole record, its tabs, map and details put away. */
const focusing = ref(false);
watch(focusing, (now) => emit("focusing", now));
watch(selected, (now) => now === null && (focusing.value = false));
const close = () => {
  const spot = selected.value;
  selected.value = null;
  requestedPart.value = null;
  if (spot !== null) {
    focused.value = spot;
    void nextTick(() => map.value?.focus(spot));
  }
};
const take = (picked: FlowPick) => {
  switch (picked.kind) {
    case "inspect":
      requestedPart.value = null;
      selected.value = picked.selection;
      emit("run", picked.run);
      break;
    case "close":
      close();
      break;
    case "open":
      gesture({ kind: "name", card: picked.card }, "flow");
      page.showRecord(picked.card, "flow", picked.run);
      break;
    case "offer":
      if (props.placed.asOf === null) offering.value = { run: picked.run, offer: picked.offer };
      break;
  }
};
const choose = (spot: FlowSpot) => take(selectNode(props.flow, spot, selected.value, cards.value));
const chooseItem = (id: string | null) =>
  selected.value !== null && take(selectEntry(props.flow, selected.value, id, cards.value));
const origin = (run: string, machine: string) => {
  const card = cards.value.find((one) => one.machine === machine && one.runs.includes(run));
  if (card !== undefined) take({ kind: "open", card: card.key, run });
};
const key = (event: KeyboardEvent) => {
  const layout = selected.value === null ? null : workspaceKey(event, focusing.value);
  if (layout !== null && !overlayOpen(document)) {
    event.preventDefault();
    event.stopPropagation();
    focusing.value = layout === "focus";
    return;
  }
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    inField(event.target instanceof Element ? event.target : null) ||
    overlayOpen(document) ||
    focused.value === null
  )
    return;
  const move = flowKey(
    props.flow,
    event.key === "Escape" && selected.value !== null ? selected.value : focused.value,
    event.key,
    selected.value !== null,
    event.shiftKey,
  );
  if (move === null) return;
  event.preventDefault();
  event.stopPropagation();
  focused.value = move.focus;
  if (move.close) close();
  else if (move.menu) map.value?.menu(move.focus);
  else if (move.primary) {
    const primary = nodeAt(props.flow, move.focus)?.primary;
    if (primary != null) actNode(primary, move.focus);
  } else if (move.select) choose(move.focus);
  else map.value?.focus(move.focus);
};
const announcement = ref("");
watch(
  () => props.flow,
  (next, previous) => {
    const messages = flowAnnouncements(previous ?? null, next);
    if (messages.length > 0) {
      announcement.value = "";
      void nextTick(() => (announcement.value = messages.join(". ")));
    }
  },
);
watch(selected, async (spot) => {
  if (spot === null) return;
  await nextTick();
  map.value?.reveal(spot);
});
let revealed = false;
watch(
  () => props.shown,
  async (shown) => {
    if (!shown || revealed) return;
    revealed = true;
    await nextTick();
    if (props.flow.current !== null) map.value?.reveal(props.flow.current);
  },
  { immediate: true },
);
</script>

<template>
  <div
    data-testid="flow"
    :data-escape-scope="selected !== null ? '' : undefined"
    class="flex min-h-0 flex-1 flex-col gap-3"
    :class="{ 'opacity-50': placed.asOf !== null }"
    @keydown="key"
  >
    <div
      v-show="!focusing"
      class="flex items-center justify-between gap-3"
      :class="flow.notice ? 'rounded bg-warning/10 px-3 py-2 text-warning' : ''"
    >
      <p class="text-sm">{{ flow.notice ?? placed.task.sentence }}</p>
      <UButton
        v-if="moveAction !== null && flow.current !== null"
        :label="moveAction.label"
        :icon="moveAction.icon"
        :color="moveAction.color"
        variant="outline"
        size="sm"
        @click="press(moveAction, flow.current)"
      />
    </div>
    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement }}</p>
    <FlowWorkspace :selected="info !== null && selected !== null" :focusing="focusing">
      <template #map>
        <FlowMap
          ref="map"
          :flow="flow"
          :focused="focused"
          :selected="selected"
          :cards="cards"
          :away="away"
          :now="now"
          :installation="placed.installation"
          :live="placed.asOf === null"
          :rail="info !== null && selected !== null"
          @choose="choose"
          @focus="focused = $event"
          @origin="origin"
          @act="press"
        />
      </template>
      <template v-if="info !== null && selected !== null" #context="{ stacked }">
        <FlowInspector
          :info="info"
          :selected="selected"
          :stacked="stacked"
          @close="close"
          @item="chooseItem"
          @open="(run, tab) => emit('open', run, tab)"
        >
          <template #actions
            ><FlowActions
              v-if="lane !== undefined"
              :node="info.node"
              :lane="lane"
              :installation="placed.installation"
              :live="placed.asOf === null"
              @act="press"
          /></template>
          <template #notes>
            <FlowNotes
              :node="lane?.nodes.find((node) => node.id === selected?.node) ?? info.node"
              :run="selected.run"
              :installation="placed.installation"
              :live="placed.asOf === null"
              @act="press"
          /></template>
          <template #default
            ><UButton
              v-if="source !== null"
              variant="link"
              size="xs"
              class="self-start p-0"
              :label="`Started by ${source.run} on ${source.machine}`"
              @click="origin(source.run, source.machine)"
          /></template>
        </FlowInspector>
      </template>
      <template v-if="info !== null && selected !== null" #work>
        <section v-if="info.state === 'failed'" class="flex shrink-0 flex-col gap-2">
          <h4 class="text-sm font-semibold">Why it failed</h4>
          <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-elevated p-3 text-xs">{{
            info.node.why ?? info.said
          }}</pre>
        </section>
        <FlowDecision
          v-if="decision !== null"
          class="shrink-0"
          :effect="decision"
          :machine="placed.machine"
          :perform="controls.perform"
        />
        <StepWork
          :flow="flow"
          :node="info.node"
          :selected="selected"
          :detail="detail"
          :placed="placed"
          :shown="shown"
          :asked="requestedPart"
          :focusing="focusing"
          :alone="info.state !== 'failed' && decision === null"
          @open="(run, tab, agent) => emit('open', run, tab, agent)"
          @focus="focusing = !focusing"
        />
      </template>
      <template #empty>
        <p class="text-sm text-muted">
          Select a Step to inspect its work. Use the arrow keys to move between Steps and Runs.
        </p>
      </template>
    </FlowWorkspace>
    <OffersDialog
      v-if="offering !== null"
      :installation="placed.installation"
      :run-id="offering.run"
      :chosen="offering.offer"
      @close="offering = null"
    />
    <TextDialog
      :open="asking !== null"
      :title="asking?.title ?? ''"
      :initial="asking?.initial"
      :send-label="asking?.retry === undefined ? 'Send' : 'Send and retry'"
      @update:open="(open: boolean) => !open && (asking = null)"
      @send="controls.send"
    />
  </div>
</template>
