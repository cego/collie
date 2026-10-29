<script setup lang="ts">
import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { BoardAgent, RunAgent } from "../../../../src/board-model";
import { addressOf, deliveryChoices } from "../../../src/shared/record-terminal";
import { compose, counted, locationOf, quoteOf } from "../../../src/shared/review-comments";

const props = defineProps<{
  installation: string;
  runId: string;
  launches: ReadonlyArray<RunAgent> | undefined;
  live: ReadonlyArray<BoardAgent>;
  /** The board protocol the Run's Machine last spoke; null where none is known. */
  protocol: number | null;
}>();
const { drafts, edit, remove, clear } = useReviewDrafts(() => props);
const { run } = useActions();

const offered = computed(() => deliveryChoices(props.launches, props.live, props.protocol));
/** The human's choice while the Run still offers it, else the first offered. */
const picked = ref<string>();
const choice = computed(
  () =>
    Option.getOrUndefined(Arr.findFirst(offered.value, (one) => one.key === picked.value)) ??
    offered.value[0],
);

const sending = ref(false);
const send = () => {
  return Effect.runPromise(
    Effect.gen(function* () {
      if (choice.value === undefined) return;
      const who = addressOf(choice.value);
      const sent = [...drafts.value];
      sending.value = true;
      yield* Effect.promise(() =>
        Promise.resolve(
          run(
            props.installation,
            {
              _tag: "Deliver",
              runId: props.runId,
              ...who,
              text: compose(sent),
            },
            undefined,
            () => clear(sent),
          ),
        ),
      );
      sending.value = false;
    }),
  );
};
</script>

<template>
  <section
    v-if="drafts.length > 0"
    data-testid="review-comments"
    class="flex flex-col gap-3 rounded border border-default p-3"
  >
    <h3 class="text-sm font-medium">{{ counted(drafts) }}</h3>
    <ul class="flex flex-col gap-3">
      <li v-for="draft in drafts" :key="draft.id" class="flex flex-col gap-1" data-testid="draft">
        <span class="text-xs text-muted">{{ locationOf(draft.anchor) }}</span>
        <blockquote class="line-clamp-3 border-l-2 border-default pl-2 text-xs text-muted">
          {{ quoteOf(draft.anchor) }}
        </blockquote>
        <DraftEdit
          :text="draft.text"
          @edit="(text) => edit(draft.id, text)"
          @remove="remove(draft.id)"
        />
      </li>
    </ul>
    <div class="flex items-center gap-2">
      <USelect
        v-if="offered.length > 0"
        :model-value="choice?.key"
        :items="Arr.map(offered, (one) => ({ label: one.label, value: one.key }))"
        size="sm"
        aria-label="Send to"
        @update:model-value="(name: string) => (picked = name)"
        data-testid="recipient"
      />
      <p v-else class="text-sm text-muted" data-testid="no-recipient">
        This Run has no live agent to tell
      </p>
      <UButton
        label="Send"
        icon="i-lucide-send"
        size="sm"
        :disabled="choice === undefined"
        :loading="sending"
        data-testid="send-comments"
        @click="send"
      />
    </div>
  </section>
</template>
