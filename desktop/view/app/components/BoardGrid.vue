<script setup lang="ts">
import type { Card } from "../../../src/shared/flock";

defineProps<{ cards: ReadonlyArray<Card> }>();
</script>

<template>
  <div class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
    <BoardCard v-for="card in cards" :key="card.key" :task="card.task" :where="card.where" />
  </div>
</template>
