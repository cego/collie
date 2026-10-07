<script setup lang="ts">
import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import { Cause } from "effect";
import { offersTerminal, opensHerdrWithoutPane } from "../../../src/shared/record-terminal";
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

/** The location last followed: opened in the diff, or read-only in Review where there is none. */
const target = ref<DiffTarget | null>(null);
const jump = (file: string, line: number | null) => {
  target.value = { file, line };
  chosen.value = detail.value?.diff ? "diff" : "review";
};
provide("jumpTo", jump);

const tabs = computed(() => {
  const shown = detail.value;
  return [
    ...(shown?.plan ? [{ label: "Plan", value: "plan" }] : []),
    ...(shown !== null &&
    (shown.review._tag === "Text" || shown.findings.length > 0 || target.value !== null)
      ? [{ label: "Review", value: "review" }]
      : []),
    ...(shown?.diff ? [{ label: "Diff", value: "diff" }] : []),
    ...(shown !== null ? [{ label: "Evidence", value: "evidence" }] : []),
    { label: "Log", value: "log" },
    ...(offersTerminal(props.placed.asOf, chosen.value)
      ? [{ label: "Terminal", value: "terminal" }]
      : []),
    ...(shown?.mr ? [{ label: "Merge request", value: "mr" }] : []),
    { label: "Facts", value: "facts" },
  ];
});
/** The tab the human chose while it is there, else the first: Plan, where there is one. */
const chosen = ref<string>();
const record = usePage();
const wentToPane = ref(false);
watch(
  record.asked,
  (asked) => {
    if (asked === null) return;
    chosen.value = asked;
    wentToPane.value = opensHerdrWithoutPane(asked);
    record.taken();
  },
  { immediate: true },
);
const tab = computed({
  get: () =>
    tabs.value.some(({ value }) => value === chosen.value) ? chosen.value : tabs.value[0]!.value,
  set: (value) => (chosen.value = value),
});

watch(tab, (now) => now !== "terminal" && (wentToPane.value = false));

/** Mounted from its first visit on and kept, so its toggles and open files stay as left. */
const diffSeen = ref(false);
watch(tab, (now) => now === "diff" && (diffSeen.value = true), { immediate: true });

const review = useWhole(
  () => ({ installation: props.placed.installation, runId: props.placed.task.run }),
  "review",
  () => detail.value?.review ?? { _tag: "None", reason: "" },
);
const locationOf = (file: string, line: number | null) =>
  line === null ? file : `${file}:${line}`;
</script>

<template>
  <section data-testid="record" class="flex flex-col bg-default">
    <PageHeader :title="placed.task.name" @back="emit('close')">
      <p class="text-sm text-muted" data-testid="record-description">
        {{ detail?.title ?? placed.task.run }}
      </p>
    </PageHeader>
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <UAlert v-if="failure !== null" color="error" :title="failure" />
      <p v-else-if="AsyncResult.isInitial(result)" class="text-muted text-sm">Loading…</p>
      <p v-else-if="detail === null" class="text-muted text-sm">
        This Run's details are not on its Machine.
      </p>
      <UTabs v-model="tab" :items="tabs" :content="false" variant="link" />
      <template v-if="detail !== null">
        <PlanTab
          v-if="tab === 'plan' && detail.plan"
          class="max-w-3xl"
          :plan="detail.plan"
          :installation="placed.installation"
          :run-id="detail.id"
        />
        <div
          v-else-if="tab === 'review'"
          data-testid="review"
          class="flex max-w-3xl flex-col gap-4"
        >
          <SourceFile
            v-if="target !== null && !detail.diff"
            :path="target.file"
            :line="target.line"
            :installation="placed.installation"
            :run-id="detail.id"
            @close="target = null"
          />
          <template v-if="review !== null">
            <RichMarkdown :text="review.text" />
            <p v-if="review.cut" class="text-muted text-sm" data-testid="cut">
              {{ review.cut }}
            </p>
          </template>
          <ul v-if="detail.findings.length > 0" class="flex flex-col gap-2" data-testid="findings">
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
        <EvidenceTab
          v-else-if="tab === 'evidence'"
          :detail="detail"
          :installation="placed.installation"
        />
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
      <FactsTab v-if="tab === 'facts'" class="max-w-3xl" :task="placed.task" :detail="detail" />
      <TerminalTab v-if="tab === 'terminal'" :placed="placed" :went-to-pane="wentToPane" />
    </div>
  </section>
</template>
