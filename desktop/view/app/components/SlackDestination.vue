<script setup lang="ts">
import type { SlackChannel } from "../../../../src/slack";
import { slackDestinationRow, pickSlackDestination } from "../../../src/shared/slack";

const props = defineProps<{
  id: string;
  setting: string;
  value: string;
  yours: ReadonlyArray<typeof SlackChannel.Type> | null;
}>();
const emit = defineEmits<{ choose: [value: string] }>();
const row = computed(() => slackDestinationRow(props.setting, props.value, props.yours));
const refused = ref<string | null>(null);
const choose = (value: string) => {
  const picked = pickSlackDestination(value, props.yours);
  if ("refused" in picked) {
    refused.value = picked.refused;
    return;
  }
  refused.value = null;
  emit("choose", picked.value);
};
</script>

<template>
  <div class="flex flex-col gap-2">
    <USelect
      :id="id"
      :model-value="value"
      :items="row.options"
      :disabled="row.disabled"
      class="w-full sm:w-80"
      :aria-describedby="`${id}-slack-hint`"
      @update:model-value="choose(String($event))"
    />
    <p v-if="row.hint" :id="`${id}-slack-hint`" class="text-sm text-muted">{{ row.hint }}</p>
    <p v-if="refused" class="text-sm text-error" role="alert">{{ refused }}</p>
  </div>
</template>
