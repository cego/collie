<script setup lang="ts">
import { SECTIONS } from "../../../../src/board-model";
import { NOT_LIVE } from "../../../src/shared/flock";
import {
  afterGesture,
  escapeOn,
  type Gesture,
  landedOn,
  seenOnOpening,
} from "../../../src/shared/board-clicks";
import { CHAT_WIDTH, chatWidth, chatWidthMax } from "../../../src/shared/chat-width";
import type { Level } from "../../../src/shared/usage";
import { updatesAtom } from "../flock";
import tile from "../../../../assets/brand/logos/collie-tile-256.png";

const {
  connecting,
  trouble,
  lost,
  notices,
  tasks,
  everyTask,
  sections,
  header,
  waiting,
  finished,
  placedBy,
  placedAt,
} = useFlock();
const answering = useAnswering();
watch(everyTask, answering.settle, { immediate: true });
const { summary } = useInSync();
const usage = useUsage();
usage.keepFresh();
/** A header button's label, shown only where the board is wide enough for them all. */
const NARROW_HIDDEN = "sr-only @3xl/board:not-sr-only";
const LEVEL_CLASS = {
  ok: "text-muted",
  warn: "text-warning font-medium",
  out: "text-error font-medium",
} satisfies Record<Level, string>;
const { onboardOn } = useOnboarding();
const { renewBy } = useCredentials();
const { page, asked, open, back, toggle, showRecord } = usePage();
const opened = computed(() =>
  page.value?.kind === "record" ? placedBy(page.value.key) : undefined,
);
const pageShown = computed(
  () => page.value !== null && (page.value.kind !== "record" || opened.value !== undefined),
);
// A page opened takes focus to its back button, but Go to pane leaves it in the pane; back
// returns it to where it was.
let focusedBefore: Element | null = null;
watch(page, async (now, before) => {
  if (before === null) focusedBefore = document.activeElement;
  if (now !== null && asked.value === "terminal") return;
  await nextTick();
  const target = now === null ? focusedBefore : document.querySelector('[data-testid="page-back"]');
  if (target instanceof HTMLElement && target.isConnected) target.focus();
});

const { chip, choose } = useChip();
const pageId = (open: typeof page.value) =>
  open === null ? null : open.kind === "record" ? open.key : open.kind;
/** Every board gesture, decided by `afterGesture` and applied to the chip and the page. */
const gesture = (done: Gesture, tab: string | null = null) => {
  const about = chip.value;
  // A chip whose card has left the board stays selected under a key no card has.
  const selected =
    about === null
      ? null
      : (placedAt(about.machine, about.task)?.key ?? `gone:${about.machine}:${about.task}`);
  const before = { selected, page: pageId(page.value) };
  const after = afterGesture(before, done);
  if (after.selected === null) {
    if (before.selected !== null) choose(null);
  } else {
    // Chosen again even when unchanged, so the chip follows the card's latest Run and name.
    const card = placedBy(after.selected);
    if (card !== undefined)
      choose({
        machine: card.machine,
        task: card.task.id,
        run: card.task.run,
        name: card.task.name,
      });
  }
  if (after.page === before.page) return;
  for (const { installation, action } of seenOnOpening(before, after, placedBy))
    void run(installation, action);
  if (after.page === null) back();
  else showRecord(after.page, tab);
};
provide("gesture", gesture);
const { run } = useActions();
const toast = useToast();
useRecordOpener().opensRecords((about) => {
  const card = placedAt(about.machine, about.task);
  if (card !== undefined) gesture({ kind: "name", card: card.key });
  return card !== undefined;
});
// A record closes when its card leaves the Flock.
watch(
  opened,
  (now) => now === undefined && page.value?.kind === "record" && gesture({ kind: "close" }),
);

const targetOf = (event: Event) => (event.target instanceof Element ? event.target : null);
const click = (event: MouseEvent) => gesture({ kind: "click", landed: landedOn(targetOf(event)) });
const doubleClick = (event: MouseEvent) =>
  gesture({ kind: "double-click", landed: landedOn(targetOf(event)) });
const escape = (event: KeyboardEvent) => {
  if (event.key === "Escape") gesture(escapeOn(targetOf(event), document));
};
// Captured, so it runs before an overlay closes on the same key.
onMounted(() => window.addEventListener("keydown", escape, { capture: true }));
onUnmounted(() => window.removeEventListener("keydown", escape, { capture: true }));

const chatShown = ref(true);
const popped = ref(false);
const { popOut } = usePopOut();
const popChatOut = async () => {
  popped.value = true;
  await popOut();
  popped.value = false;
};

const root = ref<HTMLElement | null>(null);
/** The window's width in CSS pixels, which Zoom changes. */
const windowWidth = ref(window.innerWidth);
watch(root, (box, _, onCleanup) => {
  if (box === null) return;
  const resized = new ResizeObserver(([entry]) => {
    if (entry !== undefined && entry.contentRect.width > 0)
      windowWidth.value = entry.contentRect.width;
  });
  resized.observe(box);
  onCleanup(() => resized.disconnect());
});
const chat = useChatWidth();
const chatDrawn = computed(() => chatWidth(chat.chosen.value, windowWidth.value));
const startChatDrag = (event: PointerEvent) => {
  if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  chat.startDrag(event.clientX, windowWidth.value);
};
const nudgeChat = (event: KeyboardEvent) => {
  if (chat.nudge(event.key, windowWidth.value)) event.preventDefault();
};

watch(notices, (now, before) => {
  for (const text of now.slice(before.length)) toast.add({ title: text, color: "info" });
});

const { value: update } = useHeld(() => updatesAtom);
const { restart } = useActions();
// Each check says its finding again; a toast is for news not yet told.
const told = new Set<string>();
watch(update, (now) => {
  if (now === undefined) return;
  const { news } = now;
  if (news._tag !== "Ready" && news._tag !== "Refused") return;
  const id = `${news._tag} ${news.version}`;
  if (told.has(id)) return;
  told.add(id);
  if (news._tag === "Refused") {
    toast.add({
      title: `Desktop ${news.version} was not installed: ${news.reason}`,
      color: "error",
    });
    return;
  }
  toast.add({
    id: `update-${news.version}`,
    title: `Collie ${news.version} is ready, restart Desktop`,
    color: "info",
    duration: 0,
    actions: [
      {
        label: "Restart Desktop",
        onClick: () => void restart(),
      },
    ],
  });
});
</script>

<template>
  <div
    ref="root"
    class="flex h-screen"
    :class="chat.dragging.value !== null && 'cursor-col-resize select-none'"
  >
    <div class="@container/board flex min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-3 border-b border-default px-4 py-3">
        <!-- The ring keeps the white tile's edge on a light header. -->
        <img :src="tile" alt="" class="size-6 rounded-md ring-1 ring-default" />
        <strong>Collie</strong>
        <p
          data-testid="header"
          class="min-w-0 truncate"
          :class="header.urgent ? 'text-warning font-medium' : 'text-muted'"
        >
          {{ connecting ? "" : header.text }}
        </p>
        <div class="ml-auto flex items-center">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            data-testid="usage"
            :active="page?.kind === 'usage'"
            active-variant="soft"
            :aria-pressed="page?.kind === 'usage'"
            @click="toggle('usage')"
          >
            <template v-for="(entry, i) in usage.entries.value" :key="entry.key">
              <span v-if="i > 0" class="text-muted">·</span>
              <UTooltip :text="entry.title">
                <span :class="LEVEL_CLASS[entry.level]" :data-testid="`usage-${entry.key}`">
                  {{ entry.text }}
                </span>
              </UTooltip>
            </template>
            <template v-if="usage.entries.value.length === 0">Usage</template>
          </UButton>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-workflow"
          label="Workflows"
          :ui="{ label: NARROW_HIDDEN }"
          data-testid="workflows"
          :active="page?.kind === 'workflows'"
          active-variant="solid"
          :aria-pressed="page?.kind === 'workflows'"
          @click="toggle('workflows')"
        />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-server"
          data-testid="machines"
          :active="page?.kind === 'machines'"
          active-variant="solid"
          :aria-pressed="page?.kind === 'machines'"
          @click="toggle('machines')"
        >
          <span :class="NARROW_HIDDEN">Machines</span>
          <UBadge
            v-if="(summary?.count ?? 0) > 0"
            size="sm"
            color="warning"
            :label="String(summary?.count)"
            :aria-label="`${summary?.count} not in sync`"
            data-testid="machines-behind"
          />
        </UButton>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-settings"
          label="Settings"
          :ui="{ label: NARROW_HIDDEN }"
          data-testid="settings"
          :active="page?.kind === 'settings'"
          active-variant="solid"
          :aria-pressed="page?.kind === 'settings'"
          @click="toggle('settings')"
        />
        <OnboardDialog />
        <UButton
          v-if="!chatShown && !popped"
          icon="i-lucide-messages-square"
          color="neutral"
          variant="ghost"
          aria-label="Show the chat"
          data-testid="chat-show"
          @click="chatShown = true"
        />
      </header>
      <div class="relative min-h-0 flex-1">
        <main
          class="flex h-full flex-col gap-6 overflow-y-auto p-4"
          :inert="pageShown"
          @click="click"
          @dblclick="doubleClick"
        >
          <RetryNotice
            v-if="trouble !== null"
            title="Desktop is reconnecting to its Flock; showing what it last had"
            :trouble="trouble"
          />
          <p v-if="connecting" class="text-muted">Connecting…</p>
          <template v-else>
            <UAlert
              v-if="renewBy !== null"
              data-testid="renew-gitlab"
              color="warning"
              variant="subtle"
              icon="i-lucide-key-round"
              :title="`The GitLab token expires on ${renewBy}`"
              description="Make a new one and Renew it, and every Machine gets it."
              :actions="[{ label: 'Renew', onClick: () => void open('settings') }]"
            />
            <UAlert
              v-for="[profile, { name, state, reason }] in lost"
              :key="profile"
              :data-testid="`lost-${name}`"
              color="warning"
              variant="subtle"
              :icon="NOT_LIVE[state].icon"
              :title="NOT_LIVE[state].title(name)"
              :description="reason"
              :actions="
                state === 'no-collie'
                  ? [{ label: 'Onboard', onClick: () => onboardOn(profile) }]
                  : []
              "
            />
            <p v-if="tasks.length === 0" class="text-muted">Nothing on the board yet.</p>
            <template v-for="[section, label] in SECTIONS" :key="section">
              <section
                v-if="sections[section].length > 0"
                :data-testid="section"
                class="flex flex-col gap-2"
              >
                <template v-if="section === 'finished'">
                  <BoardGrid v-if="finished.unseen.length > 0" :tasks="finished.unseen" />
                  <details>
                    <summary class="cursor-pointer text-sm font-semibold text-muted">
                      {{ label }} · {{ sections.finished.length }}
                    </summary>
                    <BoardGrid :tasks="finished.seen" class="mt-2" />
                  </details>
                </template>
                <template v-else>
                  <h2
                    class="text-sm font-semibold"
                    :class="section === 'needs-you' ? 'text-warning' : 'text-muted'"
                  >
                    {{ label }}
                  </h2>
                  <BoardGrid :tasks="section === 'waiting' ? waiting.recent : sections[section]" />
                  <details v-if="section === 'waiting' && waiting.older.length > 0">
                    <summary class="cursor-pointer text-sm text-muted">
                      {{ waiting.older.length }} older than a week
                    </summary>
                    <BoardGrid :tasks="waiting.older" class="mt-2" />
                  </details>
                </template>
              </section>
            </template>
          </template>
        </main>
        <!-- Over the board, not instead of it, so the board keeps its scroll and folds. -->
        <RunRecord
          v-if="opened"
          :key="`${opened.key} ${opened.task.run}`"
          :placed="opened"
          class="absolute inset-0"
          @close="gesture({ kind: 'close' })"
        />
        <SettingsPage
          v-if="page?.kind === 'settings'"
          class="absolute inset-0"
          @back="gesture({ kind: 'close' })"
        />
        <MachinesPage
          v-if="page?.kind === 'machines'"
          class="absolute inset-0"
          @back="gesture({ kind: 'close' })"
        />
        <WorkflowsPage
          v-if="page?.kind === 'workflows'"
          class="absolute inset-0"
          @back="gesture({ kind: 'close' })"
        />
        <UsagePage
          v-if="page?.kind === 'usage'"
          class="absolute inset-0"
          @back="gesture({ kind: 'close' })"
        />
      </div>
    </div>
    <template v-if="!popped">
      <!-- Over the chat's border and edge, so it takes no width and the board's scrollbar stays clear. -->
      <div
        v-show="chatShown"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the chat"
        :aria-valuenow="Math.round(chatDrawn)"
        :aria-valuemin="CHAT_WIDTH.min"
        :aria-valuemax="Math.round(chatWidthMax(windowWidth))"
        tabindex="0"
        title="Drag to resize, double-click for the default width"
        class="group relative z-10 -mr-2 flex w-2 shrink-0 cursor-col-resize touch-none outline-none"
        data-testid="chat-resize"
        @pointerdown="startChatDrag"
        @pointermove="chat.drag($event.clientX, windowWidth)"
        @lostpointercapture="chat.settle"
        @keydown="nudgeChat"
        @keyup="chat.settle"
        @blur="chat.settle"
        @dblclick="chat.reset"
      >
        <div
          class="w-px transition-all group-hover:w-0.5 group-hover:bg-primary group-focus-visible:w-0.5 group-focus-visible:bg-primary"
          :class="chat.dragging.value !== null && 'w-0.5 bg-primary'"
        />
      </div>
      <FlockChat
        v-show="chatShown"
        class="shrink-0"
        :style="{ width: `${chatDrawn}px` }"
        @pop-out="popChatOut"
        @collapse="chatShown = false"
      />
    </template>
  </div>
</template>
