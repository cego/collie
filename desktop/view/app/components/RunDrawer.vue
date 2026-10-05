<script setup lang="ts">
import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import { Cause } from "effect";
import type { PlacedTask } from "../../../src/shared/flock";
import { runDetailAtom, runDetailKey } from "../flock";
import type { DiffTarget } from "./DiffTab.vue";

const props = defineProps<{ placed: PlacedTask }>();
const emit = defineEmits<{ close: [] }>();

const result = useAtomValue(() =>
  runDetailAtom(
    runDetailKey({ installation: props.placed.installation, runId: props.placed.task.run }),
  ),
);
const detail = computed(() => AsyncResult.getOrElse(result.value, () => null));
const failure = computed(() =>
  AsyncResult.isFailure(result.value) ? Cause.pretty(result.value.cause) : null,
);

const tabs = computed(() => {
  const shown = detail.value;
  return [
    ...(shown?.plan ? [{ label: "Plan", value: "plan" }] : []),
    ...(shown !== null && (shown.review._tag === "Text" || shown.findings.length > 0)
      ? [{ label: "Review", value: "review" }]
      : []),
    ...(shown?.diff ? [{ label: "Diff", value: "diff" }] : []),
    { label: "Log", value: "log" },
    ...(shown?.mr ? [{ label: "Merge request", value: "mr" }] : []),
    { label: "Facts", value: "facts" },
  ];
});
/** The tab the human chose while it is there, else the first: Plan, where there is one. */
const chosen = ref<string>();
const tab = computed({
  get: () =>
    tabs.value.some(({ value }) => value === chosen.value) ? chosen.value : tabs.value[0]!.value,
  set: (value) => (chosen.value = value),
});

/** Mounted from its first visit on and kept, so its toggles and open files stay as left. */
const diffSeen = ref(false);
watch(tab, (now) => now === "diff" && (diffSeen.value = true), { immediate: true });

/** The finding last followed: opened in the diff, or read-only here where there is none. */
const target = ref<DiffTarget | null>(null);
const jump = (file: string, line: number | null) => {
  target.value = { file, line };
  if (detail.value?.diff) chosen.value = "diff";
};
const locationOf = (file: string, line: number | null) =>
  line === null ? file : `${file}:${line}`;
</script>

<template>
  <USlideover
    :open="true"
    @update:open="(still: boolean) => !still && emit('close')"
    :title="placed.task.name"
    :description="detail?.title ?? placed.task.run"
    :ui="{ content: 'max-w-3xl', body: 'flex flex-col gap-4' }"
  >
    <template #body>
      <div data-testid="drawer" class="flex flex-col gap-4">
        <UAlert v-if="failure !== null" color="error" :title="failure" />
        <p v-else-if="AsyncResult.isInitial(result)" class="text-muted text-sm">Loading…</p>
        <p v-else-if="detail === null" class="text-muted text-sm">
          This Run's details are not on its Machine.
        </p>
        <UTabs v-model="tab" :items="tabs" :content="false" variant="link" />
        <template v-if="detail !== null">
          <PlanTab
            v-if="tab === 'plan' && detail.plan"
            :plan="detail.plan"
            :installation="placed.installation"
            :run-id="detail.id"
          />
          <div v-else-if="tab === 'review'" data-testid="review" class="flex flex-col gap-4">
            <SourceFile
              v-if="target !== null && !detail.diff"
              :path="target.file"
              :line="target.line"
              :installation="placed.installation"
              :run-id="detail.id"
              @close="target = null"
            />
            <RichMarkdown v-if="detail.review._tag === 'Text'" :text="detail.review.text" />
            <ul
              v-if="detail.findings.length > 0"
              class="flex flex-col gap-2"
              data-testid="findings"
            >
              <li
                v-for="(finding, at) in detail.findings"
                :key="at"
                class="rounded border border-default p-2 text-sm"
              >
                <div class="flex items-center gap-2">
                  <UBadge variant="subtle" :label="finding.severity" />
                  <strong>{{ finding.title }}</strong>
                </div>
                <UButton
                  v-if="finding.file"
                  variant="link"
                  size="xs"
                  class="px-0 font-mono"
                  data-testid="finding-location"
                  :label="locationOf(finding.file, finding.line)"
                  @click="jump(finding.file, finding.line)"
                />
                <p v-if="finding.detail" class="mt-1 whitespace-pre-wrap">{{ finding.detail }}</p>
              </li>
            </ul>
          </div>
          <LogTab v-else-if="tab === 'log'" :tail="detail.tail" />
          <MrPanel v-else-if="tab === 'mr' && detail.mr" :mr="detail.mr" />
          <DiffTab
            v-if="detail.diff && diffSeen"
            v-show="tab === 'diff'"
            :diff="detail.diff"
            :installation="placed.installation"
            :run-id="detail.id"
            :target="target"
          />
        </template>
        <FactsTab v-if="tab === 'facts'" :task="placed.task" :detail="detail" />
      </div>
    </template>
  </USlideover>
</template>
