<script setup lang="ts">
import type { ComputedRef } from "vue";

const props = defineProps<{ href?: string }>();
const from = inject<ComputedRef<string | undefined>>("markdownFrom");
const openPlanFile = inject<(file: string) => void>("openPlanFile", () => {});
const { openLink } = useActions();

/** The plan file a relative `.md` link names, resolved against the file it is in. */
const planFile = computed(() => {
  const href = props.href ?? "";
  if (from?.value === undefined || /^([a-z][a-z\d+.-]*:|[#/])/i.test(href)) return null;
  const path = decodeURIComponent(new URL(href, `http://plan/${from.value}`).pathname.slice(1));
  return path.endsWith(".md") ? path : null;
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
