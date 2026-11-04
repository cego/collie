<script setup lang="ts">
import type { ComponentPublicInstance } from "vue";
import * as Arr from "effect/Array";
import type { FlowNode } from "../../../../src/board-model";
import type { FlowActionView } from "../../../src/shared/flow-actions";
import type { FlowSpot } from "../../../src/shared/flow";
import type { NodeView } from "../composables/useFlowNodes";

// Its own component, with props that keep their identity, so a change elsewhere in the Flow
// does not draw this Step's menu and tooltip again.
const props = defineProps<{
  run: string;
  node: FlowNode;
  view: NodeView;
  rail: boolean;
  joined: boolean;
  current: boolean;
  selected: boolean;
  focused: boolean;
  dimmed: boolean;
  remember: (spot: FlowSpot, element: Element | ComponentPublicInstance | null) => void;
}>();
const emit = defineEmits<{
  choose: [spot: FlowSpot];
  focus: [spot: FlowSpot];
  act: [action: FlowActionView, spot: FlowSpot];
}>();
const spot = computed(() => ({ run: props.run, node: props.node.id }));
const menu = computed(() =>
  Arr.map(props.view.menu, (one) => ({
    label: one.label,
    icon: one.icon,
    onSelect: () => emit("act", one, spot.value),
  })),
);
</script>

<template>
  <li class="relative flex" :class="{ 'max-w-64 shrink-0': rail }">
    <span
      aria-hidden="true"
      class="absolute top-1/2 right-full flex w-6 items-center justify-center"
    >
      <span
        v-if="joined"
        class="w-full border-t-2 border-default"
        :class="{ 'border-dashed': node.state === 'expected' }"
      />
      <UIcon
        v-if="view.steering.pause !== null"
        name="i-lucide-pause"
        class="absolute bg-default text-highlighted"
      />
    </span>
    <div class="relative min-w-0 flex-1">
      <UContextMenu :items="menu" :disabled="menu.length === 0"
        ><UTooltip
          :text="view.hover"
          :delay-duration="300"
          :ui="{ content: 'whitespace-pre-line' }"
        >
          <button
            :ref="(el) => remember(spot, el)"
            type="button"
            class="flex w-full items-center gap-2 rounded border bg-default px-2.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-primary"
            :class="[
              rail ? 'min-h-9' : 'min-h-12',
              node.state === 'failed'
                ? 'border-2 border-error'
                : node.state === 'needs-you'
                  ? 'border-2 border-warning'
                  : current
                    ? 'border-2 border-info'
                    : 'border-default',
              {
                'border-dashed': node.state === 'expected' || node.kind === 'offer',
                'bg-muted': node.link !== undefined,
                'border-success': node.kind === 'offer',
                'ring-2 ring-primary/30': selected,
                'pr-11': view.primary !== null,
                'opacity-50': dimmed,
              },
            ]"
            :tabindex="focused ? 0 : -1"
            :aria-label="view.name"
            :aria-current="current ? 'step' : undefined"
            :aria-pressed="selected"
            @focus="emit('focus', spot)"
            @click="emit('choose', spot)"
          >
            <FlowGlyph :state="node.state" />
            <span class="min-w-0 flex-1" :class="{ 'flex items-baseline gap-2': rail }"
              ><span
                class="block truncate text-sm font-semibold"
                :class="{ 'max-w-40 shrink-0': rail }"
                >{{ node.title }}</span
              ><span
                v-if="view.steering.badge !== null"
                class="inline-block shrink-0 rounded-full bg-elevated px-2 text-xs"
                :class="{ 'mt-1': !rail }"
                >{{ view.steering.badge }}</span
              ><span
                v-if="node.said && (node.state !== 'expected' || node.pause != null)"
                class="block truncate text-xs text-muted"
                >{{ node.said }}</span
              ><span
                v-if="dimmed && node.link?.asOf != null"
                class="block truncate text-xs text-muted"
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
        v-if="view.primary !== null"
        :icon="view.primary.icon"
        :color="view.primary.color"
        :aria-label="view.primary.label"
        variant="outline"
        size="xs"
        tabindex="-1"
        class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full"
        @click="emit('act', view.primary!, spot)"
      />
    </div>
  </li>
</template>
