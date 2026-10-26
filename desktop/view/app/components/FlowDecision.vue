<script setup lang="ts">
import type { DesktopAction } from "../../../src/shared/flock";
import type { FlowEffect } from "../../../src/shared/flow-actions";
import { answerKey, cardQuestion, draftOf } from "../../../src/shared/pending-answer";
const props = defineProps<{
  effect: Extract<FlowEffect, { kind: "answer" | "proposal" }>;
  machine: string;
  perform: (
    installation: string,
    action: DesktopAction,
    tried?: (done: boolean | null) => void,
  ) => Promise<boolean>;
}>();
const answering = useAnswering();
const typed = ref(false);
const question = computed(() => (props.effect.kind === "answer" ? props.effect.question : null));
const key = computed(() =>
  question.value === null
    ? null
    : answerKey(props.effect.installation, question.value.run, question.value.id),
);
const draft = computed({
  get: () => (key.value === null ? "" : draftOf(answering.state.value, key.value)),
  set: (value: string) => key.value !== null && answering.type(key.value, value),
});
const status = computed(() =>
  question.value === null
    ? null
    : cardQuestion({ decision: question.value }, props.effect.installation, answering.state.value),
);
const send = (value: string, shown: string) => {
  const asked = question.value;
  if (asked !== null)
    answering.answer(
      props.effect.installation,
      props.machine,
      asked,
      value,
      shown,
      (action, tried) => props.perform(props.effect.installation, action, tried),
    );
};
</script>

<template>
  <section
    class="flex flex-col gap-2 rounded border border-warning/50 bg-warning/5 p-3 text-sm"
    aria-label="Decision"
  >
    <template v-if="effect.kind === 'answer'">
      <p>{{ effect.question.text }}</p>
      <p v-if="status?.pending" class="text-muted">{{ status.pending }}</p>
      <template v-else>
        <template v-if="effect.question.options.length > 0 && !typed">
          <UButton
            v-for="option in effect.question.options"
            :key="option.id"
            color="neutral"
            variant="outline"
            :label="option.title"
            @click="send(option.id, option.title)"
          />
          <UButton variant="link" class="self-start" label="Type it…" @click="typed = true" />
        </template>
        <form
          v-else
          class="flex gap-2"
          @submit.prevent="draft.trim() !== '' && send(draft.trim(), draft.trim())"
        >
          <UInput v-model="draft" autofocus class="flex-1" aria-label="Your answer" /><UButton
            type="submit"
            label="Send"
            :disabled="draft.trim() === ''"
          />
        </form>
      </template>
    </template>
    <template v-else>
      <p>{{ effect.proposal.text }}</p>
      <p v-for="(action, at) in effect.proposal.actions" :key="at" class="text-xs text-muted">
        {{ action.text }}
      </p>
      <div class="flex gap-2">
        <UButton label="Confirm" @click="perform(effect.installation, effect.confirm)" /><UButton
          label="Decline"
          variant="outline"
          color="neutral"
          @click="perform(effect.installation, effect.decline)"
        />
      </div>
    </template>
  </section>
</template>
