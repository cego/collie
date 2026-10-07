<script setup lang="ts">
import { SECTIONS } from "../../../../src/board-model";
import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import type { NotLive } from "../../../src/shared/flock";
import { updatesAtom } from "../flock";

const {
  connecting,
  failure,
  lost,
  machines,
  developments,
  notices,
  tasks,
  sections,
  header,
  waiting,
  placedBy,
} = useFlock();
const starting = ref(false);
const listing = ref(false);
const { onboardOn } = useOnboarding();
const { renewBy } = useCredentials();
const drawer = useDrawer();
const opened = computed(() =>
  drawer.opened.value === null ? undefined : placedBy(drawer.opened.value),
);

const { choose } = useChip();
/** A click on the board's own area, on no card and no control, lets the selected card go. */
const background = (event: MouseEvent) => {
  const onCard = event.target instanceof Element && event.target.closest("[data-card]") !== null;
  if (!onControl(event) && !onCard) choose(null);
};
/** Escape backs out one level: an overlay closes itself, and the board lets its card go. */
const escape = (event: KeyboardEvent) => {
  if (event.key !== "Escape") return;
  const typing = event.target;
  if (
    typing instanceof HTMLElement &&
    (typing.isContentEditable || typing.closest("input, textarea, select") !== null)
  )
    return;
  // Overlays close on Escape themselves, without marking it handled.
  const overlay = '[data-state="open"]:is([role="dialog"], [role="alertdialog"], [role="menu"])';
  if (document.querySelector(overlay) !== null) return;
  choose(null);
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

const toast = useToast();
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
    <div class="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <header class="flex items-center gap-3 border-b border-default px-4 py-3">
        <UIcon name="i-lucide-dog" class="size-5 text-primary" />
        <strong>Collie</strong>
        <p data-testid="header" :class="header.urgent ? 'text-warning font-medium' : 'text-muted'">
          {{ connecting || failure !== null ? "" : header.text }}
        </p>
        <UButton
          class="ml-auto"
          color="neutral"
          variant="outline"
          icon="i-lucide-server"
          label="Machines"
          data-testid="machines"
          @click="listing = true"
        />
        <MachinesPanel v-model:open="listing" />
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
      <main class="flex flex-1 flex-col gap-6 p-4" @click="background">
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
            :actions="[{ label: 'Renew', onClick: () => void (listing = true) }]"
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
              state === 'no-collie' ? [{ label: 'Onboard', onClick: () => onboardOn(profile) }] : []
            "
          />
          <UAlert
            v-for="{ name, development } in developments"
            :key="name"
            :data-testid="`development-${name}`"
            color="neutral"
            variant="subtle"
            icon="i-lucide-flask-conical"
            :title="name"
            :description="`development build ${development}`"
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
    </div>
    <FlockChat
      v-if="!popped"
      v-show="chatShown"
      class="w-[min(32rem,40vw)] shrink-0"
      @pop-out="popChatOut"
      @collapse="chatShown = false"
    />
    <RunDrawer
      v-if="opened"
      :key="`${opened.key} ${opened.task.run}`"
      :placed="opened"
      @close="drawer.close()"
    />
  </div>
</template>
