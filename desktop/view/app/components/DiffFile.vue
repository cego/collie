<script setup lang="ts">
import type { DiffFile } from "../../../../src/board-model";
import { type PatchLine, parsePatch, sideBySide, sides } from "../../../src/shared/patch";
import type { Token } from "../composables/useHighlight";
import type { DiffTarget } from "./DiffTab.vue";

const props = defineProps<{
  file: DiffFile;
  installation: string;
  runId: string;
  split: boolean;
  /** What a finding points at in this file; each new one is scrolled to. */
  target: DiffTarget | null;
}>();
const open = defineModel<boolean>("open", { required: true });
const { textOf } = useActions();

// Shallow: its lines are the token map's keys, which a reactive proxy would not match.
const hunks = shallowRef<ReturnType<typeof parsePatch> | null>(null);
const failed = ref(false);
const tokens = shallowRef(new Map<PatchLine, ReadonlyArray<Token>>());

/** Fetched again whenever the Run changes the file, while it is open. */
watch(
  () => [open.value, props.file.added, props.file.removed] as const,
  async ([isOpen]) => {
    if (!isOpen) return;
    const patch = await textOf(props.installation, props.runId, `diff:${props.file.path}`);
    failed.value = patch === null;
    if (patch === null) return;
    const parsed = parsePatch(patch);
    const { old, new: now } = sides(parsed);
    const [was, is] = await Promise.all([
      highlightLines(
        old.map((line) => line.text),
        props.file.path,
      ),
      highlightLines(
        now.map((line) => line.text),
        props.file.path,
      ),
    ]);
    const coloured = new Map<PatchLine, ReadonlyArray<Token>>();
    old.forEach((line, at) => coloured.set(line, was[at] ?? []));
    // A context line is coloured as the file is now.
    now.forEach((line, at) => coloured.set(line, is[at] ?? []));
    tokens.value = coloured;
    hunks.value = parsed;
  },
  { immediate: true },
);

const shown = ref<HTMLElement | null>(null);
watch(
  () => [hunks.value, props.split, props.target] as const,
  async ([, , target]) => {
    const line = target?.line ?? null;
    if (line === null || hunks.value === null) return;
    await nextTick();
    const row =
      shown.value?.querySelector(`[data-new-line="${line}"]`) ??
      shown.value?.querySelector(`[data-old-line="${line}"]`);
    row?.scrollIntoView({ block: "center" });
  },
  { immediate: true },
);

const isTarget = (line: number | null | undefined) => line != null && line === props.target?.line;

const SIGNS = { context: " ", add: "+", del: "-" } as const;
const BACKGROUNDS = { context: "", add: "bg-success/10", del: "bg-error/10" } as const;
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
      <small v-if="file.added !== null" class="text-success">+{{ file.added }}</small>
      <small v-if="file.removed !== null" class="text-error">−{{ file.removed }}</small>
      <small v-else class="text-muted">binary</small>
    </button>
    <div v-if="open" ref="shown" class="overflow-x-auto border-t border-default" data-highlighted>
      <p v-if="failed" class="p-3 text-sm text-muted">This file's diff could not be read.</p>
      <p v-else-if="hunks === null" class="p-3 text-sm text-muted">Reading…</p>
      <p v-else-if="hunks.length === 0" class="p-3 text-sm text-muted">No text to show.</p>
      <table v-else class="w-full font-mono text-xs" data-testid="diff-lines">
        <tbody v-for="(hunk, at) in hunks" :key="at">
          <tr>
            <td colspan="4" class="bg-elevated px-2 py-1 text-muted">
              {{ hunk.header }}
            </td>
          </tr>
          <template v-if="split">
            <tr
              v-for="(row, index) in sideBySide(hunk)"
              :key="index"
              :data-old-line="row.left?.old ?? undefined"
              :data-new-line="row.right?.new ?? undefined"
              :data-target="isTarget(row.right?.new) || undefined"
              :class="isTarget(row.right?.new) ? 'ring-1 ring-warning ring-inset' : ''"
            >
              <td class="w-10 select-none px-2 text-right text-muted">{{ row.left?.old }}</td>
              <td
                class="w-1/2 whitespace-pre px-2"
                :class="row.left ? BACKGROUNDS[row.left.kind] : ''"
                data-side="old"
              >
                <span
                  v-for="(token, t) in row.left ? tokens.get(row.left) : []"
                  :key="t"
                  :style="token.style"
                  >{{ token.content }}</span
                >
              </td>
              <td class="w-10 select-none px-2 text-right text-muted">{{ row.right?.new }}</td>
              <td
                class="w-1/2 whitespace-pre px-2"
                :class="row.right ? BACKGROUNDS[row.right.kind] : ''"
                data-side="new"
              >
                <span
                  v-for="(token, t) in row.right ? tokens.get(row.right) : []"
                  :key="t"
                  :style="token.style"
                  >{{ token.content }}</span
                >
              </td>
            </tr>
          </template>
          <template v-else>
            <tr
              v-for="(line, index) in hunk.lines"
              :key="index"
              :class="[
                BACKGROUNDS[line.kind],
                isTarget(line.new) ? 'ring-1 ring-warning ring-inset' : '',
              ]"
              :data-old-line="line.old ?? undefined"
              :data-new-line="line.new ?? undefined"
              :data-target="isTarget(line.new) || undefined"
            >
              <td class="w-10 select-none px-2 text-right text-muted">{{ line.old }}</td>
              <td class="w-10 select-none px-2 text-right text-muted">{{ line.new }}</td>
              <td class="w-4 select-none text-muted">{{ SIGNS[line.kind] }}</td>
              <td class="whitespace-pre px-2" data-side="unified">
                <span v-for="(token, t) in tokens.get(line)" :key="t" :style="token.style">{{
                  token.content
                }}</span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>
</template>
