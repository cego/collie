<script setup lang="ts">
import type { EvidenceFile } from "../../../../src/board-model";

const props = defineProps<{ file: EvidenceFile; installation: string; runId: string }>();
// Read only when asked: a video can be large, and is read whole before it plays.
const { url, state, load } = useEvidenceUrl(props.installation, props.runId, props.file.name);
</script>

<template>
  <figure class="flex flex-col gap-1" :data-testid="`video-${file.name}`">
    <video v-if="url" :src="url" controls autoplay class="max-h-96 w-full rounded" />
    <UButton
      v-else
      class="self-start"
      size="sm"
      icon="i-lucide-play"
      data-testid="video-play"
      :loading="state === 'reading'"
      :label="state === 'failed' ? 'Could not be read. Try again' : `Play (${file.bytes} bytes)`"
      @click="load"
    />
    <figcaption class="text-xs text-muted">{{ file.name }}</figcaption>
  </figure>
</template>
