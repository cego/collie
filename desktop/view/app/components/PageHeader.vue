<script setup lang="ts">
/** A page's back button and title; the back button takes focus as the page opens. */
defineProps<{ title: string }>();
const emit = defineEmits<{ back: [] }>();
const back = useTemplateRef<{ $el: HTMLElement }>("back");
onMounted(() => back.value?.$el.focus());
</script>

<template>
  <header class="flex shrink-0 items-start gap-3 border-b border-default px-4 py-3">
    <UButton
      ref="back"
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
  </header>
</template>
