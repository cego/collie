<script setup lang="ts">
import type { SlackChoices } from "../../../../src/slack";
import { slackDestinationRow, pickSlackDestination } from "../../../src/shared/slack";

const props = defineProps<{
  id: string;
  setting: string;
  value: string;
  choices: SlackChoices | null;
}>();
const emit = defineEmits<{ choose: [value: string] }>();
const row = computed(() => slackDestinationRow(props.setting, props.value, props.choices));
const people = ref<ReadonlyArray<{ value: string; label: string }> | null>(null);
const refused = ref<string | null>(null);
const choose = (value: string) => {
  const picked = pickSlackDestination(props.setting, value, props.choices);
  if ("refused" in picked) {
    refused.value = picked.refused;
    return;
  }
  refused.value = null;
  if ("people" in picked) {
    people.value = picked.people;
    return;
  }
  people.value = null;
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
    <div v-if="people" class="flex flex-col gap-2">
      <label :for="`${id}-person`" class="text-sm font-medium">Which of these is you?</label>
      <USelectMenu
        :id="`${id}-person`"
        :items="[...people]"
        value-key="value"
        placeholder="Search people by name"
        class="w-full sm:w-80"
        @update:model-value="choose(String($event))"
      />
      <UButton label="Cancel" variant="ghost" size="xs" class="self-start" @click="people = null" />
    </div>
    <p v-if="refused" class="text-sm text-error" role="alert">{{ refused }}</p>
  </div>
</template>
