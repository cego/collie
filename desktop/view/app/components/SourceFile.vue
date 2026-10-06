<script setup lang="ts">
import type { Token } from "../composables/useHighlight";

/** A file of the Run's checkout, read-only, at the line a finding points at. */
const props = defineProps<{
  path: string;
  line: number | null;
  installation: string;
  runId: string;
}>();
const emit = defineEmits<{ close: [] }>();
const { textOf } = useActions();

const lines = shallowRef<ReadonlyArray<ReadonlyArray<Token>> | null>(null);
const failed = ref(false);
const shown = ref<HTMLElement | null>(null);

watch(
  () => props.path,
  async (path, _, onCleanup) => {
    let stale = false;
    onCleanup(() => (stale = true));
    lines.value = null;
    const text = await textOf(props.installation, props.runId, `file:${path}`);
    if (stale) return;
    failed.value = text === null;
    if (text === null) return;
    const coloured = await highlightLines(text.split("\n"), path);
    if (!stale) lines.value = coloured;
  },
  { immediate: true },
);
watch(
  () => [lines.value, props.line] as const,
  async ([, line]) => {
    if (line === null || lines.value === null) return;
    await nextTick();
    shown.value?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
  },
  { immediate: true },
);
</script>

<template>
  <section data-testid="source-file" class="rounded border border-default">
    <div class="flex items-center gap-2 px-3 py-2 text-sm">
      <UIcon name="i-lucide-file" />
      <code class="flex-1 truncate" data-testid="source-file-name">{{ path }}</code>
      <small class="text-muted">not in the diff · read-only</small>
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-x"
        aria-label="Close"
        data-testid="close-source-file"
        @click="emit('close')"
      />
    </div>
    <div ref="shown" class="overflow-x-auto border-t border-default" data-highlighted>
      <p v-if="failed" class="p-3 text-sm text-muted">{{ path }} could not be read.</p>
      <p v-else-if="lines === null" class="p-3 text-sm text-muted">Reading…</p>
      <table v-else class="w-full font-mono text-xs">
        <tr
          v-for="(tokens, at) in lines"
          :key="at"
          :data-line="at + 1"
          :data-target="at + 1 === line || undefined"
          :class="at + 1 === line ? 'ring-1 ring-warning ring-inset' : ''"
        >
          <td class="w-10 select-none px-2 text-right text-muted">{{ at + 1 }}</td>
          <td class="whitespace-pre px-2">
            <TokenSpans :tokens="tokens" />
          </td>
        </tr>
      </table>
    </div>
  </section>
</template>
