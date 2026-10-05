<script setup lang="ts">
defineProps<{ title: string }>();
const emit = defineEmits<{ send: [text: string] }>();
const open = defineModel<boolean>("open", { required: true });

const text = ref("");
watch(open, () => {
  text.value = "";
});
const send = () => {
  const said = text.value.trim();
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
          label="Send"
          data-testid="send"
          :disabled="text.trim() === ''"
        />
      </form>
    </template>
  </UModal>
</template>
