<script setup lang="ts">
import { nodeName, type inspectorOf, type FlowSelection } from "../../../src/shared/flow";
defineProps<{
  info: NonNullable<ReturnType<typeof inspectorOf>>;
  selected: FlowSelection;
  /** Above the work rather than beside it, so its details and runs wait behind a toggle. */
  stacked: boolean;
}>();
const emit = defineEmits<{
  close: [];
  item: [id: string | null];
  open: [run: string, tab: string];
}>();
const unfolded = ref(false);
const labels = {
  plan: "Plan",
  review: "Review",
  evidence: "Evidence",
  mr: "Merge request",
  terminal: "Terminal",
  log: "Log",
};
</script>

<template>
  <section
    data-flow-inspector
    class="flex min-h-0 flex-1 flex-col gap-3"
    aria-label="Step inspector"
  >
    <header class="flex shrink-0 items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="flex items-center gap-2 font-semibold">
          <FlowGlyph :state="info.state" /><span class="min-w-0 truncate">{{ info.title }}</span>
          <span class="shrink-0 text-sm font-normal text-muted">{{
            info.state.replaceAll("-", " ")
          }}</span>
        </h3>
        <p v-if="info.timing || info.said" class="text-sm">{{ info.timing ?? info.said }}</p>
        <p v-if="info.node.long" class="text-sm text-warning">Longer than usual</p>
      </div>
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        aria-label="Close inspector"
        @click="emit('close')"
      />
    </header>
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <slot name="actions" />
      <UButton
        v-if="stacked"
        color="neutral"
        variant="ghost"
        size="sm"
        :trailing-icon="unfolded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="info.entries.length > 0 ? 'Details and runs' : 'Details'"
        :aria-expanded="unfolded"
        aria-controls="flow-context-body"
        @click="unfolded = !unfolded"
      />
    </div>
    <div
      v-show="!stacked || unfolded"
      id="flow-context-body"
      class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
      data-testid="flow-context-body"
    >
      <details class="group text-sm" data-testid="flow-details">
        <summary class="cursor-pointer text-muted hover:text-highlighted">Details</summary>
        <div class="mt-2 flex flex-col gap-1">
          <p
            v-for="line in info.lines.filter((line) => line !== info.timing)"
            :key="line"
            class="text-xs text-muted"
          >
            {{ line }}
          </p>
          <slot />
          <p v-if="info.description" class="mt-1">{{ info.description }}</p>
        </div>
      </details>
      <UButton
        v-if="selected.item !== null"
        class="self-start"
        variant="link"
        label="All runs of this Step"
        @click="emit('item', null)"
      />
      <ol v-if="info.entries.length > 0" class="flex flex-col gap-1" aria-label="Runs of this Step">
        <li v-for="(entry, at) in info.entries" :key="at">
          <component
            :is="entry.folded ? 'details' : 'div'"
            :open="entry.nodes.some((node) => node.id === selected.item)"
            :role="entry.wave === undefined ? undefined : 'group'"
            :aria-label="entry.wave === undefined ? undefined : entry.title"
          >
            <h4 v-if="entry.wave !== undefined" class="mt-2 mb-1 text-xs font-semibold text-muted">
              {{ entry.title }}
            </h4>
            <summary v-if="entry.folded" class="cursor-pointer text-sm text-muted">
              {{ entry.title }}
            </summary>
            <button
              v-for="node in entry.nodes"
              :key="node.id"
              type="button"
              class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
              :class="{ 'bg-elevated': node.id === selected.item }"
              :aria-label="nodeName(node)"
              :title="node.title"
              :aria-pressed="node.id === selected.item"
              @click="emit('item', node.id)"
            >
              <FlowGlyph :state="node.state" /><span class="min-w-0 truncate text-sm">{{
                node.title
              }}</span
              ><span class="shrink-0 text-xs text-muted">{{ node.said }}</span
              ><UIcon v-if="node.link !== undefined" name="i-lucide-arrow-up-right" />
            </button>
          </component>
        </li>
      </ol>
      <slot name="notes" />
      <UButton
        v-if="info.open.tab === 'plan' || info.open.tab === 'review' || info.open.tab === 'mr'"
        variant="link"
        class="self-start px-0"
        :label="`Open in ${labels[info.open.tab] ?? info.open.tab}`"
        @click="emit('open', info.open.run, info.open.tab)"
      />
    </div>
  </section>
</template>
