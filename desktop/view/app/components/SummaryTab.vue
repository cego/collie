<script setup lang="ts">
import type { RunDetail } from "../../../../src/board-model";
import { summaryOf } from "../../../src/shared/record";

const props = defineProps<{ detail: RunDetail }>();
const sections = computed(() => summaryOf(props.detail));
</script>

<template>
  <div data-testid="summary" class="flex flex-col gap-4 text-sm">
    <template v-for="shown in sections" :key="shown.section">
      <section v-if="shown.section === 'status'" data-testid="summary-status">
        <h3 class="font-semibold">Status</h3>
        <p>{{ shown.status }}</p>
      </section>
      <section v-else-if="shown.section === 'attention'" data-testid="summary-attention">
        <h3 class="flex items-center gap-2 font-semibold">
          Attention <UBadge variant="subtle" :label="shown.category" />
        </h3>
        <RichMarkdown :text="shown.explanation" />
      </section>
      <section v-else-if="shown.section === 'outcome'" data-testid="summary-outcome">
        <h3 class="flex items-center gap-2 font-semibold">
          Outcome <UBadge v-if="shown.kind" variant="outline" color="neutral" :label="shown.kind" />
        </h3>
        <template v-if="shown.measurement">
          <p class="text-muted">Measured</p>
          <p data-testid="summary-measurement">{{ shown.measurement }}</p>
        </template>
        <template v-if="shown.gaps.length > 0">
          <p class="text-muted">Still to prove</p>
          <ul class="list-disc pl-5">
            <li v-for="(gap, at) in shown.gaps" :key="at">{{ gap }}</li>
          </ul>
        </template>
        <template v-if="shown.obstacle">
          <p class="text-muted">In its way</p>
          <RichMarkdown :text="shown.obstacle" />
        </template>
        <template v-if="shown.next">
          <p class="text-muted">Next</p>
          <RichMarkdown :text="shown.next" />
        </template>
        <template v-if="shown.delivered">
          <p class="text-muted">Delivered</p>
          <RichMarkdown :text="shown.delivered" />
        </template>
      </section>
      <section v-else-if="shown.section === 'replies'" data-testid="summary-replies">
        <h3 class="font-semibold">Replies to reviewers</h3>
        <div
          v-for="reply in shown.replies"
          :key="reply.comment + reply.at"
          class="flex flex-col gap-1"
        >
          <p class="flex justify-between gap-2">
            <a :href="reply.comment" class="min-w-0 wrap-anywhere">{{ reply.comment }}</a>
            <UBadge
              v-if="reply.kind"
              variant="subtle"
              :color="reply.kind === 'disputed' ? 'warning' : 'neutral'"
              :label="reply.kind"
            />
          </p>
          <RichMarkdown :text="reply.body" />
        </div>
      </section>
      <section v-else data-testid="summary-inputs">
        <h3 class="font-semibold">Inputs</h3>
        <p v-for="input in shown.inputs" :key="input.name" class="flex justify-between gap-2">
          <span class="min-w-0 wrap-anywhere">
            <strong>{{ input.name }}</strong> {{ input.value }}
          </span>
          <small class="text-muted">{{ input.source }}</small>
        </p>
      </section>
    </template>
  </div>
</template>
