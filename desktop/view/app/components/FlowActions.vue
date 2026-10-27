<script setup lang="ts">
import type { FlowLane, FlowRun } from "../../../../src/board-model";
import {
  desktopFlowAction,
  desktopLaneAction,
  type FlowActionView,
} from "../../../src/shared/flow-actions";
const props = defineProps<{ node: FlowRun; lane: FlowLane; installation: string; live: boolean }>();
const emit = defineEmits<{ act: [action: FlowActionView] }>();
const primary = computed(() =>
  props.node.primary == null
    ? null
    : desktopFlowAction(props.node.primary, props.node, props.lane, props.installation, props.live),
);
const item = (one: FlowActionView) => ({
  label: one.label,
  icon: one.icon,
  onSelect: () => emit("act", one),
});
const menu = computed(() =>
  [
    primary.value,
    ...(props.node.actions ?? []).map((kind) =>
      desktopFlowAction(kind, props.node, props.lane, props.installation, props.live),
    ),
  ].flatMap((one) => (one === null ? [] : [item(one)])),
);
const laneMenu = computed(() =>
  (props.lane.actions ?? []).flatMap((kind) => {
    const one = desktopLaneAction(kind, props.lane, props.installation, props.live);
    return one === null ? [] : [item(one)];
  }),
);
</script>

<template>
  <div v-if="menu.length > 0 || laneMenu.length > 0" class="flex flex-col gap-2">
    <p v-if="primary?.caption" class="text-xs text-muted">{{ primary.caption }}</p>
    <div class="flex flex-wrap gap-2">
      <UButton
        v-if="primary"
        :label="primary.label"
        :icon="primary.icon"
        :color="primary.color"
        variant="outline"
        size="sm"
        @click="emit('act', primary)"
      />
      <UDropdownMenu v-if="menu.length > 0" :items="menu"
        ><UButton
          icon="i-lucide-ellipsis"
          aria-label="Step actions"
          color="neutral"
          variant="ghost"
          size="sm"
      /></UDropdownMenu>
      <UDropdownMenu v-if="laneMenu.length > 0" :items="laneMenu"
        ><UButton
          label="Run controls"
          trailing-icon="i-lucide-chevron-down"
          color="neutral"
          variant="ghost"
          size="sm"
      /></UDropdownMenu>
    </div>
  </div>
</template>
