<script setup lang="ts">
import type { EvidenceFile } from "../../../../src/board-model";

const props = defineProps<{ file: EvidenceFile; installation: string; runId: string }>();
const { url, failed } = useEvidenceUrl(props.installation, props.runId, () => props.file.name);
</script>

<template>
  <figure class="flex flex-col gap-1" :data-testid="`video-${file.name}`">
    <video v-if="url" :src="url" controls preload="metadata" class="max-h-96 w-full rounded" />
    <p v-else class="text-sm text-muted">{{ failed ? "Could not be read." : "Reading…" }}</p>
    <figcaption class="text-xs text-muted">{{ file.name }}</figcaption>
  </figure>
</template>
