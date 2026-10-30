<script setup lang="ts">
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import type { Panel } from "../../../../src/board-model";
import { FOLLOWING_LOG, type LogPlace, logPlaceOf, logScrollTop } from "../../../src/shared/record";

const props = defineProps<{
  tail: Panel | null;
  installation?: string;
  runId?: string;
  /** Fills its box rather than stopping at 60% of the window. */
  fill?: boolean;
}>();

const search = defineModel<string>("search", { default: "" });
const all = computed(() =>
  props.tail?._tag === "Text" && props.tail.text !== "" ? Str.split(props.tail.text, "\n") : [],
);
const wanted = computed(() => Str.trim(search.value));
const lines = computed(() =>
  wanted.value === ""
    ? all.value
    : Arr.filter(all.value, (line) =>
        pipe(Str.toLowerCase(line), Str.includes(Str.toLowerCase(wanted.value))),
      ),
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
  () => {
    return Effect.runPromise(
      Effect.gen(function* () {
        if (!at.following) return;
        yield* Effect.promise(() => Promise.resolve(nextTick()));
        showPlace(shown.value);
      }),
    );
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
      class="overflow-auto rounded bg-elevated p-2 text-xs"
      :class="fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'"
      @scroll="scrolled"
    ><template v-for="(line, at) in lines" :key="at">{{ line }}
</template></pre>
  </div>
</template>
