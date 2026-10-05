<script setup lang="ts">
import type { Token } from "../composables/useHighlight";

defineProps<{ tokens: ReadonlyArray<Token> | undefined }>();
</script>

<template>
  <span v-for="(token, at) in tokens" :key="at" :style="token.style">{{ token.content }}</span>
</template>
