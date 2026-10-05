<script setup lang="ts">
import type { LinkCard } from "../../../src/shared/links";

defineProps<{ links: ReadonlyArray<LinkCard> }>();
const { openLink } = useActions();

const ICON = {
  artifact: "i-lucide-sparkles",
  mr: "i-lucide-git-pull-request",
  pipeline: "i-lucide-workflow",
  link: "i-lucide-globe",
} as const;
</script>

<template>
  <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
    <button
      v-for="link in links"
      :key="link.url"
      type="button"
      class="flex min-w-0 items-start gap-3 rounded-md border border-default p-3 text-left hover:bg-elevated"
      :data-testid="`link-${link.kind}`"
      @click="openLink(link.url)"
    >
      <UIcon :name="ICON[link.kind]" class="mt-0.5 shrink-0 text-muted" />
      <span class="flex min-w-0 flex-1 flex-col">
        <strong class="truncate" data-testid="link-title">{{ link.title }}</strong>
        <small class="truncate text-muted">{{ link.url }}</small>
      </span>
      <UBadge v-if="link.status" variant="subtle" :label="link.status" data-testid="link-status" />
    </button>
  </div>
</template>
