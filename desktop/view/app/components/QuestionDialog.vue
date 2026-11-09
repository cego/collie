<script setup lang="ts">
import type { Question } from "../../../../src/board-model";
import {
  sittingAnswered,
  sittingMoved,
  sittingSees,
  sittingStarts,
  sittingView,
} from "../../../src/shared/pending-answer";
import { questionnaireView } from "../../../src/shared/questionnaire";
import type { Act } from "../composables/useAnswering";

const props = defineProps<{
  title: string;
  installation: string;
  machine: string;
  open: ReadonlyArray<Question>;
  act: Act;
}>();
const emit = defineEmits<{ close: [] }>();
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
  () =>
    view.value.question !== null &&
    questionnaireView(answering.of(props.installation, view.value.question)).settled,
  (settled) => settled && (sitting.value = sittingAnswered(sitting.value, now.value)),
);
const move = (by: number) => (sitting.value = sittingMoved(sitting.value, by));
</script>

<template>
  <UModal
    :open="true"
    :title="title"
    :content="{ onOpenAutoFocus: (event: Event) => event.preventDefault() }"
    @update:open="(open: boolean) => !open && emit('close')"
  >
    <template #body>
      <div v-if="view.question !== null" class="flex flex-col gap-3" data-testid="question-dialog">
        <div class="flex items-baseline justify-between gap-2 text-sm">
          <span class="font-medium" data-testid="question-count">
            Question {{ view.k }} of {{ view.n }}
          </span>
          <small class="truncate text-muted">
            {{ view.question.step }} · {{ view.question.run }}
          </small>
        </div>
        <QuestionnaireForm
          :key="`${view.question.run}/${view.question.id}`"
          :installation="installation"
          :machine="machine"
          :question="view.question"
          :act="act"
          @close="emit('close')"
        />
        <div v-if="view.n > 1" class="flex justify-between gap-2">
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
