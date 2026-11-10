<script setup lang="ts">
import type { FlowEffect } from "../../../src/shared/flow-actions";
import type { Act } from "../composables/useAnswering";
const props = defineProps<{
  effect: Extract<FlowEffect, { kind: "answer" | "proposal" }>;
  machine: string;
  perform: (
    installation: string,
    action: Parameters<Act>[0],
    tried?: Parameters<Act>[2],
    request?: string,
  ) => Promise<boolean>;
}>();
const act: Act = (action, request, tried) =>
  props.perform(props.effect.installation, action, tried, request);
</script>

<template>
  <section
    class="flex flex-col gap-2 rounded border border-warning/50 bg-warning/5 p-3 text-sm"
    aria-label="Decision"
  >
    <QuestionnaireForm
      v-if="effect.kind === 'answer'"
      :key="`${effect.question.run}/${effect.question.id}`"
      :installation="effect.installation"
      :machine="machine"
      :question="effect.question"
      :act="act"
    />
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
