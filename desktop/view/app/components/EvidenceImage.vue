<script setup lang="ts">
import type { EvidenceFile } from "../../../../src/board-model";

const props = defineProps<{
  file: Pick<EvidenceFile, "name">;
  installation: string;
  runId: string;
  kind?: "evidence" | "attachment";
}>();
const { url, state, load } = useEvidenceUrl(
  props.installation,
  props.runId,
  props.file.name,
  props.kind,
);
load();
</script>

<template>
  <figure class="flex min-w-0 flex-1 flex-col gap-1" :data-testid="`image-${file.name}`">
    <img
      v-if="url"
      :src="url"
      :alt="file.name"
      class="max-h-80 w-full rounded border border-default object-contain"
    />
    <p v-else class="text-sm text-muted">
      {{ state === "failed" ? "Could not be read." : "Reading…" }}
    </p>
    <figcaption class="truncate text-xs text-muted">{{ file.name }}</figcaption>
  </figure>
</template>
