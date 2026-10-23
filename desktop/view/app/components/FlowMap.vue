<script setup lang="ts">
import type { ComponentPublicInstance } from "vue";
import type { Flow, FlowRun } from "../../../../src/board-model";
import { stepSteering } from "../../../src/shared/step-steering";
import {
  desktopFlowAction,
  desktopLaneAction,
  type FlowActionView,
} from "../../../src/shared/flow-actions";
import {
  cardForLink,
  flowRows,
  inspectorOf,
  isFlowMenuKey,
  nodeName,
  type FlowCard,
  type FlowSelection,
  type FlowSpot,
} from "../../../src/shared/flow";
const props = defineProps<{
  flow: Flow;
  focused: FlowSpot | null;
  selected: FlowSelection | null;
  cards: ReadonlyArray<FlowCard>;
  away: ReadonlySet<string>;
  now: number;
  installation: string;
  live: boolean;
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
const rowFor = (run: string) =>
  props.flow.lanes.find((row) => row.run === run) ?? props.flow.lanes.at(-1);
const primary = (run: string, node: FlowRun) => {
  const row = rowFor(run);
  return row === undefined || node.primary == null
    ? null
    : desktopFlowAction(node.primary, node, row, props.installation, props.live);
};
const menu = (run: string, node: FlowRun) => {
  const row = rowFor(run);
  if (row === undefined) return [];
  return [node.primary, ...(node.actions ?? [])].flatMap((kind) => {
    if (kind == null) return [];
    const one = desktopFlowAction(kind, node, row, props.installation, props.live);
    return one === null
      ? []
      : [
          {
            label: one.label,
            icon: one.icon,
            onSelect: () => emit("act", one, { run, node: node.id }),
          },
        ];
  });
};
const laneMenu = (run: string) => {
  const row = props.flow.lanes.find((one) => one.run === run);
  return (row?.actions ?? []).flatMap((kind) => {
    const one =
      row === undefined ? null : desktopLaneAction(kind, row, props.installation, props.live);
    return one === null
      ? []
      : [{ label: one.label, icon: one.icon, onSelect: () => emit("act", one) }];
  });
};
const name = (run: string, node: FlowRun) =>
  [
    nodeName(node, {
      missing: node.link !== undefined && cardForLink(node, props.cards) === undefined,
      notLive: node.link?.machine != null && props.away.has(node.link.machine),
      action: primary(run, node)?.label,
    }),
    stepSteering(node).pause,
    stepSteering(node).badge,
  ]
    .filter(Boolean)
    .join(". ");
const hover = (run: string, node: string) => {
  const info = inspectorOf(props.flow, { run, node, item: null }, props.now);
  return info === null
    ? ""
    : [info.title, info.state.replaceAll("-", " "), info.said, ...info.lines]
        .filter(Boolean)
        .join("\n");
};
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
defineExpose({
  focus: (spot: FlowSpot) => buttons.get(keyOf(spot))?.focus(),
  reveal: (spot: FlowSpot) =>
    buttons.get(keyOf(spot))?.scrollIntoView({ block: "nearest", inline: "nearest" }),
  menu: (spot: FlowSpot) => showMenu(buttons.get(keyOf(spot))),
});
</script>

<template>
  <div role="group" aria-label="Flow" class="max-h-96 shrink-0 overflow-auto">
    <section
      v-for="row in rows"
      :key="row.run"
      role="group"
      :aria-label="row.name"
      class="flex min-w-max items-center border-t border-default py-3 first:border-0"
    >
      <div class="sticky left-0 z-10 w-36 shrink-0 bg-default pr-3">
        <h3 class="text-sm font-semibold">
          <UContextMenu :items="laneMenu(row.run)" :disabled="laneMenu(row.run).length === 0"
            ><UDropdownMenu :items="laneMenu(row.run)" :disabled="laneMenu(row.run).length === 0"
              ><button
                type="button"
                tabindex="-1"
                class="text-left hover:underline"
                @keydown="rowKey"
              >
                {{ row.title }}
              </button></UDropdownMenu
            ></UContextMenu
          >
        </h3>
        <p class="text-xs text-muted">{{ row.machine }}</p>
        <p class="text-xs text-muted">{{ row.execution }}</p>
        <button
          v-if="row.requestedBy"
          type="button"
          tabindex="-1"
          class="text-left text-xs text-primary hover:underline"
          @click="emit('origin', row.requestedBy.run, row.requestedBy.machine.name)"
        >
          Started by {{ row.requestedBy.run }} on {{ row.requestedBy.machine.name }}
        </button>
        <button
          v-else-if="row.startedBy"
          type="button"
          tabindex="-1"
          class="text-left text-xs text-primary hover:underline"
          @click="emit('origin', row.startedBy.run, row.machine)"
        >
          Started by {{ row.startedBy.run
          }}<template v-if="row.startedBy.step"> · {{ row.startedBy.step }}</template>
        </button>
      </div>
      <ol class="flex items-center">
        <li v-for="(node, at) in row.nodes" :key="node.id" class="flex items-center">
          <UIcon
            v-if="stepSteering(node).pause !== null"
            name="i-lucide-pause"
            class="mx-1 shrink-0 text-highlighted"
            aria-hidden="true"
          />
          <span
            v-if="at > 0"
            aria-hidden="true"
            class="w-5 border-t-2 border-default"
            :class="{ 'border-dashed': node.state === 'expected' }"
          />
          <div class="relative">
            <UContextMenu :items="menu(row.run, node)" :disabled="menu(row.run, node).length === 0"
              ><UTooltip
                :text="hover(row.run, node.id)"
                :delay-duration="300"
                :ui="{ content: 'whitespace-pre-line' }"
              >
                <button
                  :ref="(el) => remember({ run: row.run, node: node.id }, el)"
                  type="button"
                  class="flex min-h-14 w-44 items-center gap-2 rounded border bg-default px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-primary"
                  :class="[
                    node.state === 'failed'
                      ? 'border-2 border-error'
                      : node.state === 'needs-you'
                        ? 'border-2 border-warning'
                        : matches(flow.current, row.run, node.id)
                          ? 'border-2 border-info'
                          : 'border-default',
                    {
                      'border-dashed': node.state === 'expected' || node.kind === 'offer',
                      'bg-muted': node.link !== undefined,
                      'border-success': node.kind === 'offer',
                      'ring-2 ring-primary/30': matches(selected, row.run, node.id),
                      'pr-11': primary(row.run, node) !== null,
                      'opacity-50': node.link?.machine != null && away.has(node.link.machine),
                    },
                  ]"
                  :tabindex="matches(focused, row.run, node.id) ? 0 : -1"
                  :aria-label="name(row.run, node)"
                  :aria-current="matches(flow.current, row.run, node.id) ? 'step' : undefined"
                  :aria-pressed="matches(selected, row.run, node.id)"
                  @focus="emit('focus', { run: row.run, node: node.id })"
                  @click="emit('choose', { run: row.run, node: node.id })"
                >
                  <FlowGlyph :state="node.state" />
                  <span class="min-w-0"
                    ><span class="block text-sm font-semibold">{{ node.title }}</span
                    ><span
                      v-if="stepSteering(node).badge !== null"
                      class="mt-1 inline-block rounded-full bg-elevated px-2 text-xs"
                      >{{ stepSteering(node).badge }}</span
                    ><span
                      v-if="node.said && (node.state !== 'expected' || node.pause != null)"
                      class="block text-xs text-muted"
                      >{{ node.said }}</span
                    ><span
                      v-if="
                        node.link?.machine != null &&
                        away.has(node.link.machine) &&
                        node.link.asOf != null
                      "
                      class="block text-xs text-muted"
                      >as of {{ node.link.asOf }}</span
                    ></span
                  >
                  <UIcon
                    v-if="node.link !== undefined"
                    name="i-lucide-arrow-up-right"
                    class="ml-auto shrink-0 text-muted"
                  />
                </button> </UTooltip
            ></UContextMenu>
            <UButton
              v-if="primary(row.run, node) !== null"
              :icon="primary(row.run, node)!.icon"
              :color="primary(row.run, node)!.color"
              :aria-label="primary(row.run, node)!.label"
              variant="outline"
              size="xs"
              tabindex="-1"
              class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full"
              @click="emit('act', primary(row.run, node)!, { run: row.run, node: node.id })"
            />
          </div>
        </li>
      </ol>
    </section>
  </div>
</template>
