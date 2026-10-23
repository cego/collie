<script setup lang="ts">
import type { SelectItem } from "@nuxt/ui";
import type { ChoiceSelect } from "../../../src/shared/chat-choices";

const props = defineProps<{ select: ChoiceSelect }>();
const emit = defineEmits<{ choose: [value: string] }>();

const items = computed((): SelectItem[][] => [
  props.select.options.map(({ value, label, description, disabled }) => ({
    value,
    label,
    description: disabled ?? description,
    disabled: disabled !== undefined,
  })),
  ...(props.select.note === null ? [] : [[{ type: "label" as const, label: props.select.note }]]),
]);
</script>

<template>
  <USelect
    :model-value="select.value"
    :items="items"
    :disabled="select.disabled !== null"
    :aria-label="select.name"
    :title="select.disabled ?? undefined"
    size="sm"
    color="neutral"
    :variant="select.disabled === null ? 'soft' : 'outline'"
    :class="select.disabled === null ? '' : 'border border-dashed border-accented ring-0'"
    :trailing-icon="select.disabled === null ? undefined : ''"
    class="max-w-full"
    :ui="{ content: 'min-w-60' }"
    @update:model-value="(value: unknown) => emit('choose', String(value))"
  >
    {{ select.label }}
  </USelect>
</template>
