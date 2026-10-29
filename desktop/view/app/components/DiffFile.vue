<script setup lang="ts">
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import {
  FileDiff,
  type FileDiffMetadata,
  type FileDiffOptions,
  processFile,
  type SelectionSide,
} from "@pierre/diffs";
import type { Semaphore } from "effect";
import type { DiffFile } from "../../../../src/board-model";
import { readingHeight } from "../../../src/shared/diff-view";
import { type Draft, inHunks, locationOf } from "../../../src/shared/review-comments";
import type { DiffTarget } from "./DiffTab.vue";
import { useDiffComments, WRITING } from "../composables/useDiffComments";

const props = defineProps<{
  file: DiffFile;
  /** The base the diff is against, which a rebase or a merge moves. */
  base: string;
  installation: string;
  runId: string;
  split: boolean;
  wrap: boolean;
  /** What a finding points at in this file; each new one is scrolled to once. */
  target: DiffTarget | null;
}>();
const open = defineModel<boolean>("open", { required: true });
const viewed = defineModel<boolean>("viewed", { required: true });
const emit = defineEmits<{ missing: [target: DiffTarget] }>();
const { textOf } = useActions();
const within = inject<Semaphore.Semaphore>("diffReads");
const scroller = inject<Ref<HTMLElement | null>>("recordScroller", ref(null));
const colorMode = useColorMode();
const { drafts, add, edit, remove } = useReviewDrafts(() => props);

const parsed = shallowRef<FileDiffMetadata | null>(null);
const failed = ref(false);
const unparsed = ref(false);

const parse = (patch: string) => {
  try {
    return processFile(patch, { isGitDiff: true, throwOnError: true }) ?? null;
  } catch {
    return null;
  }
};

// ponytail: refetched when its counts, status or base change; an edit keeping all of them
// is missed until the host sends each file's fingerprint.
watch(
  () => [open.value, props.file.added, props.file.removed, props.file.status, props.base] as const,
  (input, _, onCleanup) => {
    const [isOpen] = input;
    if (!isOpen) return;
    let stale = false;
    const reading = Effect.runFork(
      Effect.gen(function* () {
        const patch = yield* Effect.promise((signal) =>
          textOf(props.installation, props.runId, `diff:${props.file.path}`, {
            within,
            signal,
          }),
        );
        if (stale) return;
        failed.value = patch === null;
        if (patch === null) return;
        const diff = parse(patch);
        unparsed.value = diff === null;
        parsed.value = diff;
      }),
    );
    onCleanup(() => {
      stale = true;
      Effect.runFork(Fiber.interrupt(reading));
    });
    return Effect.runPromise(
      Fiber.join(reading).pipe(Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void)),
    );
  },
  { immediate: true },
);

const comments = useDiffComments(
  () => props.file.path,
  () => parsed.value,
  () => drafts.value,
  add,
  () => view?.setSelectedLines(null),
);
const { pending, annotations, settle } = comments;

/** Each annotation's element, by draft id, which the template teleports its comment into. */
const slots = shallowReactive(new Map<string, HTMLElement>());
const slotFor = (id: string) => {
  const made = slots.get(id) ?? document.createElement("div");
  slots.set(id, made);
  return made;
};
const draftOf = (id: string): Draft | undefined =>
  Option.getOrUndefined(Arr.findFirst(drafts.value, (draft) => draft.id === id));

/** The finding's row, once drawn: shown and marked, then let go. */
let wanted: { readonly line: number; readonly side: SelectionSide } | null = null;
const showWanted = () => {
  if (wanted === null || view === null) return;
  const { line, side } = wanted;
  // ponytail: rows found by the library's own data attributes; recheck on an upgrade.
  const row =
    side === "deletions"
      ? `[data-deletions] [data-line="${line}"], [data-unified] [data-line="${line}"][data-line-type="change-deletion"]`
      : `[data-additions] [data-line="${line}"], [data-unified] [data-line="${line}"]:not([data-line-type="change-deletion"])`;
  const found = host.value?.querySelector("diffs-container")?.shadowRoot?.querySelector(row);
  if (found === null || found === undefined) return;
  wanted = null;
  view.setSelectedLines({ start: line, end: line, side }, { notify: false });
  found.scrollIntoView({ block: "center" });
};

const options = (): FileDiffOptions<string, undefined> => ({
  theme: { light: "github-light", dark: "github-dark" },
  themeType: colorMode.value === "dark" ? "dark" : "light",
  diffStyle: props.split ? "split" : "unified",
  overflow: props.wrap ? "wrap" : "scroll",
  disableFileHeader: true,
  enableLineSelection: true,
  enableGutterUtility: true,
  ...comments.handlers,
  renderAnnotation: (annotation) => slotFor(annotation.metadata),
  onPostRender: showWanted,
});

const host = ref<HTMLElement | null>(null);
let view: FileDiff<string> | null = null;
watch(
  [parsed, host],
  ([diff, wrapper], _, onCleanup) => {
    if (diff === null || wrapper === null || diff.hunks.length === 0) return;
    const made = new FileDiff<string>(options());
    made.render({ fileDiff: diff, containerWrapper: wrapper, lineAnnotations: annotations.value });
    view = made;
    onCleanup(() => {
      made.cleanUp();
      view = null;
    });
  },
  { immediate: true, flush: "post" },
);
watch([() => props.split, () => props.wrap, () => colorMode.value], () => {
  view?.setOptions(options());
  view?.render({ forceRender: true });
});
watch(annotations, (now) => {
  view?.render({ lineAnnotations: now });
  const kept = new Set(Arr.map(now, (annotation) => annotation.metadata));
  for (const id of slots.keys()) if (!kept.has(id)) slots.delete(id);
});

/** A finding's line as the file is now, or as it was for a deleted file. */
const targetSide = computed(() => (props.file.status === "deleted" ? "deletions" : "additions"));
let scrolledTo: DiffTarget | null = null;
watch(
  () => [parsed.value, props.target] as const,
  ([diff, target]) => {
    if (target === null || diff === null || target === scrolledTo) return;
    scrolledTo = target;
    const line = target.line;
    if (line === null) return;
    const side = targetSide.value;
    if (!inHunks(diff, line, side)) return emit("missing", target);
    wanted = { line, side };
    showWanted();
  },
  { immediate: true, flush: "post" },
);
</script>

<template>
  <section :data-testid="`diff-${file.path}`" class="rounded border border-default">
    <div class="flex items-center gap-3 pe-3">
      <button
        type="button"
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 ps-3 text-left text-sm"
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
      <UCheckbox v-model="viewed" label="Viewed" size="sm" data-testid="diff-viewed" />
    </div>
    <div v-if="open" class="border-t border-default">
      <p v-if="failed" class="p-3 text-sm text-muted">This file's diff could not be read.</p>
      <p v-else-if="unparsed" class="p-3 text-sm text-muted" data-testid="diff-unparsed">
        This file's diff could not be drawn.
      </p>
      <USkeleton
        v-else-if="parsed === null"
        data-testid="diff-reading"
        class="m-3"
        :style="{ height: `${readingHeight(file, scroller?.clientHeight ?? Infinity)}px` }"
      />
      <p v-else-if="parsed.hunks.length === 0" class="p-3 text-sm text-muted">No text to show.</p>
      <div v-else ref="host" data-testid="diff-lines" />
    </div>
    <Teleport v-for="[id, slot] in slots" :key="id" :to="slot">
      <CommentComposer
        v-if="id === WRITING && pending !== null"
        class="rounded-none border-x-0"
        data-testid="diff-comment"
        :location="locationOf(pending)"
        @add="settle"
        @cancel="settle(null)"
      />
      <DraftEdit
        v-else-if="draftOf(id) !== undefined"
        class="border-y border-default bg-default p-2"
        :text="draftOf(id)!.text"
        @edit="(text) => edit(id, text)"
        @remove="remove(id)"
      />
    </Teleport>
  </section>
</template>
