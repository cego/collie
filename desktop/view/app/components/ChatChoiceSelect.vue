<script setup lang="ts">
import * as Arr from "effect/Array";
import type { ChoiceSelect } from "../../../src/shared/chat-choices";

const props = defineProps<{ select: ChoiceSelect }>();
const emit = defineEmits<{ choose: [value: string] }>();

// Reka requires a nonempty option value.
const UNSET = "(default)";
const items = computed(() => {
  const options = Arr.map(props.select.options, (option) => ({
    ...option,
    value: option.value || UNSET,
    onSelect: () => {
      if (!option.disabled) emit("choose", option.value);
    },
  }));
  const [first, ...rest] = options;
  return first?.value === UNSET ? [[first], rest] : [options];
});
</script>

<template>
  <UButton
    v-if="select.disabled"
    disabled
    color="neutral"
    variant="outline"
    size="sm"
    class="max-w-full border border-dashed border-accented ring-0"
    :aria-label="select.name"
  >
    <span class="truncate">{{ select.label }}</span>
  </UButton>
  <USelect
    v-else
    :model-value="select.value || UNSET"
    :items="items"
    :aria-label="select.name"
    color="neutral"
    variant="soft"
    size="sm"
    class="max-w-full"
    :ui="{ content: 'min-w-60' }"
  >
    <span class="truncate">{{ select.label }}</span>
    <template v-if="select.note !== null" #content-bottom>
      <p class="border-t border-default px-3 py-2 text-xs text-muted">{{ select.note }}</p>
    </template>
  </USelect>
</template>
