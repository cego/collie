<script setup lang="ts">
import { ansiLines } from "../../../src/shared/ansi";

/** Terminal output in its colours, with a search that keeps the lines that match. */
const props = defineProps<{ text: string }>();
const search = ref("");
const lines = computed(() => ansiLines(props.text));
const shown = computed(() => {
  const wanted = search.value.trim().toLowerCase();
  return wanted === ""
    ? lines.value
    : lines.value.filter((line) =>
        line
          .map((span) => span.text)
          .join("")
          .toLowerCase()
          .includes(wanted),
      );
});
</script>

<template>
  <div class="flex flex-col gap-2">
    <UInput
      v-model="search"
      icon="i-lucide-search"
      placeholder="Search"
      size="xs"
      data-testid="ansi-search"
    />
    <pre
      class="max-h-[50vh] overflow-auto rounded bg-elevated p-2 text-xs"
      data-testid="ansi-lines"
    ><template v-for="(line, at) in shown" :key="at"><span v-for="(span, s) in line" :key="s" :style="span.style">{{ span.text }}</span>
</template></pre>
  </div>
</template>
