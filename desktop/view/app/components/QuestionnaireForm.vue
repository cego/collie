<script setup lang="ts">
// Draws one question's questionnaire and hands every gesture to it; it decides nothing.
import type { Question } from "../../../../src/board-model";
import { newRequest } from "../../../src/shared/actions";
import { type Event, questionnaireView } from "../../../src/shared/questionnaire";
import type { Act } from "../composables/useAnswering";

const props = defineProps<{
  installation: string;
  machine: string;
  question: Question;
  act: Act;
}>();
const emit = defineEmits<{ close: []; sent: [] }>();
const answering = useAnswering();
const uid = useId();

const view = computed(() => questionnaireView(answering.of(props.installation, props.question)));
const status = useTemplateRef<HTMLElement>("status");
const rows = useTemplateRef<HTMLElement[]>("rows");

const step = (event: Event) => {
  const does = answering.step(props.installation, props.machine, props.question, event, props.act);
  if (does?.kind === "send") {
    emit("sent");
    void nextTick(() => status.value?.focus());
  } else if (does?.kind === "submit") step({ kind: "submit", request: newRequest() });
  else if (does?.kind === "steer") step({ kind: "steer", request: newRequest() });
  else if (does?.kind === "close") emit("close");
  return does;
};

const GROUP_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  " ",
  "Enter",
]);

/** A key the questionnaire uses does nothing else, so Space does not scroll and Enter types nothing. */
const key = (where: "group" | "steer" | "answer", pressed: KeyboardEvent) => {
  const before = view.value.focus;
  const does = step({
    kind: "key",
    key: pressed.key,
    mod: pressed.ctrlKey || pressed.metaKey,
    where,
  });
  if (
    (does !== null && does.kind !== "close") ||
    (where === "group" && GROUP_KEYS.has(pressed.key))
  )
    pressed.preventDefault();
  if (where === "group" && view.value.focus !== before)
    void nextTick(() => rows.value?.[view.value.focus]?.focus());
};
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="questionnaire">
    <p
      :id="`${uid}-prompt`"
      class="max-h-64 overflow-y-auto text-sm whitespace-pre-wrap"
      data-testid="question-text"
    >
      {{ view.text }}
    </p>
    <p v-if="view.shortfall !== null" class="text-sm text-warning" data-testid="shortfall">
      ⚠ {{ view.shortfall }}
    </p>
    <form
      v-if="view.words"
      class="flex gap-2"
      @submit.prevent="step({ kind: 'submit', request: newRequest() })"
    >
      <UInput
        :model-value="view.typed"
        class="flex-1"
        autofocus
        aria-label="Your answer"
        data-testid="answer"
        @update:model-value="(text: string) => step({ kind: 'type', text })"
        @keydown.enter="(pressed: KeyboardEvent) => key('answer', pressed)"
      />
      <UButton type="submit" label="Send" data-testid="send-answer" :disabled="!view.submit" />
    </form>
    <template v-else>
      <div
        role="radiogroup"
        :aria-labelledby="`${uid}-prompt`"
        class="flex flex-col gap-1"
        data-testid="options"
        @keydown="(pressed: KeyboardEvent) => key('group', pressed)"
      >
        <div
          v-for="(row, at) in view.rows"
          ref="rows"
          :key="row.id"
          role="radio"
          :aria-checked="row.checked"
          :aria-disabled="row.disabled"
          :aria-describedby="row.detail === null && row.why === null ? undefined : `${uid}-${at}`"
          :tabindex="at === view.focus ? 0 : -1"
          :data-testid="`option-${at}`"
          class="flex cursor-pointer items-start gap-2 rounded border border-default p-2 text-sm focus-visible:outline-2 focus-visible:outline-primary aria-checked:border-primary aria-checked:bg-primary/5 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          @click="step({ kind: 'pick', id: row.id })"
        >
          <UIcon
            :name="row.checked ? 'i-lucide-circle-dot' : 'i-lucide-circle'"
            class="mt-0.5 size-4 shrink-0"
          />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="flex items-baseline justify-between gap-2">
              <span>{{ row.title }}</span>
              <UBadge v-if="row.recommended" label="Recommended" color="primary" variant="soft" />
            </span>
            <small
              v-if="row.detail !== null || row.why !== null"
              :id="`${uid}-${at}`"
              class="text-muted"
            >
              {{ row.why ?? row.detail }}
            </small>
          </span>
        </div>
      </div>
      <UButton
        class="self-end"
        label="Submit answer"
        data-testid="submit-answer"
        :disabled="!view.submit"
        @click="step({ kind: 'submit', request: newRequest() })"
      />
    </template>
    <p
      ref="status"
      tabindex="-1"
      aria-live="polite"
      class="min-h-5 text-sm text-muted"
      data-testid="answer-state"
    >
      {{ view.status ?? "" }}
    </p>
    <USeparator />
    <div class="flex flex-col gap-2" data-testid="steering">
      <label :for="`${uid}-steer`" class="text-sm">Or tell the agent something else instead</label>
      <UInput
        :id="`${uid}-steer`"
        :model-value="view.steer.draft"
        :disabled="view.steer.disabled"
        placeholder="It sets the question aside: the agent re-thinks and asks again."
        data-testid="steer-text"
        @update:model-value="(text: string) => step({ kind: 'draft', text })"
        @keydown.enter="(pressed: KeyboardEvent) => key('steer', pressed)"
      />
      <small v-if="view.steer.why !== null" class="text-muted">{{ view.steer.why }}</small>
      <UButton
        class="self-end"
        color="neutral"
        variant="outline"
        :label="view.steer.label"
        :disabled="!view.steer.send"
        data-testid="steer-send"
        @click="step({ kind: 'steer', request: newRequest() })"
      />
    </div>
  </div>
</template>
