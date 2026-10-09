<script setup lang="ts">
/** A page's back button and title. */
defineProps<{ title: string }>();
const emit = defineEmits<{ back: [] }>();
</script>

<template>
  <header class="shrink-0 border-b border-default px-4 py-3">
    <div class="flex items-start gap-3" :class="readingClass">
      <UButton
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="ghost"
        aria-label="Back to the board"
        data-testid="page-back"
        @click="emit('back')"
      />
      <div class="min-w-0">
        <h2 class="font-semibold" data-testid="page-title">{{ title }}</h2>
        <slot />
      </div>
    </div>
  </header>
</template>
