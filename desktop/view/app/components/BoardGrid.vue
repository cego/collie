<script setup lang="ts">
import type { TaskView } from "../../../../src/board-model";

defineProps<{ tasks: ReadonlyArray<TaskView> }>();
</script>

<template>
  <div class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
    <BoardCard v-for="task in tasks" :key="task.id" :task="task" />
  </div>
</template>
