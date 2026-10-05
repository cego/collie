<script setup lang="ts">
import type { EvidenceFile } from "../../../../src/board-model";

const props = defineProps<{ file: EvidenceFile; installation: string; runId: string }>();
const { url, failed } = useEvidenceUrl(props.installation, props.runId, () => props.file.name);
</script>

<template>
  <figure class="flex min-w-0 flex-1 flex-col gap-1" :data-testid="`image-${file.name}`">
    <img
      v-if="url"
      :src="url"
      :alt="file.name"
      class="max-h-80 w-full rounded border border-default object-contain"
    />
    <p v-else class="text-sm text-muted">{{ failed ? "Could not be read." : "Reading…" }}</p>
    <figcaption class="truncate text-xs text-muted">{{ file.name }}</figcaption>
  </figure>
</template>
