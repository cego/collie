<script setup lang="ts">
import * as Str from "effect/String";
const props = defineProps<{ title: string; initial?: string; sendLabel?: string }>();
const emit = defineEmits<{ send: [text: string] }>();
const open = defineModel<boolean>("open", { required: true });

const text = ref("");
watch(open, () => {
  text.value = props.initial ?? "";
});
const send = () => {
  const said = Str.trim(text.value);
  if (said === "") return;
  emit("send", said);
  open.value = false;
};
</script>

<template>
  <UModal v-model:open="open" :title="title">
    <template #body>
      <form class="flex flex-col gap-3" @submit.prevent="send">
        <UTextarea v-model="text" autofocus :rows="4" data-testid="words" />
        <UButton
          type="submit"
          class="self-end"
          :label="sendLabel ?? 'Send'"
          data-testid="send"
          :disabled="Str.trim(text) === ''"
        />
      </form>
    </template>
  </UModal>
</template>
