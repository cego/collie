<script setup lang="ts">
import { SECTIONS } from "../../../src/board-model";
import type { NotLive } from "../../src/shared/flock";

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
} = useFlock();
const starting = ref(false);

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
</script>

<template>
  <UApp>
    <header class="flex items-center gap-3 border-b border-default px-4 py-3">
      <UIcon name="i-lucide-dog" class="size-5 text-primary" />
      <strong>Collie</strong>
      <p data-testid="header" :class="header.urgent ? 'text-warning font-medium' : 'text-muted'">
        {{ connecting || failure !== null ? "" : header.text }}
      </p>
      <UButton
        class="ml-auto"
        icon="i-lucide-plus"
        label="New run"
        data-testid="new-run"
        :disabled="machines.length === 0"
        @click="starting = true"
      />
      <StartDialog v-model:open="starting" :machines="machines" />
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
        <!-- ponytail: Onboard is off until Desktop can onboard a Machine (ticket 32). -->
        <UAlert
          v-for="[profile, { name, state, reason }] in lost"
          :key="profile"
          :data-testid="`lost-${name}`"
          color="warning"
          variant="subtle"
          :icon="NOT_LIVE[state].icon"
          :title="NOT_LIVE[state].title(name)"
          :description="reason"
          :actions="state === 'no-collie' ? [{ label: 'Onboard', disabled: true }] : []"
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
  </UApp>
</template>
