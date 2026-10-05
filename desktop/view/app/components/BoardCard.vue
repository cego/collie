<script setup lang="ts">
import type { TaskView } from "../../../../src/board-model";

const props = defineProps<{ task: TaskView }>();

const STATES: Record<
  TaskView["state"],
  { label: string; color: "warning" | "info" | "neutral" | "error" | "success" }
> = {
  blocked: { label: "Needs you", color: "warning" },
  active: { label: "Working", color: "info" },
  quiet: { label: "Quiet", color: "neutral" },
  failed: { label: "Failed", color: "error" },
  stopped: { label: "Stopped", color: "neutral" },
  abandoned: { label: "Abandoned", color: "neutral" },
  done: { label: "Done", color: "success" },
};
const state = computed(() => STATES[props.task.state]);
const where = computed(() =>
  [props.task.project.split("/").at(-1), props.task.branch].filter(Boolean).join(" · "),
);
</script>

<template>
  <UCard :data-testid="`card-${task.id}`" :variant="task.state === 'blocked' ? 'soft' : 'outline'">
    <template #header>
      <div class="flex items-start justify-between gap-2">
        <strong data-testid="name">{{ task.name }}</strong>
        <UBadge class="shrink-0" :color="state.color" variant="subtle" data-testid="state">
          {{ state.label }}
        </UBadge>
      </div>
      <small class="text-muted">{{ where }}</small>
    </template>
    <p data-testid="sentence" class="text-sm">{{ task.sentence }}</p>
    <p v-if="task.held" class="text-sm text-muted">{{ task.held }}</p>
    <p v-if="task.drift" class="text-sm text-warning">{{ task.drift }}</p>
    <template #footer>
      <small class="text-muted">
        {{ task.age }}
        <template v-if="task.agents.length > 0">
          · {{ task.agents.length === 1 ? "1 agent" : `${task.agents.length} agents` }}
        </template>
      </small>
    </template>
  </UCard>
</template>
