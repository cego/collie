<script setup lang="ts">
import { type Answers, questionsOf } from "../../../src/shared/chat-view";

const props = defineProps<{ args: string }>();
const emit = defineEmits<{ answer: [answers: Answers] }>();

const questions = computed(() => questionsOf(props.args));
const picked = ref<Record<string, ReadonlyArray<string>>>({});
/** One question with one choice is answered by the click; anything more by Answer. */
const atOnce = computed(
  () => questions.value.length === 1 && questions.value[0]?.multiSelect !== true,
);
const answers = () =>
  Object.fromEntries(
    questions.value.map(({ question }) => [question, (picked.value[question] ?? []).join(", ")]),
  );
const pick = (question: string, label: string, many: boolean) => {
  const now = picked.value[question] ?? [];
  picked.value = {
    ...picked.value,
    [question]: many
      ? now.includes(label)
        ? now.filter((one) => one !== label)
        : [...now, label]
      : [label],
  };
  if (atOnce.value) emit("answer", answers());
};
const complete = computed(() =>
  questions.value.every(({ question }) => (picked.value[question] ?? []).length > 0),
);
</script>

<template>
  <div data-testid="chat-question" class="flex flex-col gap-3 rounded-md border border-default p-3">
    <div v-for="one in questions" :key="one.question" class="flex flex-col gap-2">
      <p class="text-sm font-medium">{{ one.question }}</p>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-for="option in one.options"
          :key="option.label"
          size="sm"
          :label="option.label"
          :title="option.description"
          :variant="(picked[one.question] ?? []).includes(option.label) ? 'solid' : 'outline'"
          @click="pick(one.question, option.label, one.multiSelect === true)"
        />
      </div>
    </div>
    <UButton
      v-if="!atOnce"
      class="self-start"
      size="sm"
      label="Answer"
      :disabled="!complete"
      @click="emit('answer', answers())"
    />
  </div>
</template>
