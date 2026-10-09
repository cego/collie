<script setup lang="ts">
import { toolRow } from "../../../src/shared/chat-view";

const props = defineProps<{
  name: string;
  args: string;
  output: string | null;
  running: boolean;
}>();
const row = computed(() => toolRow(props.name, props.args));
</script>

<template>
  <details data-testid="chat-tool" class="min-w-0 text-xs">
    <summary class="flex min-w-0 cursor-pointer items-center gap-1.5 text-muted">
      <UIcon
        :name="output === null ? 'i-lucide-loader' : 'i-lucide-wrench'"
        class="size-3 shrink-0"
        :class="{ 'animate-spin': output === null && running }"
      />
      <strong class="font-medium text-default">{{ row.tool }}</strong>
      <UBadge v-if="row.machine" size="sm" color="neutral" variant="subtle" :label="row.machine" />
      <span class="min-w-0 truncate">{{ row.summary }}</span>
    </summary>
    <pre class="mt-1 overflow-x-auto rounded bg-elevated p-2 whitespace-pre-wrap wrap-anywhere">{{
      output ?? "No result yet."
    }}</pre>
  </details>
</template>
