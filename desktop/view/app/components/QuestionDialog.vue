<script setup lang="ts">
import * as Str from "effect/String";
import type { Question } from "../../../../src/board-model";
import {
  answerKey,
  draftOf,
  sittingAnswered,
  sittingMoved,
  sittingSees,
  sittingStarts,
  sittingView,
} from "../../../src/shared/pending-answer";

const props = defineProps<{
  title: string;
  installation: string;
  open: ReadonlyArray<Question>;
}>();
const emit = defineEmits<{
  close: [];
  answer: [question: Question, value: string, shown: string];
}>();
const answering = useAnswering();

const now = computed(() => ({
  installation: props.installation,
  open: props.open,
  answering: answering.state.value,
}));
const sitting = ref(sittingStarts(now.value));
watch(now, (seen) => (sitting.value = sittingSees(sitting.value, seen)));
const view = computed(() => sittingView(sitting.value, now.value));
watch(
  () => view.value.done,
  (done) => done && emit("close"),
  { immediate: true },
);

const key = computed(() =>
  view.value.question === null
    ? null
    : answerKey(props.installation, view.value.question.run, view.value.question.id),
);
const draft = computed({
  get: () => (key.value === null ? "" : draftOf(answering.state.value, key.value)),
  set: (text: string) => key.value !== null && answering.type(key.value, text),
});

const send = (question: Question, value: string, shown: string) => {
  emit("answer", question, value, shown);
  sitting.value = sittingAnswered(sitting.value, now.value);
};
const sendTyped = (question: Question) => {
  const said = Str.trim(draft.value);
  if (said !== "") send(question, said, said);
};
const move = (by: number) => (sitting.value = sittingMoved(sitting.value, by));
</script>

<template>
  <UModal :open="true" :title="title" @update:open="(open: boolean) => !open && emit('close')">
    <template #body>
      <div
        v-if="view.question !== null && view.condition !== null"
        class="flex flex-col gap-3"
        data-testid="question-dialog"
      >
        <div class="flex items-baseline justify-between gap-2 text-sm">
          <span class="font-medium" data-testid="question-count">
            Question {{ view.k }} of {{ view.n }}
          </span>
          <small class="truncate text-muted">
            {{ view.question.step }} · {{ view.question.run }}
          </small>
        </div>
        <p class="max-h-64 overflow-y-auto text-sm whitespace-pre-wrap" data-testid="question-text">
          {{ view.question.text }}
        </p>
        <template v-if="view.condition.kind === 'unanswered'">
          <div v-if="view.question.options.length > 0" class="flex flex-col gap-2">
            <UButton
              v-for="option in view.question.options"
              :key="option.id"
              :data-testid="`option-${option.id}`"
              block
              color="neutral"
              variant="outline"
              class="justify-start text-left"
              @click="send(view.question, option.id, option.title)"
            >
              <span class="flex flex-col items-start">
                <span>{{ option.title }}</span>
                <small v-if="option.subtitle !== null" class="text-muted">
                  {{ option.subtitle }}
                </small>
              </span>
            </UButton>
          </div>
          <form v-else class="flex gap-2" @submit.prevent="sendTyped(view.question)">
            <UInput v-model="draft" class="flex-1" autofocus data-testid="answer" />
            <UButton
              type="submit"
              label="Send"
              data-testid="send-answer"
              :disabled="Str.trim(draft) === ''"
            />
          </form>
        </template>
        <p v-else class="text-sm text-muted" data-testid="answer-state">
          {{ view.condition.kind === "gone" ? "No longer open" : view.condition.said }}
        </p>
        <div class="flex justify-between gap-2">
          <UButton
            label="Back"
            color="neutral"
            variant="ghost"
            icon="i-lucide-chevron-left"
            :disabled="!view.back"
            data-testid="question-back"
            @click="move(-1)"
          />
          <UButton
            label="Next"
            color="neutral"
            variant="ghost"
            trailing-icon="i-lucide-chevron-right"
            :disabled="!view.next"
            data-testid="question-next"
            @click="move(1)"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
