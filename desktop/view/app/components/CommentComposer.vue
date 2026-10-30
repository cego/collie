<script setup lang="ts">
import * as Str from "effect/String";
defineProps<{ location: string; quote?: string }>();
const emit = defineEmits<{ add: [text: string]; cancel: [] }>();
const words = ref("");
</script>

<template>
  <div class="flex flex-col gap-2 rounded border border-default bg-default p-3 font-sans">
    <span class="text-xs text-muted">Comment on {{ location }}</span>
    <blockquote v-if="quote" class="line-clamp-3 border-l-2 border-default pl-2 text-xs text-muted">
      {{ quote }}
    </blockquote>
    <UTextarea v-model="words" autofocus autoresize :rows="2" data-testid="comment-words" />
    <div class="flex gap-2">
      <UButton
        label="Comment"
        size="sm"
        :disabled="Str.trim(words) === ''"
        data-testid="add-comment"
        @click="emit('add', words)"
      />
      <UButton label="Cancel" size="sm" variant="ghost" @click="emit('cancel')" />
    </div>
  </div>
</template>
