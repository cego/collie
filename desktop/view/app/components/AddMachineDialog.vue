<script setup lang="ts">
import { machineToAdd } from "../../../src/shared/flock";

const open = defineModel<boolean>("open", { required: true });
const { addMachine } = useActions();
const { job } = useOnboarding();

const typed = reactive({ target: "", label: "", session: "default" });
watch(open, (now) => now && Object.assign(typed, { target: "", label: "", session: "default" }));
const adding = computed(() => machineToAdd(typed));
const add = async () => {
  const machine = adding.value;
  if (machine === null) return;
  open.value = false;
  const started = await addMachine(machine.target, machine.label, machine.session);
  if (started !== null) job.value = started;
};
</script>

<template>
  <UModal v-model:open="open" title="Add Machine">
    <template #body>
      <form class="flex flex-col gap-2" data-testid="add-form" @submit.prevent="add">
        <UFormField label="SSH target" help="As ssh reaches it, such as mk@vm-mk.example">
          <UInput v-model="typed.target" autofocus class="w-full" data-testid="add-target" />
        </UFormField>
        <div class="flex gap-2">
          <UFormField label="Label" class="flex-1">
            <UInput v-model="typed.label" class="w-full" data-testid="add-label" />
          </UFormField>
          <UFormField label="herdr session" class="flex-1">
            <UInput v-model="typed.session" class="w-full" data-testid="add-session" />
          </UFormField>
        </div>
        <UButton
          type="submit"
          class="self-end"
          icon="i-lucide-plus"
          label="Add Machine"
          data-testid="add-submit"
          :disabled="adding === null"
        />
      </form>
    </template>
  </UModal>
</template>
