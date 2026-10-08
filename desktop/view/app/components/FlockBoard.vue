<script setup lang="ts">
import { SECTIONS } from "../../../../src/board-model";
import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import type { NotLive } from "../../../src/shared/flock";
import { afterGesture, escapeOn, type Gesture, landedOn } from "../../../src/shared/board-clicks";
import { updatesAtom } from "../flock";
import tile from "../../../../assets/brand/logos/collie-tile-256.png";

const {
  connecting,
  failure,
  lost,
  machines,
  notices,
  tasks,
  sections,
  header,
  waiting,
  placedBy,
  placedAt,
} = useFlock();
const { summary } = useInSync();
const starting = ref(false);
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
  if (after.page === null) back();
  else showRecord(after.page, tab);
};
provide("gesture", gesture);
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

const NOT_LIVE: Record<NotLive, { icon: string; title: (name: string) => string }> = {
  unreachable: { icon: "i-lucide-unplug", title: (name) => `${name} is out of reach` },
  sso: { icon: "i-lucide-key-round", title: (name) => `Waiting for SSO login on ${name}` },
  "no-collie": { icon: "i-lucide-package-x", title: (name) => `Collie isn't installed on ${name}` },
  "update-desktop": {
    icon: "i-lucide-circle-arrow-up",
    title: (name) => `Update Desktop to see ${name}`,
  },
};

watch(notices, (now, before) => {
  for (const text of now.slice(before.length)) toast.add({ title: text, color: "info" });
});

const update = useAtomValue(() => updatesAtom);
const { restart } = useActions();
// Each check says its finding again; a toast is for news not yet told.
const told = new Set<string>();
watch(update, (now) => {
  if (!AsyncResult.isSuccess(now)) return;
  const { news } = now.value;
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
  <div class="flex h-screen">
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-3 border-b border-default px-4 py-3">
        <!-- The ring keeps the white tile's edge on a light header. -->
        <img :src="tile" alt="" class="size-6 rounded-md ring-1 ring-default" />
        <strong>Collie</strong>
        <p data-testid="header" :class="header.urgent ? 'text-warning font-medium' : 'text-muted'">
          {{ connecting || failure !== null ? "" : header.text }}
        </p>
        <UButton
          class="ml-auto"
          color="neutral"
          variant="outline"
          icon="i-lucide-server"
          data-testid="machines"
          :active="page?.kind === 'machines'"
          active-variant="solid"
          :aria-pressed="page?.kind === 'machines'"
          @click="toggle('machines')"
        >
          Machines
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
          data-testid="settings"
          :active="page?.kind === 'settings'"
          active-variant="solid"
          :aria-pressed="page?.kind === 'settings'"
          @click="toggle('settings')"
        />
        <OnboardDialog />
        <UButton
          icon="i-lucide-plus"
          label="New run"
          data-testid="new-run"
          :disabled="machines.length === 0"
          @click="starting = true"
        />
        <StartDialog v-model:open="starting" :machines="machines" />
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
          <p v-if="connecting" class="text-muted">Connecting…</p>
          <UAlert
            v-else-if="failure !== null"
            color="error"
            icon="i-lucide-triangle-alert"
            title="Collie is out of reach"
            :description="failure"
          />
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
                <details v-if="section === 'finished'">
                  <summary class="cursor-pointer text-sm font-semibold text-muted">
                    {{ label }} · {{ sections.finished.length }}
                  </summary>
                  <BoardGrid :tasks="sections.finished" class="mt-2" />
                </details>
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
      </div>
    </div>
    <FlockChat
      v-if="!popped"
      v-show="chatShown"
      class="w-[min(32rem,40vw)] shrink-0"
      @pop-out="popChatOut"
      @collapse="chatShown = false"
    />
  </div>
</template>
