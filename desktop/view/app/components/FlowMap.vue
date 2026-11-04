<script setup lang="ts">
import type { ComponentPublicInstance } from "vue";
import * as Arr from "effect/Array";
import type { Flow } from "../../../../src/board-model";
import type { FlowActionView } from "../../../src/shared/flow-actions";
import {
  flowRows,
  isFlowMenuKey,
  type FlowCard,
  type FlowSelection,
  type FlowSpot,
} from "../../../src/shared/flow";
import { nodeKey, useFlowNodes } from "../composables/useFlowNodes";
import { CLOSED, tipAfter, type StepTip, type TipEvent } from "../../../src/shared/step-tip";
const props = defineProps<{
  flow: Flow;
  focused: FlowSpot | null;
  selected: FlowSelection | null;
  cards: ReadonlyArray<FlowCard>;
  away: ReadonlySet<string>;
  now: number;
  installation: string;
  live: boolean;
  /** Each Run on one line, its Steps scrolling along it, beside the selected Step's work. */
  rail: boolean;
}>();
const emit = defineEmits<{
  choose: [spot: FlowSpot];
  focus: [spot: FlowSpot];
  origin: [run: string, machine: string];
  act: [action: FlowActionView, spot?: FlowSpot];
}>();
const rows = computed(() => flowRows(props.flow));
const buttons = new Map<string, HTMLElement>();
const keyOf = (spot: FlowSpot) => JSON.stringify([spot.run, spot.node]);
const remember = (spot: FlowSpot, element: Element | ComponentPublicInstance | null) => {
  if (element instanceof HTMLElement) buttons.set(keyOf(spot), element);
  else buttons.delete(keyOf(spot));
};
const drawn = useFlowNodes(props);
/** What is drawn of a node, which every node of `rows` has. */
const view = (run: string, node: string) => drawn.value.nodes[nodeKey(run, node)]!;
const laneMenu = (run: string) => drawn.value.laneMenus[run] ?? [];

/** The Step a DOM event is on, read from the attributes FlowStep sets on its button. */
const stepOf = (target: EventTarget | null): FlowSpot | null => {
  const button = target instanceof Element ? target.closest("[data-step-node]") : null;
  const run = button?.getAttribute("data-step-run");
  const node = button?.getAttribute("data-step-node");
  return run == null || node == null ? null : { run, node };
};
const laneOf = (target: EventTarget | null) =>
  (target instanceof Element ? target.closest("[data-lane-run]") : null)?.getAttribute(
    "data-lane-run",
  ) ?? null;

// One menu for every Step and lane, aimed at what was right-clicked, rather than one each.
const menuFor = shallowRef<{ actions: ReadonlyArray<FlowActionView>; spot?: FlowSpot }>({
  actions: [],
});
const menu = computed(() =>
  Arr.map(menuFor.value.actions, (one) => ({
    label: one.label,
    icon: one.icon,
    onSelect: () => {
      const spot = menuFor.value.spot;
      if (spot === undefined) emit("act", one);
      else emit("act", one, spot);
    },
  })),
);
const aimMenu = (event: MouseEvent) => {
  const spot = stepOf(event.target);
  const lane = spot === null ? laneOf(event.target) : null;
  const actions =
    spot !== null ? view(spot.run, spot.node).menu : lane !== null ? laneMenu(lane) : [];
  menuFor.value = spot === null ? { actions } : { actions, spot };
  // Where there is nothing to offer, the window's own menu shows, as a disabled menu left it.
  if (actions.length === 0) event.stopPropagation();
};
const laneItems = (run: string) =>
  Arr.map(laneMenu(run), (one) => ({
    label: one.label,
    icon: one.icon,
    onSelect: () => emit("act", one),
  }));

// One tooltip for every Step, rather than one each; `tipAfter` decides when it shows.
const tip = shallowRef<StepTip>(CLOSED);
let due: ReturnType<typeof setTimeout> | undefined;
const send = (event: TipEvent) => {
  const next = tipAfter(tip.value, event);
  if (next.tip.waiting !== tip.value.waiting) clearTimeout(due);
  tip.value = next.tip;
  const waiting = next.tip.waiting;
  if (next.wait !== null && waiting !== null)
    due = setTimeout(() => send({ kind: "due", step: waiting }), next.wait);
};
onBeforeUnmount(() => clearTimeout(due));
const tipButton = computed(() =>
  tip.value.open === null ? null : (buttons.get(tip.value.open) ?? null),
);
const tipText = computed(() => {
  const spot = stepOf(tipButton.value);
  // A Step the Flow no longer has may still be the one hovered.
  return spot === null ? "" : (drawn.value.nodes[nodeKey(spot.run, spot.node)]?.hover ?? "");
});
const stepKey = (target: EventTarget | null) => {
  const spot = stepOf(target);
  return spot === null ? null : keyOf(spot);
};
const tipOver = (event: PointerEvent) => {
  const step = stepKey(event.target);
  if (event.pointerType !== "touch" && step !== null && step !== stepKey(event.relatedTarget))
    send({ kind: "enter", step, at: event.timeStamp });
};
const tipOut = (event: PointerEvent) => {
  const step = stepKey(event.target);
  if (step !== null && step !== stepKey(event.relatedTarget))
    send({ kind: "leave", at: event.timeStamp });
};
const tipFocus = (event: FocusEvent) => {
  const step = stepKey(event.target);
  if (step !== null) send({ kind: "focus", step });
};
const tipBlur = (event: FocusEvent) => {
  if (stepKey(event.target) !== null) send({ kind: "blur", at: event.timeStamp });
};
const tipPress = (event: PointerEvent) => {
  if (stepKey(event.target) === null) return;
  send({ kind: "press", at: event.timeStamp });
  document.addEventListener("pointerup", () => send({ kind: "release" }), { once: true });
};
const tipClick = (event: MouseEvent) => {
  if (stepKey(event.target) !== null) send({ kind: "dismiss", at: event.timeStamp });
};
const tipShown = (open: boolean) => open || send({ kind: "dismiss", at: Number.NEGATIVE_INFINITY });
const onFocus = (spot: FlowSpot) => emit("focus", spot);
const onChoose = (spot: FlowSpot) => emit("choose", spot);
const onAct = (action: FlowActionView, spot: FlowSpot) => emit("act", action, spot);
const matches = (spot: FlowSpot | null, run: string, node: string) =>
  spot?.run === run && spot.node === node;
const showMenu = (element: HTMLElement | undefined) => {
  if (element === undefined) return;
  const box = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.bottom,
    }),
  );
};
const rowKey = (event: KeyboardEvent) => {
  if (!isFlowMenuKey(event.key, event.shiftKey)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.currentTarget instanceof HTMLElement) showMenu(event.currentTarget);
};
const reveal = (spot: FlowSpot) =>
  buttons.get(keyOf(spot))?.scrollIntoView({ block: "nearest", inline: "nearest" });
// A map that changes size, with the window or the inspector, keeps the selected Step in view.
const box = ref<HTMLElement | null>(null);
let resized: ResizeObserver | undefined;
onMounted(() => {
  resized = new ResizeObserver(() => props.selected !== null && reveal(props.selected));
  if (box.value !== null) resized.observe(box.value);
});
onBeforeUnmount(() => resized?.disconnect());
defineExpose({
  focus: (spot: FlowSpot) => buttons.get(keyOf(spot))?.focus(),
  reveal,
  menu: (spot: FlowSpot) => showMenu(buttons.get(keyOf(spot))),
});
</script>

<template>
  <UContextMenu :items="menu"
    ><div
      ref="box"
      role="group"
      aria-label="Flow"
      class="overflow-y-auto"
      @contextmenu.capture="aimMenu"
      @pointerover="tipOver"
      @pointerout="tipOut"
      @focusin="tipFocus"
      @focusout="tipBlur"
      @pointerdown.capture="tipPress"
      @click.capture="tipClick"
    >
      <section
        v-for="row in rows"
        :key="row.run"
        role="group"
        :aria-label="row.name"
        class="flex border-t border-default first:border-0 first:pt-0"
        :class="rail ? 'items-center gap-2 py-1.5' : 'flex-col gap-2 py-3'"
      >
        <div
          class="flex text-xs text-muted"
          :class="rail ? 'w-40 shrink-0 flex-col items-start' : 'flex-wrap items-baseline gap-x-2'"
        >
          <h3 class="max-w-full truncate text-sm font-semibold text-highlighted">
            <UDropdownMenu :items="laneItems(row.run)" :disabled="laneMenu(row.run).length === 0"
              ><button
                type="button"
                tabindex="-1"
                :data-lane-run="row.run"
                class="text-left hover:underline"
                @keydown="rowKey"
              >
                {{ row.title }}
              </button></UDropdownMenu
            >
          </h3>
          <span
            :class="{ 'max-w-full truncate': rail }"
            :title="rail ? `${row.machine} · ${row.execution}` : undefined"
            >{{
              rail ? `${row.execution} · ${row.machine}` : `${row.machine} · ${row.execution}`
            }}</span
          >
          <button
            v-if="row.requestedBy"
            type="button"
            tabindex="-1"
            class="max-w-full truncate text-left text-xs text-primary hover:underline"
            @click="emit('origin', row.requestedBy.run, row.requestedBy.machine.name)"
          >
            Started by {{ row.requestedBy.run }} on {{ row.requestedBy.machine.name }}
          </button>
          <button
            v-else-if="row.startedBy"
            type="button"
            tabindex="-1"
            class="max-w-full truncate text-left text-xs text-primary hover:underline"
            @click="emit('origin', row.startedBy.run, row.machine)"
          >
            Started by {{ row.startedBy.run
            }}<template v-if="row.startedBy.step"> · {{ row.startedBy.step }}</template>
          </button>
        </div>
        <ol
          class="gap-x-6 pl-6"
          :class="
            rail
              ? 'flex min-w-0 flex-1 overflow-x-auto py-1 pr-1 [scrollbar-width:thin]'
              : 'grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-y-2'
          "
        >
          <FlowStep
            v-for="(node, at) in row.nodes"
            :key="node.id"
            :run="row.run"
            :node="node"
            :view="view(row.run, node.id)"
            :rail="rail"
            :joined="at > 0"
            :current="matches(flow.current, row.run, node.id)"
            :selected="matches(selected, row.run, node.id)"
            :focused="matches(focused, row.run, node.id)"
            :dimmed="node.link?.machine != null && away.has(node.link.machine)"
            :remember="remember"
            @focus="onFocus"
            @choose="onChoose"
            @act="onAct"
          />
        </ol>
      </section>
      <UTooltip
        :open="tipText !== ''"
        :reference="tipButton ?? undefined"
        :text="tipText"
        :ui="{ content: 'whitespace-pre-line' }"
        @update:open="tipShown"
      /></div
  ></UContextMenu>
</template>
