<script setup lang="ts">
import * as Arr from "effect/Array";
const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{
  name: string;
  from: string;
  /** The other reachable Machines, by installation. */
  targets: ReadonlyArray<{ readonly installation: string; readonly name: string }>;
}>();
const { move } = useSchedules();

const typed = reactive({ to: "", checkout: "" });
watch(
  open,
  (now) => now && Object.assign(typed, { to: props.targets[0]?.installation ?? "", checkout: "" }),
);
const items = computed(() =>
  Arr.map(props.targets, ({ installation, name }) => ({
    label: name,
    value: installation,
  })),
);
const submit = () => {
  if (typed.to === "") return;
  open.value = false;
  void move(props.from, typed.to, props.name, typed.checkout);
};
</script>

<template>
  <UModal v-model:open="open" :title="`Move ${name} to…`">
    <template #body>
      <p v-if="targets.length === 0" class="text-sm text-muted">
        No other Machine is reachable to move it to.
      </p>
      <form v-else class="flex flex-col gap-2" data-testid="move-form" @submit.prevent="submit">
        <UFormField label="Machine">
          <USelect v-model="typed.to" :items="items" class="w-full" data-testid="move-to" />
        </UFormField>
        <UFormField
          label="Checkout there"
          help="Its absolute path on that Machine, where it differs; empty keeps the same path"
        >
          <UInput v-model="typed.checkout" class="w-full" data-testid="move-checkout" />
        </UFormField>
        <UButton
          type="submit"
          class="self-end"
          icon="i-lucide-arrow-right-left"
          label="Move"
          data-testid="move-submit"
          :disabled="typed.to === ''"
        />
      </form>
    </template>
  </UModal>
</template>
