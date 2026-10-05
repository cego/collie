<script setup lang="ts">
/** A Run's item, by reference, read when first opened: a check's output, or a kept log. */
const props = defineProps<{
  title: string;
  item: string;
  installation: string;
  runId: string;
  initiallyOpen?: boolean;
}>();
const { textOf } = useActions();
const open = ref(props.initiallyOpen ?? false);
const text = ref<string | null>(null);
const failed = ref(false);
let reading = false;
watch(
  open,
  (now) => {
    if (!now || text.value !== null || reading) return;
    reading = true;
    void textOf(props.installation, props.runId, props.item).then((read) => {
      reading = false;
      text.value = read;
      failed.value = read === null;
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="rounded border border-default">
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm"
      data-testid="evidence-text-open"
      @click="open = !open"
    >
      <UIcon :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />
      <slot name="leading" />
      <span class="flex-1 truncate">{{ title }}</span>
      <slot name="trailing" />
    </button>
    <div v-if="open" class="border-t border-default p-2">
      <AnsiText v-if="text !== null" :text="text" />
      <p v-else class="text-sm text-muted">{{ failed ? "Could not be read." : "Reading…" }}</p>
    </div>
  </div>
</template>
