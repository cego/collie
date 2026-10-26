<script setup lang="ts">
import { nodeName, type inspectorOf, type FlowSelection } from "../../../src/shared/flow";
defineProps<{ info: NonNullable<ReturnType<typeof inspectorOf>>; selected: FlowSelection }>();
const emit = defineEmits<{
  close: [];
  item: [id: string | null];
  open: [run: string, tab: string];
}>();
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
    class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t border-default pt-4"
    aria-label="Step inspector"
  >
    <header class="flex items-start justify-between gap-3">
      <div>
        <h3 class="flex items-center gap-2 font-semibold">
          <FlowGlyph :state="info.state" />{{ info.title }}
          <span class="text-sm font-normal text-muted">{{ info.state.replaceAll("-", " ") }}</span>
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
    <slot name="why" />
    <slot name="actions" />
    <p
      v-for="line in info.lines.filter((line) => line !== info.timing)"
      :key="line"
      class="text-xs text-muted"
    >
      {{ line }}
    </p>
    <slot />
    <p v-if="info.description" class="text-sm">{{ info.description }}</p>
    <slot name="decision" />
    <UButton
      v-if="selected.item !== null"
      class="self-start"
      variant="link"
      label="All runs of this Step"
      @click="emit('item', null)"
    />
    <ol v-if="info.entries.length > 0" class="flex flex-col gap-1">
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
            class="flex w-full items-center gap-2 rounded p-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
            :aria-label="nodeName(node)"
            :aria-pressed="node.id === selected.item"
            @click="emit('item', node.id)"
          >
            <FlowGlyph :state="node.state" /><span class="text-sm">{{ node.title }}</span
            ><span class="text-xs text-muted">{{ node.said }}</span
            ><UIcon v-if="node.link !== undefined" name="i-lucide-arrow-up-right" />
          </button>
        </component>
      </li>
    </ol>
    <slot name="work" />
    <UButton
      v-if="info.open.tab === 'plan' || info.open.tab === 'review' || info.open.tab === 'mr'"
      variant="link"
      class="self-start px-0"
      :label="`Open in ${labels[info.open.tab] ?? info.open.tab}`"
      @click="emit('open', info.open.run, info.open.tab)"
    />
  </section>
</template>
