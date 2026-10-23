<script setup lang="ts">
import type { SelectMenuItem } from "@nuxt/ui";
import {
  type ChoiceSelect,
  searched,
  typedEntry,
  typedModel,
} from "../../../src/shared/chat-choices";

const props = defineProps<{ select: ChoiceSelect }>();
const emit = defineEmits<{ choose: [value: string] }>();
const search = ref("");

const items = computed((): SelectMenuItem[][] => [
  searched(props.select, search.value).map(({ value, label, description }) =>
    description === undefined ? { value, label } : { value, label, description },
  ),
  ...(props.select.note === null || props.select.reading
    ? []
    : [[{ type: "label" as const, label: props.select.note }]]),
]);

// Hoisted: the props' types omit the attributes Nuxt UI passes through to the input.
const SEARCH = {
  placeholder: "Search or type a model id",
  "aria-label": "Search or type a model id",
};
</script>

<template>
  <USelectMenu
    :model-value="select.value"
    :items="items"
    value-key="value"
    :aria-label="select.name"
    :search-input="SEARCH"
    v-model:search-term="search"
    ignore-filter
    :create-item="typedEntry(select, search) === null ? false : 'always'"
    size="sm"
    color="neutral"
    variant="soft"
    class="max-w-full"
    :ui="{ content: 'min-w-72' }"
    @update:model-value="(value: unknown) => emit('choose', String(value))"
    @create="(id: string) => emit('choose', id.trim())"
  >
    {{ select.label }}
    <template #create-item-label="{ item }">{{ typedModel(item) }}</template>
    <template v-if="select.warning !== null" #content-top>
      <UAlert
        :description="select.warning"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        class="m-1 w-auto"
      />
    </template>
    <template v-if="select.reading" #content-bottom>
      <p role="status" class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-3.5 shrink-0 animate-spin" />
        {{ select.note }}
      </p>
    </template>
  </USelectMenu>
</template>
