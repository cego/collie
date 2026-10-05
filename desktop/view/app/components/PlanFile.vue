<script lang="ts">
/** A plan file's markdown, or why it has none. */
export type PlanText = { text: string } | { failed: string };
</script>

<script setup lang="ts">
defineProps<{ file: PlanText | null | undefined; from: string }>();
</script>

<template>
  <RichMarkdown v-if="file && 'text' in file" :text="file.text" :from="from" />
  <p v-else-if="file" class="text-muted text-sm" data-testid="unread">{{ file.failed }}</p>
  <p v-else class="text-muted text-sm">Reading…</p>
</template>
