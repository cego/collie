<script setup lang="ts">
import { useFilter } from "@nuxt/ui/composables/useFilter";
import { type ChoiceSelect, modelMenu } from "../../../src/shared/chat-choices";

const props = defineProps<{ select: ChoiceSelect }>();
const emit = defineEmits<{ choose: [value: string] }>();

// Reka requires a nonempty option value.
const UNSET = "(default)";
const search = ref("");
const { filterGroups } = useFilter();
const items = computed(() => {
  const menu = modelMenu(search.value, props.select);
  return filterGroups(menu.groups, menu.query, { fields: ["label", "value"] }).map((group) =>
    group.map((option) => ({
      ...option,
      value: option.value || UNSET,
      ...("typed" in option && { icon: "i-lucide-plus" }),
      onSelect: () => emit("choose", option.value),
    })),
  );
});
</script>

<template>
  <USelectMenu
    v-model:search-term="search"
    :model-value="select.value || UNSET"
    :items="items"
    value-key="value"
    :aria-label="select.name"
    :search-input="{ placeholder: 'Search or type a model id' }"
    ignore-filter
    color="neutral"
    variant="soft"
    size="sm"
    class="max-w-full"
    :ui="{ content: 'min-w-72' }"
  >
    <span class="truncate">{{ select.label }}</span>
    <template v-if="select.warning" #content-top>
      <div
        role="status"
        class="flex items-start gap-2 border-b border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning"
      >
        <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>{{ select.warning }}</p>
      </div>
    </template>
    <template #item-label="{ item }">
      <template v-if="'typed' in item">
        Use <strong class="font-semibold">{{ item.typed }}</strong>
      </template>
      <template v-else>{{ item.label }}</template>
    </template>
    <template v-if="select.note !== null" #content-bottom>
      <div
        role="status"
        class="flex items-start gap-2 border-t border-default px-3 py-2 text-xs text-muted"
      >
        <UIcon
          v-if="select.reading"
          name="i-lucide-loader-circle"
          class="mt-0.5 size-3 shrink-0 animate-spin"
          aria-hidden="true"
        />
        <p>{{ select.note }}</p>
      </div>
    </template>
  </USelectMenu>
</template>
