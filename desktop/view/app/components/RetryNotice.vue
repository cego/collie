<script setup lang="ts">
import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import type { Trouble } from "../../../src/shared/retrying";
import { retry } from "../flock";

const props = defineProps<{ title: string; trouble: Trouble }>();
const clock = useAtomValue(() => secondsAtom);
const retryNow = () => retry.wake();
const description = computed(() => {
  const now = AsyncResult.getOrElse(clock.value, () => props.trouble.at);
  const seconds = Math.ceil((props.trouble.at - now) / 1000);
  const said = props.trouble.said.replace(/\.$/, "");
  return `${said}. ${seconds > 0 ? `Trying again in ${seconds} s.` : "Trying again now."}`;
});
</script>

<template>
  <UAlert
    data-testid="retrying"
    color="warning"
    variant="subtle"
    icon="i-lucide-refresh-cw"
    :title="title"
    :description="description"
    :actions="[{ label: 'Retry now', onClick: retryNow }]"
  />
</template>
