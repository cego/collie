<script setup lang="ts">
import type { Semaphore } from "effect";
import type { DiffFile } from "../../../../src/board-model";
import { type PatchLine, parsePatch, sideBySide, sides } from "../../../src/shared/patch";
import type { Token } from "../composables/useHighlight";
import type { DiffTarget } from "./DiffTab.vue";

const props = defineProps<{
  file: DiffFile;
  /** The base the diff is against, which a rebase or a merge moves. */
  base: string;
  installation: string;
  runId: string;
  split: boolean;
  /** What a finding points at in this file; each new one is scrolled to once. */
  target: DiffTarget | null;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ missing: [target: DiffTarget] }>();
const { textOf } = useActions();
const within = inject<Semaphore.Semaphore>("diffReads");

// Shallow: its lines are the token map's keys, which a reactive proxy would not match.
const hunks = shallowRef<ReturnType<typeof parsePatch> | null>(null);
const failed = ref(false);
const tokens = shallowRef(new Map<PatchLine, ReadonlyArray<Token>>());

/** Each hunk's sides highlighted on their own, since what lies between hunks is not here. */
const highlighted = async (parsed: ReturnType<typeof parsePatch>) => {
  const coloured = new Map<PatchLine, ReadonlyArray<Token>>();
  const colour = (lines: ReadonlyArray<PatchLine>) =>
    highlightLines(
      lines.map((line) => line.text),
      props.file.path,
    );
  await Promise.all(
    parsed.map(async (hunk) => {
      const { old, new: current } = sides([hunk]);
      const [was, is] = await Promise.all([colour(old), colour(current)]);
      // A context line is on both sides; it is coloured as the file is now.
      old.forEach((line, at) => line.kind === "del" && coloured.set(line, was[at] ?? []));
      current.forEach((line, at) => coloured.set(line, is[at] ?? []));
    }),
  );
  return coloured;
};

// ponytail: refetched when its counts, status or base change; an edit keeping all of them
// is missed until the host sends each file's fingerprint.
watch(
  () => [open.value, props.file.added, props.file.removed, props.file.status, props.base] as const,
  async ([isOpen], _, onCleanup) => {
    if (!isOpen) return;
    let stale = false;
    const wanted = new AbortController();
    onCleanup(() => {
      stale = true;
      wanted.abort();
    });
    const patch = await textOf(props.installation, props.runId, `diff:${props.file.path}`, {
      within,
      signal: wanted.signal,
    });
    if (stale) return;
    failed.value = patch === null;
    if (patch === null) return;
    const parsed = parsePatch(patch);
    const coloured = await highlighted(parsed);
    if (stale) return;
    tokens.value = coloured;
    hunks.value = parsed;
  },
  { immediate: true },
);

/** The row a finding points at: its line as the file is now, or as it was for a deleted file. */
const targetLine = computed(() => {
  const line = props.target?.line ?? null;
  if (line === null || hunks.value === null) return undefined;
  const side = props.file.status === "deleted" ? "old" : "new";
  return hunks.value.flatMap((hunk) => hunk.lines).find((one) => one[side] === line);
});

const shown = ref<HTMLElement | null>(null);
let scrolledTo: DiffTarget | null = null;
watch(
  () => [hunks.value, props.target] as const,
  async ([loaded, target]) => {
    if (target === null || loaded === null || target === scrolledTo) return;
    scrolledTo = target;
    if (target.line === null) return;
    if (targetLine.value === undefined) return emit("missing", target);
    await nextTick();
    shown.value?.querySelector("[data-target]")?.scrollIntoView({ block: "center" });
  },
  { immediate: true },
);

const SIGNS = { context: " ", add: "+", del: "-" } as const;
const BACKGROUNDS = { context: "", add: "bg-success/10", del: "bg-error/10" } as const;
const NUMBER = "w-10 select-none px-2 text-right text-muted";
const TARGET = "ring-1 ring-warning ring-inset";
</script>

<template>
  <section :data-testid="`diff-${file.path}`" class="rounded border border-default">
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm"
      data-testid="diff-file-header"
      @click="open = !open"
    >
      <UIcon :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />
      <code class="flex-1 truncate">{{ file.path }}</code>
      <small class="text-muted">{{ file.status }}</small>
      <template v-if="file.added !== null">
        <small class="text-success">+{{ file.added }}</small>
        <small class="text-error">−{{ file.removed }}</small>
      </template>
      <small v-else class="text-muted">binary</small>
    </button>
    <div v-if="open" ref="shown" class="overflow-x-auto border-t border-default" data-highlighted>
      <p v-if="failed" class="p-3 text-sm text-muted">This file's diff could not be read.</p>
      <p v-else-if="hunks === null" class="p-3 text-sm text-muted">Reading…</p>
      <p v-else-if="hunks.length === 0" class="p-3 text-sm text-muted">No text to show.</p>
      <table v-else class="w-full font-mono text-xs" data-testid="diff-lines">
        <tbody v-for="(hunk, at) in hunks" :key="at">
          <tr>
            <td colspan="4" class="bg-elevated px-2 py-1 text-muted">{{ hunk.header }}</td>
          </tr>
          <template v-if="split">
            <tr
              v-for="(row, index) in sideBySide(hunk)"
              :key="index"
              :data-old-line="row.left?.old ?? undefined"
              :data-new-line="row.right?.new ?? undefined"
              :data-target="
                (targetLine && (row.left === targetLine || row.right === targetLine)) || undefined
              "
              :class="
                targetLine && (row.left === targetLine || row.right === targetLine) ? TARGET : ''
              "
            >
              <td :class="NUMBER">{{ row.left?.old }}</td>
              <td
                class="w-1/2 whitespace-pre px-2"
                :class="row.left ? BACKGROUNDS[row.left.kind] : ''"
                data-side="old"
              >
                <TokenSpans v-if="row.left" :tokens="tokens.get(row.left)" />
              </td>
              <td :class="NUMBER">{{ row.right?.new }}</td>
              <td
                class="w-1/2 whitespace-pre px-2"
                :class="row.right ? BACKGROUNDS[row.right.kind] : ''"
                data-side="new"
              >
                <TokenSpans v-if="row.right" :tokens="tokens.get(row.right)" />
              </td>
            </tr>
          </template>
          <template v-else>
            <tr
              v-for="(line, index) in hunk.lines"
              :key="index"
              :class="[BACKGROUNDS[line.kind], line === targetLine ? TARGET : '']"
              :data-old-line="line.old ?? undefined"
              :data-new-line="line.new ?? undefined"
              :data-target="line === targetLine || undefined"
            >
              <td :class="NUMBER">{{ line.old }}</td>
              <td :class="NUMBER">{{ line.new }}</td>
              <td class="w-4 select-none text-muted">{{ SIGNS[line.kind] }}</td>
              <td class="whitespace-pre px-2" data-side="unified">
                <TokenSpans :tokens="tokens.get(line)" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>
</template>
