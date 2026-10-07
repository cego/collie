<script setup lang="ts">
import type { Attached } from "../../../src/shared/attachments";

const props = defineProps<{ file: Attached; removable?: boolean }>();
const emit = defineEmits<{ remove: [] }>();

const { bytesOf } = useAttachments();
const url = ref<string | null>(null);
let gone = false;
if (props.file.mediaType.startsWith("image/"))
  void bytesOf(props.file).then((blob) => {
    if (blob !== null && !gone) url.value = URL.createObjectURL(blob);
  });
onBeforeUnmount(() => {
  gone = true;
  if (url.value !== null) URL.revokeObjectURL(url.value);
});

const size = computed(() =>
  props.file.size < 1024 * 1024
    ? `${Math.max(1, Math.round(props.file.size / 1024))} KB`
    : `${(props.file.size / 1024 / 1024).toFixed(1)} MB`,
);
</script>

<template>
  <span
    data-testid="chat-attachment"
    class="inline-flex max-w-56 items-center gap-2 rounded-md border border-default bg-default px-2 py-1 text-xs"
  >
    <img v-if="url" :src="url" :alt="file.name" class="size-8 rounded object-cover" />
    <UIcon v-else name="i-lucide-paperclip" class="size-4 shrink-0 text-muted" />
    <span class="truncate" :title="file.name">{{ file.name }}</span>
    <span class="shrink-0 text-muted">{{ size }}</span>
    <UButton
      v-if="removable"
      icon="i-lucide-x"
      color="neutral"
      variant="link"
      size="xs"
      :aria-label="`Remove ${file.name}`"
      @click="emit('remove')"
    />
  </span>
</template>
