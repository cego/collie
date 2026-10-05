<script setup lang="ts">
import type { Startable } from "../../../../src/board-model";

const props = defineProps<{
  machines: ReadonlyArray<{ installation: string; name: string; projects: ReadonlyArray<string> }>;
}>();
const open = defineModel<boolean>("open", { required: true });
const { run, workflowsIn } = useActions();

const installation = ref("");
const project = ref("");
const startable = ref<ReadonlyArray<Startable> | null>(null);
const workflow = ref<Startable | null>(null);
const typed = ref<Record<string, string>>({});

const machine = computed(() =>
  props.machines.find((one) => one.installation === installation.value),
);
watch(open, (isOpen) => {
  if (!isOpen) return;
  installation.value = props.machines[0]?.installation ?? "";
  project.value = machine.value?.projects[0] ?? "";
  startable.value = null;
  workflow.value = null;
});

const find = async () => {
  workflow.value = null;
  startable.value = await workflowsIn(installation.value, project.value.trim());
};
const choose = (one: Startable) => {
  workflow.value = one;
  typed.value = {};
};
const start = async () => {
  const chosen = workflow.value;
  if (chosen === null) return;
  // Only what was typed: the host settles each value against the workflow's own schema.
  const text = Object.fromEntries(
    Object.entries(typed.value).filter(([, value]) => value.trim() !== ""),
  );
  if (
    await run(installation.value, {
      _tag: "Start",
      project: project.value.trim(),
      id: chosen.id,
      text,
    })
  )
    open.value = false;
};
</script>

<template>
  <UModal v-model:open="open" title="New run">
    <template #body>
      <div class="flex flex-col gap-3">
        <UFormField v-if="machines.length > 1" label="Machine">
          <USelect
            v-model="installation"
            class="w-full"
            data-testid="machine"
            :items="machines.map((one) => ({ label: one.name, value: one.installation }))"
          />
        </UFormField>
        <UFormField label="Project" help="A checkout on that Machine">
          <div class="flex gap-2">
            <UInput v-model="project" class="flex-1" data-testid="project" />
            <UButton label="Find workflows" data-testid="find-workflows" @click="find" />
          </div>
        </UFormField>
        <div v-if="machine && machine.projects.length > 0" class="flex flex-wrap gap-1">
          <UButton
            v-for="known in machine.projects"
            :key="known"
            size="xs"
            color="neutral"
            variant="soft"
            :label="known.split('/').at(-1)"
            @click="project = known"
          />
        </div>
        <div v-if="startable !== null" class="flex flex-wrap gap-2">
          <p v-if="startable.length === 0" class="text-muted">Nothing can be started there.</p>
          <UButton
            v-for="one in startable"
            :key="one.id"
            :data-testid="`workflow-${one.id}`"
            :variant="workflow?.id === one.id ? 'solid' : 'outline'"
            :label="one.title"
            :title="one.description"
            @click="choose(one)"
          />
        </div>
        <form v-if="workflow" class="flex flex-col gap-3" @submit.prevent="start">
          <UFormField
            v-for="input in workflow.inputs"
            :key="input.name"
            :label="input.name"
            :required="input.required"
          >
            <UInput
              v-model="typed[input.name]"
              class="w-full"
              :data-testid="`input-${input.name}`"
            />
          </UFormField>
          <UButton
            type="submit"
            class="self-end"
            :label="`Start ${workflow.title}`"
            data-testid="start"
          />
        </form>
      </div>
    </template>
  </UModal>
</template>
