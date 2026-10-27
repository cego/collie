<script setup lang="ts">
// Every region stays mounted through a resize or Focus, so the terminal keeps its session.
import {
  contextStepped,
  contextWidth,
  railCap,
  railHeight,
  railStepped,
  stacks,
} from "../../../src/shared/flow-layout";
defineProps<{ selected: boolean; focusing: boolean }>();
const chosen = useFlowLayout();
const root = ref<HTMLElement | null>(null);
const rail = ref<HTMLElement | null>(null);
const workspace = ref<HTMLElement | null>(null);
const room = reactive({ width: 0, height: 0, rail: 0 });
let resized: ResizeObserver | undefined;
onMounted(() => {
  resized = new ResizeObserver(() => {
    if (root.value !== null) room.height = root.value.clientHeight;
    if (rail.value !== null) room.rail = rail.value.offsetHeight;
    if (workspace.value !== null && workspace.value.clientWidth > 0)
      room.width = workspace.value.clientWidth;
  });
  for (const box of [root.value, rail.value]) if (box !== null) resized.observe(box);
});
watch(workspace, (box, was) => {
  if (was !== null) resized?.unobserve(was);
  if (box !== null) resized?.observe(box);
});
onBeforeUnmount(() => resized?.disconnect());

const stacked = computed(() => room.width > 0 && stacks(room.width));
const width = computed(() => contextWidth(chosen.context.value, room.width));
const height = computed(() => railHeight(chosen.rail.value, room.height));
const railMax = computed(() => railHeight(Infinity, room.height) ?? 0);

const dragging = ref<{ axis: "x" | "y"; at: number; from: number } | null>(null);
const startDrag = (axis: "x" | "y", event: PointerEvent) => {
  if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  dragging.value =
    axis === "x"
      ? { axis, at: event.clientX, from: width.value }
      : { axis, at: event.clientY, from: room.rail };
};
const drag = (event: PointerEvent) => {
  const start = dragging.value;
  if (start === null) return;
  if (start.axis === "x")
    chosen.context.value = contextWidth(start.from + event.clientX - start.at, room.width);
  else chosen.rail.value = railHeight(start.from + event.clientY - start.at, room.height);
};
const stepContext = (by: 1 | -1) =>
  (chosen.context.value = contextStepped(width.value, room.width, by));
const stepRail = (by: 1 | -1) => (chosen.rail.value = railStepped(room.rail, room.height, by));
const line = (axis: "x" | "y") =>
  dragging.value?.axis === axis
    ? "bg-primary"
    : "bg-(--ui-border) group-hover:bg-primary group-focus-visible:bg-primary";
</script>

<template>
  <div ref="root" class="flex min-h-0 flex-1 flex-col" :class="{ 'gap-4': !selected }">
    <div
      ref="rail"
      v-show="!focusing"
      class="shrink-0"
      :class="{ 'overflow-y-auto': selected }"
      :style="
        selected
          ? height === null
            ? { maxHeight: `${railCap(room.height)}px` }
            : { height: `${height}px` }
          : {}
      "
      data-testid="flow-rail"
    >
      <slot name="map" />
    </div>
    <template v-if="selected">
      <div
        v-show="!focusing"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the Flow map"
        :aria-valuenow="Math.round(room.rail)"
        :aria-valuemin="56"
        :aria-valuemax="Math.round(railMax)"
        tabindex="0"
        title="Drag or use ↑ ↓ to resize; double-click to reset"
        class="group flex h-3 shrink-0 cursor-row-resize touch-none flex-col justify-center outline-none"
        data-testid="flow-rail-resize"
        @pointerdown="startDrag('y', $event)"
        @pointermove="drag"
        @lostpointercapture="dragging = null"
        @dblclick="chosen.rail.value = null"
        @keydown.up.prevent.stop="stepRail(-1)"
        @keydown.down.prevent.stop="stepRail(1)"
      >
        <div class="h-px transition-colors group-hover:h-0.5" :class="line('y')" />
      </div>
      <div
        ref="workspace"
        class="flex min-h-0 flex-1"
        :class="stacked ? 'flex-col gap-3' : 'flex-row'"
        data-testid="flow-workspace"
      >
        <div
          v-show="!focusing"
          class="flex min-h-0 shrink-0 flex-col"
          :class="{ 'max-h-[45%]': stacked }"
          :style="stacked ? {} : { width: `${width}px` }"
          data-testid="flow-context"
        >
          <slot name="context" :stacked="stacked" />
        </div>
        <div
          v-show="!focusing && !stacked"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the Step's details"
          :aria-valuenow="width"
          :aria-valuemin="contextWidth(0, room.width)"
          :aria-valuemax="contextWidth(Infinity, room.width)"
          tabindex="0"
          title="Drag or use ← → to resize; double-click to reset"
          class="group flex w-4 shrink-0 cursor-col-resize touch-none justify-center outline-none"
          data-testid="flow-context-resize"
          @pointerdown="startDrag('x', $event)"
          @pointermove="drag"
          @lostpointercapture="dragging = null"
          @dblclick="chosen.context.value = null"
          @keydown.left.prevent.stop="stepContext(-1)"
          @keydown.right.prevent.stop="stepContext(1)"
        >
          <div class="w-px transition-colors group-hover:w-0.5" :class="line('x')" />
        </div>
        <section
          class="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
          aria-label="Step work"
          data-testid="flow-work"
        >
          <slot name="work" />
        </section>
      </div>
    </template>
    <slot v-else name="empty" />
  </div>
</template>
