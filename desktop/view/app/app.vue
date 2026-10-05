<script setup lang="ts">
import { SECTIONS } from "../../../src/board-model";

const { connecting, failure, lost, machines, tasks, sections, header, waiting, placedBy } =
  useFlock();
const starting = ref(false);
const drawer = useDrawer();
const opened = computed(() =>
  drawer.opened.value === null ? undefined : placedBy(drawer.opened.value),
);
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
        <UAlert
          v-for="[route, { name, reason }] in lost"
          :key="route"
          :data-testid="`lost-${name}`"
          color="warning"
          variant="subtle"
          icon="i-lucide-unplug"
          :title="`${name} is out of reach`"
          :description="reason"
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
    <RunDrawer
      v-if="opened"
      :key="`${opened.key} ${opened.task.run}`"
      :placed="opened"
      :open="true"
      @update:open="(still: boolean) => !still && drawer.close()"
    />
  </UApp>
</template>
