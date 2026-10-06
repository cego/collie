<script setup lang="ts">
import type { PlacedTask } from "../../../src/shared/flock";

defineProps<{ tasks: ReadonlyArray<PlacedTask> }>();
</script>

<template>
  <div class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
    <BoardCard
      v-for="one in tasks"
      :key="one.key"
      :task="one.task"
      :where="one.where"
      :installation="one.installation"
      :card-key="one.key"
      :machine="one.machine"
    />
  </div>
</template>
