<script setup lang="ts">
import { SECTIONS } from "../../../../src/board-model";
import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import type { NotLive } from "../../../src/shared/flock";
import { updatesAtom } from "../flock";
import tile from "../../../../assets/brand/logos/collie-tile-256.png";

const { connecting, failure, lost, machines, notices, tasks, sections, header, waiting, placedBy } =
  useFlock();
const { summary } = useInSync();
const starting = ref(false);
const listing = ref(false);
const setting = ref(false);
const { onboardOn } = useOnboarding();
const { renewBy } = useCredentials();
const drawer = useDrawer();
const opened = computed(() =>
  drawer.opened.value === null ? undefined : placedBy(drawer.opened.value),
);

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
          @click="listing = true"
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
        <MachinesPanel v-model:open="listing" />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-settings"
          label="Settings"
          data-testid="settings"
          @click="setting = true"
        />
        <SettingsPanel v-model:open="setting" />
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
      <main class="flex flex-col gap-6 p-4">
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
            :actions="[{ label: 'Renew', onClick: () => void (setting = true) }]"
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
