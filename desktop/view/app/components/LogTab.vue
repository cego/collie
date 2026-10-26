<script setup lang="ts">
import type { Panel } from "../../../../src/board-model";
import { FOLLOWING_LOG, type LogPlace, logPlaceOf, logScrollTop } from "../../../src/shared/record";

const props = defineProps<{ tail: Panel | null; installation?: string; runId?: string }>();

const search = defineModel<string>("search", { default: "" });
const all = computed(() =>
  props.tail?._tag === "Text" && props.tail.text !== "" ? props.tail.text.split("\n") : [],
);
const wanted = computed(() => search.value.trim());
const lines = computed(() =>
  wanted.value === ""
    ? all.value
    : all.value.filter((line) => line.toLowerCase().includes(wanted.value.toLowerCase())),
);

/** The record's, so the human's place outlasts the tab; written back only as the tab is left. */
const place = defineModel<LogPlace>("place", { default: () => FOLLOWING_LOG });
let at = place.value;
onBeforeUnmount(() => (place.value = at));
const shown = ref<HTMLElement | null>(null);
const scrolled = () => {
  if (shown.value !== null) at = logPlaceOf(shown.value);
};
const showPlace = (box: HTMLElement | null) =>
  box?.scrollTo({ top: logScrollTop(at, box.scrollHeight) });
watch(shown, showPlace, { flush: "post" });
watch(
  lines,
  async () => {
    if (!at.following) return;
    await nextTick();
    showPlace(shown.value);
  },
  { immediate: true },
);
</script>

<template>
  <div data-testid="log" class="flex flex-col gap-2">
    <EvidenceText
      v-if="installation !== undefined && runId !== undefined"
      title="Full log"
      item="log"
      :installation="installation"
      :run-id="runId"
    />
    <UInput
      v-model="search"
      icon="i-lucide-search"
      placeholder="Search the log"
      size="sm"
      data-testid="log-search"
    />
    <p v-if="tail?._tag === 'None'" class="text-muted text-sm">{{ tail.reason }}</p>
    <p v-else-if="all.length === 0" class="text-muted text-sm" data-testid="log-empty">
      The log is empty so far.
    </p>
    <p v-else-if="lines.length === 0" class="text-muted text-sm" data-testid="log-unmatched">
      No line matches {{ wanted }}.
    </p>
    <pre
      v-else
      ref="shown"
      data-testid="log-lines"
      class="max-h-[60vh] overflow-auto rounded bg-elevated p-2 text-xs"
      @scroll="scrolled"
    ><template v-for="(line, at) in lines" :key="at">{{ line }}
</template></pre>
  </div>
</template>
