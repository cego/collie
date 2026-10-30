<script setup lang="ts">
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import type { Token } from "../composables/useHighlight";
import type { DiffTarget } from "./DiffTab.vue";

/** A file of the Run's checkout, read-only, at the line a finding points at. */
const props = withDefaults(
  defineProps<{
    /** A new object for every jump, each of which is revealed, even to the same place. */
    target: DiffTarget;
    installation: string;
    runId: string;
    /** Whether to scroll it into view, as for a jump; false where the record restores its place. */
    reveal?: boolean;
  }>(),
  { reveal: true },
);
const emit = defineEmits<{ close: [] }>();
const { textOf } = useActions();

const lines = shallowRef<ReadonlyArray<ReadonlyArray<Token>> | null>(null);
const failed = ref(false);
const shown = ref<HTMLElement | null>(null);
const whole = ref<HTMLElement | null>(null);

watch(
  [whole, () => props.target, () => props.reveal],
  ([section]) => {
    if (props.reveal) section?.scrollIntoView({ block: "start" });
  },
  { flush: "post" },
);

const path = computed(() => props.target.file);
const line = computed(() => props.target.line);
watch(
  path,
  (file, _, onCleanup) => {
    return Effect.runPromise(
      Effect.gen(function* () {
        let stale = false;
        onCleanup(() => (stale = true));
        lines.value = null;
        const text = yield* Effect.promise(() =>
          Promise.resolve(textOf(props.installation, props.runId, `file:${file}`)),
        );
        if (stale) return;
        failed.value = text === null;
        if (text === null) return;
        const coloured = yield* Effect.promise(() =>
          Promise.resolve(highlightLines(Str.split(text, "\n"), file)),
        );
        if (!stale) lines.value = coloured;
      }),
    );
  },
  { immediate: true },
);
watch(
  () => [lines.value, props.target, props.reveal] as const,
  (input) => {
    return Effect.runPromise(
      Effect.gen(function* () {
        const [, { line }] = input;
        if (line === null || lines.value === null || !props.reveal) return;
        yield* Effect.promise(() => Promise.resolve(nextTick()));
        shown.value?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({
          block: "center",
        });
      }),
    );
  },
  { immediate: true },
);
</script>

<template>
  <section ref="whole" data-testid="source-file" class="rounded border border-default">
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
