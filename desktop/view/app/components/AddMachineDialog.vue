<script setup lang="ts">
const open = defineModel<boolean>("open", { required: true });
const { addMachine } = useActions();
const { job } = useOnboarding();

const target = ref("");
const label = ref("");
const session = ref("default");
const filled = computed(
  () => target.value.trim() !== "" && label.value.trim() !== "" && session.value.trim() !== "",
);
const add = async () => {
  if (!filled.value) return;
  open.value = false;
  const started = await addMachine(target.value.trim(), label.value.trim(), session.value.trim());
  if (started !== null) job.value = started;
  target.value = "";
  label.value = "";
};
</script>

<template>
  <UModal v-model:open="open" title="Add Machine">
    <template #body>
      <form class="flex flex-col gap-2" data-testid="add-form" @submit.prevent="add">
        <UFormField label="SSH target" help="As ssh reaches it, such as mk@vm-mk.example">
          <UInput v-model="target" autofocus class="w-full" data-testid="add-target" />
        </UFormField>
        <div class="flex gap-2">
          <UFormField label="Label" class="flex-1">
            <UInput v-model="label" class="w-full" data-testid="add-label" />
          </UFormField>
          <UFormField label="herdr session" class="flex-1">
            <UInput v-model="session" class="w-full" data-testid="add-session" />
          </UFormField>
        </div>
        <UButton
          type="submit"
          class="self-end"
          icon="i-lucide-plus"
          label="Add Machine"
          data-testid="add-submit"
          :disabled="!filled"
        />
      </form>
    </template>
  </UModal>
</template>
