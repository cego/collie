<script setup lang="ts">
const props = defineProps<{ file: string; line: string }>();
const jump = inject<((file: string, line: number) => void) | null>("jumpTo", null);
</script>

<template>
  <button
    v-if="jump"
    type="button"
    class="font-mono text-primary hover:underline"
    data-testid="file-ref"
    @click="jump(props.file, Number(props.line))"
  >
    <slot />
  </button>
  <code v-else><slot /></code>
</template>
