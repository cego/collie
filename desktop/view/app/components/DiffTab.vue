<script setup lang="ts">
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import type { TreeItem } from "@nuxt/ui";
import { Semaphore } from "effect";
import type { Ref } from "vue";
import type { DiffFile, RunDiff } from "../../../../src/board-model";
import { inField } from "../../../src/shared/board-clicks";
import { landingOf } from "../../../src/shared/record";
import {
  activeFile,
  choiceForEvery,
  closedFolders,
  type DiffTreeNode,
  diffTree,
  fileBeside,
  fileOpen,
  fileSelected,
  filterTree,
  foldersOn,
  indentedDepth,
  openFolders,
  paneStepped,
  paneWidth,
  READING_LINE,
  reachBy,
  rowFacts,
  rowHover,
  rowRoom,
  TREE,
} from "../../../src/shared/diff-view";

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
  /** Whether Diff is the record's tab now; nothing is measured while it is not. */
  shown: boolean;
}>();

// Each diff read has the host run git again, so this record's are four at a time.
provide("diffReads", Semaphore.makeUnsafe(4));

const split = ref(false);
const wrap = ref(false);
const opened = ref(new Map<string, boolean>());

const sections = ref<HTMLElement | null>(null);
const scrollToFile = (path: string) => {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.promise(() => Promise.resolve(nextTick()));
      sections.value?.querySelector(`[data-testid="diff-${CSS.escape(path)}"]`)?.scrollIntoView({
        block: "start",
      });
    }),
  );
};
const scrollIntoDiff = (path: string) => {
  opened.value.set(path, true);
  return scrollToFile(path);
};

/** The file being read, and the one a click or a finding's jump holds until the human scrolls. */
const active = ref<string | null>(null);
const held = ref<string | null>(null);
const show = (path: string) => {
  held.value = path;
  active.value = path;
  void scrollIntoDiff(path);
};
/** `j` and `k`: the next or previous file held as a click holds it, left open or closed. */
const step = (by: 1 | -1) => {
  const path = fileBeside(drawn.value.files, active.value, by);
  if (path === null) return;
  held.value = path;
  active.value = path;
  void scrollToFile(path);
};
defineExpose({ step });

/** The finding's file when it is not in the diff, shown read-only above it. */
const source = ref<DiffTarget | null>(null);
watch(
  () => props.target,
  (target) => {
    if (target === null) return;
    const landing = landingOf(
      target,
      Arr.map(props.diff.files, ({ path }) => path),
    );
    source.value = landing.at === "source" ? target : null;
    if (landing.at === "source") return;
    if (landing.at === "file") return show(landing.file);
    opened.value.set(target.file, true);
    held.value = target.file;
    active.value = target.file;
  },
  { immediate: true },
);

const drawn = computed(() => diffTree(props.diff.files));
const openEvery = (open: boolean) => {
  return Effect.runPromise(
    Effect.gen(function* () {
      opened.value = new Map(choiceForEvery(drawn.value.files, open));
      held.value = null;
      yield* Effect.promise(() => Promise.resolve(nextTick()));
      measure();
    }),
  );
};
const filter = ref("");
const filtering = computed(() => Str.trim(filter.value) !== "");
const listed = computed(() => filterTree(drawn.value.tree, filter.value));

const { drafts } = useReviewDrafts(() => props);
const {
  viewed,
  count: viewedSoFar,
  mark,
} = useViewedFiles(
  () => props,
  () => props.diff,
);
const markViewed = (file: DiffFile, now: boolean) => {
  mark(file, now);
  if (now) opened.value.set(file.path, false);
};
const facts = computed(() => {
  const onDiff = Arr.flatMap(drafts.value, ({ anchor }) =>
    anchor._tag === "Diff" ? [anchor.path] : [],
  );
  return new Map(Arr.map(drawn.value.files, (file) => [file.path, rowFacts(file, onDiff)]));
});

type Row = TreeItem & { path: string; hover: string };
const chevron = useAppConfig().ui.icons.chevronDown;
const factsOf = (row: Row) => facts.value.get(row.path);
const viewedOf = (row: Row) => viewed.value.has(row.path);
const tab = ref<HTMLElement | null>(null);
const tabWidth = ref<number | null>(null);
watch(tab, (box, _, onCleanup) => {
  if (box === null) return;
  const resized = new ResizeObserver(([entry]) => {
    if (entry !== undefined && entry.contentRect.width > 0)
      tabWidth.value = entry.contentRect.width;
  });
  resized.observe(box);
  onCleanup(() => resized.disconnect());
});
const chosen = useTreeWidth();
const pane = computed(() =>
  tabWidth.value === null ? chosen.value : paneWidth(chosen.value, tabWidth.value),
);
const paneMax = computed(() =>
  tabWidth.value === null ? pane.value : paneWidth(Infinity, tabWidth.value),
);
const dragging = ref<{ x: number; from: number } | null>(null);
const startDrag = (event: PointerEvent) => {
  if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  dragging.value = { x: event.clientX, from: pane.value };
};
const drag = (event: PointerEvent) => {
  const start = dragging.value;
  if (start === null || tabWidth.value === null) return;
  chosen.value = paneWidth(start.from + event.clientX - start.x, tabWidth.value);
};
const stepPane = (by: 1 | -1) => {
  if (tabWidth.value !== null) chosen.value = paneStepped(chosen.value, tabWidth.value, by);
};
/** Tree's `level` counts from 1. */
const countsShow = (row: Row, level: number) => {
  const shown = factsOf(row);
  return (
    shown !== undefined &&
    rowRoom({ depth: level - 1, pane: pane.value, file: { facts: shown, viewed: viewedOf(row) } })
      .counts
  );
};
const geometry = {
  "--tree-guide": `${TREE.guide}px`,
  "--tree-step": `${TREE.indent - TREE.guide}px`,
  "--tree-padding": `${TREE.padding}px`,
  "--tree-icon": `${TREE.icon}px`,
  "--tree-gap": `${TREE.gap}px`,
  "--tree-chevron": `${TREE.chevron}px`,
};
/** The slot's own `ui` leaves these out, so the row's template applies them too. */
const treeUi = {
  listWithChildren: "ms-(--tree-guide)",
  itemWithChildren: "ps-(--tree-step)",
  link: "px-(--tree-padding) gap-(--tree-gap)",
  linkLeadingIcon: "size-(--tree-icon)",
  linkTrailing: "shrink-0",
  linkTrailingIcon: "size-(--tree-chevron)",
};

const items = computed(() => {
  const byKey = new Map<string, Row>();
  const toItem = (node: DiffTreeNode, depth: number): Row => {
    const ui = {
      itemWithChildren: indentedDepth(depth) < depth ? "ps-0" : undefined,
      listWithChildren: indentedDepth(depth + 1) === depth + 1 ? undefined : "ms-0",
    };
    const item: Row =
      node.kind === "folder"
        ? {
            label: node.label,
            icon: "i-lucide-folder",
            path: node.key,
            hover: rowHover(node),
            ui,
            children: Arr.map(node.children, (child) => toItem(child, depth + 1)),
          }
        : {
            label: node.label,
            icon: "i-lucide-file",
            path: node.key,
            hover: rowHover(node),
            ui,
          };
    byKey.set(node.key, item);
    return item;
  };
  return { tree: Arr.map(listed.value, (node) => toItem(node, 0)), byKey };
});
const selected = computed(() =>
  active.value === null ? undefined : items.value.byKey.get(active.value),
);
const selectRow = (event: Event, row: Row) => {
  const path = fileSelected(event, row.path);
  if (path !== null) show(path);
};

const closed = ref(new Set<string>());
const listedFolders = computed(() =>
  Arr.filter([...items.value.byKey.keys()], (key) => pipe(key, Str.endsWith("/"))),
);
const folderFacts = computed(() => ({
  all: drawn.value.folders,
  listed: listedFolders.value,
  closed: closed.value,
  filtering: filtering.value,
}));
const expanded = computed(() => [...openFolders(folderFacts.value)]);
const setExpanded = (keys: ReadonlyArray<string>) => {
  closed.value = new Set(closedFolders(folderFacts.value, keys));
};

const scroller = inject<Ref<HTMLElement | null>>("recordScroller", ref(null));
const treeBox = ref<HTMLElement | null>(null);
const visibleHeight = ref<number | null>(null);

const measure = () => {
  const box = scroller.value;
  const column = sections.value;
  if (!props.shown || box === null || column === null) return;
  if (held.value !== null && !Arr.some(drawn.value.files, ({ path }) => path === held.value)) {
    held.value = null;
  }
  visibleHeight.value = box.clientHeight;
  const visibleTop = box.getBoundingClientRect().top;
  const measured = Arr.flatMap([...column.children], (section) => {
    const path = section.getAttribute("data-path");
    if (path === null) return [];
    const { top, bottom } = section.getBoundingClientRect();
    return [
      {
        path,
        top: top - visibleTop,
        bottom: bottom - visibleTop,
      },
    ];
  });
  active.value = activeFile({
    sections: measured,
    readingLine: READING_LINE,
    atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 1,
    held: held.value,
  });
};

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
watch(
  [() => props.shown, scroller, sections],
  ([shown, box, column], _, onCleanup) => {
    if (!shown || box === null || column === null) return;
    const release = () => (held.value = null);
    const releaseOnKey = (event: KeyboardEvent) => {
      const typedIn = event.composedPath()[0];
      if (SCROLL_KEYS.has(event.key) && !(typedIn instanceof Element && inField(typedIn)))
        release();
    };
    const releaseOnScrollbar = (event: PointerEvent) => event.target === box && release();
    const resized = new ResizeObserver(measure);
    resized.observe(box);
    resized.observe(column);
    box.addEventListener("scroll", measure, { passive: true });
    box.addEventListener("wheel", release, { passive: true });
    box.addEventListener("touchmove", release, { passive: true });
    box.addEventListener("keydown", releaseOnKey);
    box.addEventListener("pointerdown", releaseOnScrollbar);
    measure();
    onCleanup(() => {
      resized.disconnect();
      box.removeEventListener("scroll", measure);
      box.removeEventListener("wheel", release);
      box.removeEventListener("touchmove", release);
      box.removeEventListener("keydown", releaseOnKey);
      box.removeEventListener("pointerdown", releaseOnScrollbar);
    });
  },
  { immediate: true, flush: "post" },
);
watch(() => drawn.value.files, measure, { flush: "post" });

watch(
  [active, () => props.shown, listed],
  (input, input_) => {
    return Effect.runPromise(
      Effect.gen(function* () {
        const [path, shown] = input;
        const [was] = input_;
        if (path === null) return;
        const hiding = Arr.filter(foldersOn(path), (folder) => closed.value.has(folder));
        if (path !== was && hiding.length > 0) {
          closed.value = new Set(
            Arr.filter([...closed.value], (folder) => !hiding.includes(folder)),
          );
        }
        if (!shown) return;
        yield* Effect.promise(() => Promise.resolve(nextTick()));
        const box = treeBox.value;
        const row = box?.querySelector("[data-selected]");
        if (!box || !row) return;
        box.scrollTop += reachBy(box.getBoundingClientRect(), row.getBoundingClientRect());
      }),
    );
  },
  { flush: "post" },
);
</script>

<template>
  <div
    ref="tab"
    data-testid="diff"
    class="flex flex-col gap-3"
    :class="dragging !== null && 'cursor-col-resize select-none'"
  >
    <div class="flex items-center gap-3 text-sm">
      <UBadge
        variant="subtle"
        :color="diff.live ? 'info' : 'neutral'"
        :label="diff.live ? 'Live' : 'Final'"
      />
      <span class="text-muted">
        {{ diff.files.length }} {{ diff.files.length === 1 ? "file" : "files" }} against
        <code>{{ Str.slice(0, 7)(diff.base) }}</code>
      </span>
      <span v-if="diff.files.length > 0" class="text-muted" data-testid="diff-viewed-count">
        {{ viewedSoFar }}
      </span>
      <div class="ml-auto flex flex-wrap items-center justify-end gap-3">
        <USwitch v-model="split" label="Side by side" data-testid="split" />
        <USwitch v-model="wrap" label="Wrap long lines" data-testid="wrap" />
        <UButton
          v-if="diff.files.length > 0"
          label="Expand all"
          icon="i-lucide-chevrons-up-down"
          size="xs"
          variant="ghost"
          color="neutral"
          data-testid="diff-expand-all"
          @click="openEvery(true)"
        />
        <UButton
          v-if="diff.files.length > 0"
          label="Collapse all"
          icon="i-lucide-chevrons-down-up"
          size="xs"
          variant="ghost"
          color="neutral"
          data-testid="diff-collapse-all"
          @click="openEvery(false)"
        />
      </div>
    </div>
    <SourceFile
      v-if="source !== null"
      :target="source"
      :installation="installation"
      :run-id="runId"
      @close="source = null"
    />
    <p v-if="diff.files.length === 0" class="text-sm text-muted">Nothing has changed yet.</p>
    <div v-else class="flex items-start">
      <div
        class="sticky top-0 flex shrink-0"
        :style="{ maxHeight: visibleHeight === null ? undefined : `${visibleHeight}px` }"
      >
        <div class="flex min-h-0 flex-col gap-2" :style="{ width: `${pane}px` }">
          <UInput
            v-model="filter"
            icon="i-lucide-search"
            placeholder="Filter files"
            size="sm"
            class="w-full"
            data-testid="diff-filter"
          />
          <div
            ref="treeBox"
            class="min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] [scrollbar-width:thin]"
            :style="geometry"
          >
            <p
              v-if="items.tree.length === 0"
              class="text-sm text-muted"
              data-testid="diff-no-match"
            >
              No file matches
            </p>
            <UTree
              v-else
              :items="items.tree"
              :get-key="(item: Row) => item.path"
              :model-value="selected"
              :expanded="expanded"
              :ui="treeUi"
              data-testid="diff-tree"
              @select="selectRow"
              @update:expanded="setExpanded"
            >
              <template #item="{ item, ui, level }">
                <span :title="item.hover" class="flex min-w-0 flex-1 items-center gap-[inherit]">
                  <UIcon
                    :name="item.icon!"
                    :class="ui.linkLeadingIcon({ class: treeUi.linkLeadingIcon })"
                  />
                  <span :class="ui.linkLabel()">{{ item.label }}</span>
                  <span :class="ui.linkTrailing({ class: treeUi.linkTrailing })">
                    <UIcon
                      v-if="item.children?.length"
                      :name="chevron"
                      :class="ui.linkTrailingIcon({ class: treeUi.linkTrailingIcon })"
                    />
                    <DiffRowFacts
                      v-else
                      :facts="factsOf(item)"
                      :viewed="viewedOf(item)"
                      :counts="countsShow(item, level)"
                    />
                  </span>
                </span>
              </template>
            </UTree>
          </div>
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the file tree"
          :aria-valuenow="Math.round(pane)"
          :aria-valuemin="TREE.paneMin"
          :aria-valuemax="Math.round(paneMax)"
          tabindex="0"
          class="group flex w-3 shrink-0 cursor-col-resize touch-none justify-center outline-none"
          data-testid="diff-tree-resize"
          @pointerdown="startDrag"
          @pointermove="drag"
          @lostpointercapture="dragging = null"
          @keydown.left.prevent="stepPane(-1)"
          @keydown.right.prevent="stepPane(1)"
        >
          <div
            class="w-px transition-all group-hover:w-0.5 group-hover:bg-primary group-focus-visible:w-0.5 group-focus-visible:bg-primary"
            :class="dragging === null ? 'bg-(--ui-border)' : 'w-0.5 bg-primary'"
          />
        </div>
      </div>
      <div ref="sections" class="flex min-w-0 flex-1 flex-col gap-3">
        <DiffFile
          v-for="file in drawn.files"
          :key="file.path"
          :data-path="file.path"
          :file="file"
          :installation="installation"
          :run-id="runId"
          :base="diff.base"
          :split="split"
          :wrap="wrap"
          :target="target?.file === file.path ? target : null"
          :open="fileOpen(file, opened)"
          :viewed="viewed.has(file.path)"
          @update:viewed="(now: boolean) => markViewed(file, now)"
          @update:open="(now: boolean) => opened.set(file.path, now)"
          @missing="(missed: DiffTarget) => (source = missed)"
        />
      </div>
    </div>
  </div>
</template>
