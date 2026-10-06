<script setup lang="ts">
import type { RunDetail, TaskView } from "../../../../src/board-model";

defineProps<{ task: TaskView; detail: RunDetail | null }>();
</script>

<template>
  <div data-testid="facts" class="flex flex-col gap-4 text-sm">
    <section v-if="detail?.intent" data-testid="intent">
      <h3 class="font-semibold">Intent</h3>
      <p v-if="detail.intent.goal">{{ detail.intent.goal }}</p>
      <ul class="list-disc pl-5">
        <li v-for="(constraint, at) in detail.intent.constraints" :key="at">{{ constraint }}</li>
      </ul>
    </section>
    <section v-if="detail && detail.steering.length > 0" data-testid="steering">
      <h3 class="font-semibold">Steering</h3>
      <ul class="flex flex-col gap-2">
        <li
          v-for="card in detail.steering"
          :key="card.id"
          class="rounded border border-default p-2"
          :data-testid="`steering-${card.id}`"
        >
          <div class="flex flex-wrap gap-2">
            <strong>{{ card.kind }}</strong>
            <UBadge variant="subtle" :label="card.readiness" />
            <UBadge variant="outline" color="neutral" :label="card.significance" />
            <small class="text-muted">{{ card.at }}</small>
          </div>
          <p v-if="card.narrative">{{ card.narrative }}</p>
          <p v-if="card.missing.length > 0" class="text-warning">
            Missing: {{ card.missing.join(", ") }}
          </p>
        </li>
      </ul>
    </section>
    <section data-testid="taskview">
      <h3 class="font-semibold">TaskView</h3>
      <pre class="overflow-auto rounded bg-elevated p-2 text-xs">{{
        JSON.stringify(task, null, 2)
      }}</pre>
    </section>
  </div>
</template>
