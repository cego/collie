<script setup lang="ts">
defineProps<{ full: string | null; focusing: boolean }>();
const emit = defineEmits<{ full: []; focus: [] }>();
</script>

<template>
  <div class="ml-auto flex shrink-0 items-center gap-1">
    <UTooltip v-if="full !== null" :text="full">
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-app-window"
        :aria-label="full"
        @click="emit('full')"
      />
    </UTooltip>
    <UTooltip :text="focusing ? 'Restore · Ctrl+Shift+F or Esc' : 'Focus · Ctrl+Shift+F'">
      <UButton
        color="neutral"
        :variant="focusing ? 'soft' : 'ghost'"
        size="xs"
        :icon="focusing ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
        :label="focusing ? 'Restore' : 'Focus'"
        :aria-pressed="focusing"
        aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
        data-testid="flow-focus"
        @click="emit('focus')"
      />
    </UTooltip>
  </div>
</template>
