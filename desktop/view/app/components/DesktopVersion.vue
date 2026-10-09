<script setup lang="ts">
import type { UpdateNews } from "../../../src/shared/flock";
import { updatesAtom } from "../flock";

const { value: updates, trouble } = useHeld(() => updatesAtom);
const { checkForUpdates, restart } = useActions();
const now = computed(() => updates.value ?? null);

const said = (news: UpdateNews, version: string) => {
  switch (news._tag) {
    case "Checking":
      return "Checking for updates…";
    case "UpToDate":
      return `Collie ${version} is up to date`;
    case "Downloading":
      return `Downloading ${news.version}`;
    case "Ready":
      return `Collie ${news.version} is ready, restart Desktop`;
    case "Refused":
      return `Desktop ${news.version} was not installed: ${news.reason}`;
    case "Failed":
      return `Could not check for updates: ${news.reason}`;
    case "Never":
      return `${news.reason.charAt(0).toUpperCase()}${news.reason.slice(1)}.`;
  }
};
</script>

<template>
  <RetryNotice
    v-if="trouble !== null"
    title="Desktop could not hear about its updates; showing what it last heard"
    :trouble="trouble"
  />
  <section v-if="now" class="flex flex-col gap-2" data-testid="desktop-version">
    <div class="flex items-center gap-2">
      <span class="font-medium">Collie Desktop {{ now.version }}</span>
      <UButton
        v-if="now.news._tag === 'Ready'"
        class="ml-auto"
        size="xs"
        icon="i-lucide-rotate-cw"
        label="Restart Desktop"
        data-testid="restart-desktop"
        @click="restart()"
      />
      <UButton
        v-else
        class="ml-auto"
        size="xs"
        variant="outline"
        icon="i-lucide-refresh-cw"
        label="Check for updates"
        data-testid="check-for-updates"
        :loading="now.news._tag === 'Checking' || now.news._tag === 'Downloading'"
        :disabled="now.news._tag === 'Never'"
        @click="checkForUpdates()"
      />
    </div>
    <p class="text-sm text-muted" data-testid="update-state">{{ said(now.news, now.version) }}</p>
  </section>
</template>
