<script setup lang="ts">
import type { TreeItem } from "@nuxt/ui";
import { Semaphore } from "effect";
import type { DiffFile, RunDiff } from "../../../../src/board-model";

/** Where a finding points: a file, and a line in it as it is now. */
export interface DiffTarget {
  readonly file: string;
  readonly line: number | null;
}

const props = defineProps<{
  diff: RunDiff;
  installation: string;
  runId: string;
  target: DiffTarget | null;
}>();

// Each diff read has the host run git again, so this record's are four at a time.
provide("diffReads", Semaphore.makeUnsafe(4));

/** A file with more changed lines than this, or a binary one, starts collapsed. */
const BIG_FILE_LINES = 500;

const split = ref(false);
const opened = ref(new Map<string, boolean>());
const isOpen = (file: DiffFile) =>
  opened.value.get(file.path) ??
  (file.added !== null && file.added + (file.removed ?? 0) <= BIG_FILE_LINES);

const sections = ref<HTMLElement | null>(null);
const show = async (path: string) => {
  opened.value.set(path, true);
  await nextTick();
  sections.value
    ?.querySelector(`[data-testid="diff-${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: "start" });
};

/** The finding's file when it is not in the diff, shown read-only above it. */
const source = ref<DiffTarget | null>(null);
watch(
  () => props.target,
  (target) => {
    if (target === null) return;
    const inDiff = props.diff.files.some((file) => file.path === target.file);
    source.value = inDiff ? null : target;
    if (inDiff) opened.value.set(target.file, true);
  },
  { immediate: true },
);

/** The changed files as folders and files, each folder open. */
const tree = computed(() => {
  const root: TreeItem[] = [];
  for (const file of props.diff.files) {
    const parts = file.path.split("/");
    let level = root;
    parts.forEach((part, at) => {
      if (at === parts.length - 1) {
        level.push({
          label: part,
          icon: "i-lucide-file",
          path: file.path,
          onSelect: () => void show(file.path),
        });
        return;
      }
      const path = `${parts.slice(0, at + 1).join("/")}/`;
      let folder = level.find((item) => item.path === path);
      if (folder === undefined) {
        folder = {
          label: part,
          icon: "i-lucide-folder",
          path,
          defaultExpanded: true,
          children: [],
        };
        level.push(folder);
      }
      level = folder.children!;
    });
  }
  return root;
});
</script>

<template>
  <div data-testid="diff" class="flex flex-col gap-3">
    <div class="flex items-center gap-3 text-sm">
      <UBadge
        variant="subtle"
        :color="diff.live ? 'info' : 'neutral'"
        :label="diff.live ? 'Live' : 'Final'"
      />
      <span class="text-muted">
        {{ diff.files.length }} {{ diff.files.length === 1 ? "file" : "files" }} against
        <code>{{ diff.base.slice(0, 7) }}</code>
      </span>
      <USwitch v-model="split" class="ml-auto" label="Side by side" data-testid="split" />
    </div>
    <SourceFile
      v-if="source !== null"
      :path="source.file"
      :line="source.line"
      :installation="installation"
      :run-id="runId"
      @close="source = null"
    />
    <p v-if="diff.files.length === 0" class="text-sm text-muted">Nothing has changed yet.</p>
    <div v-else class="flex items-start gap-3">
      <UTree
        :items="tree"
        :get-key="(item: TreeItem) => item.path"
        class="w-56 shrink-0"
        data-testid="diff-tree"
      />
      <div ref="sections" class="flex min-w-0 flex-1 flex-col gap-3">
        <DiffFile
          v-for="file in diff.files"
          :key="file.path"
          :file="file"
          :installation="installation"
          :run-id="runId"
          :base="diff.base"
          :split="split"
          :target="target?.file === file.path ? target : null"
          :open="isOpen(file)"
          @update:open="(now: boolean) => opened.set(file.path, now)"
          @missing="(missed: DiffTarget) => (source = missed)"
        />
      </div>
    </div>
  </div>
</template>
