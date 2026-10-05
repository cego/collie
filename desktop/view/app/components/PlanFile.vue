<script lang="ts">
/** A plan file's markdown, and whether it is shown cut short; or why it has none. */
export type PlanText = { text: string; cut?: string | null } | { failed: string };
</script>

<script setup lang="ts">
defineProps<{ file: PlanText | null | undefined; from: string }>();
</script>

<template>
  <template v-if="file && 'text' in file">
    <RichMarkdown :text="file.text" :from="from" />
    <p v-if="file.cut" class="text-muted text-sm" data-testid="cut">{{ file.cut }}</p>
  </template>
  <p v-else-if="file" class="text-muted text-sm" data-testid="unread">{{ file.failed }}</p>
  <p v-else class="text-muted text-sm">Reading…</p>
</template>
