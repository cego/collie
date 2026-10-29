<script setup lang="ts">
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import type { ComputedRef } from "vue";

const props = defineProps<{ href?: string }>();
const from = inject<ComputedRef<string | undefined>>("markdownFrom");
const openPlanFile = inject<(file: string) => void>("openPlanFile", () => {});
const { openLink } = useActions();

/** The plan file a relative `.md` link names, resolved against the file it is in. */
const planFile = computed(() => {
  const href = props.href ?? "";
  if (from?.value === undefined || /^([a-z][a-z\d+.-]*:|[#/])/i.test(href)) return null;
  const path = decodeURIComponent(
    pipe(new URL(href, `http://plan/${from.value}`).pathname, Str.slice(1)),
  );
  return pipe(path, Str.endsWith(".md")) ? path : null;
});

const follow = () => {
  const href = props.href ?? "";
  if (planFile.value !== null) openPlanFile(planFile.value);
  else if (/^https?:\/\//i.test(href)) void openLink(href);
};
</script>

<template>
  <a :href="href" :data-plan-file="planFile ?? undefined" @click.prevent="follow"><slot /></a>
</template>
