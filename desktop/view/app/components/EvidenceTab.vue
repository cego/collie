<script setup lang="ts">
import type { RunDetail, VerificationView } from "../../../../src/board-model";
import { sortEvidence } from "../../../src/shared/evidence";
import { webLinks } from "../../../src/shared/links";

const props = defineProps<{ detail: RunDetail; installation: string }>();

const sorted = computed(() => sortEvidence(props.detail.evidence));

const links = computed(() => {
  const { outputs, handoffs, review, findings, mr } = props.detail;
  return webLinks({
    texts: [
      ...outputs.map((output) => output.text),
      ...handoffs,
      review._tag === "Text" ? review.text : "",
      ...findings.map((finding) => finding.detail ?? ""),
    ],
    mr,
  });
});

/** What it was expected to do, and did not: these are opened first. */
const failedCheck = (check: VerificationView) => check.result !== check.expect;
const checks = computed(() =>
  [...props.detail.verifications].sort((a, b) => Number(failedCheck(b)) - Number(failedCheck(a))),
);
/** Whether it did what it was expected to, which a check expected to fail can. */
const verdictOf = (check: VerificationView) =>
  check.result === "unstable"
    ? { icon: "i-lucide-circle-alert", color: "text-warning", verdict: "unstable" }
    : failedCheck(check)
      ? { icon: "i-lucide-circle-x", color: "text-error", verdict: "failed" }
      : { icon: "i-lucide-circle-check", color: "text-success", verdict: "met" };

/** Shots per page, a before/after pair counting as one. */
const PAGE = 12;
const page = ref(1);
// A Run whose evidence shrinks never leaves the gallery on a page past its end.
watch(
  () => Math.max(1, Math.ceil(sorted.value.gallery.length / PAGE)),
  (last) => (page.value = Math.min(page.value, last)),
);
const shots = computed(() =>
  sorted.value.gallery.slice((page.value - 1) * PAGE, page.value * PAGE),
);

const metrics = computed(() => {
  const m = props.detail.outcome.metrics;
  return [
    [
      "Time to first evidence",
      m.timeToFirstEvidence === null ? "—" : `${Math.round(m.timeToFirstEvidence)}s`,
    ],
    [
      "Verifications",
      `${m.verifications.pass} pass · ${m.verifications.fail} fail · ${m.verifications.unstable} unstable · ${m.verifications.byCollie} by Collie`,
    ],
    ["Slices", `${m.slices.done} of ${m.slices.total}`],
    ["Rework", String(m.rework)],
    [
      "Peak context",
      m.peakContext === null ? "—" : `${m.peakContext.tokens} tokens (${m.peakContext.agent})`,
    ],
    ["Halts", m.halts.join(", ") || "none"],
    ["Obstacles", m.obstacles.join(", ") || "none"],
  ] as const;
});
</script>

<template>
  <div data-testid="evidence" class="flex flex-col gap-6 text-sm">
    <section v-if="checks.length > 0" class="flex flex-col gap-2" data-testid="verifications">
      <h3 class="font-semibold">Verifications</h3>
      <EvidenceText
        v-for="check in checks"
        :key="check.id"
        :data-testid="`check-${check.name}`"
        :title="check.name"
        :item="`verification:${check.id}`"
        :installation="installation"
        :run-id="detail.id"
        :initially-open="failedCheck(check)"
      >
        <template #leading>
          <UIcon
            :name="verdictOf(check).icon"
            :class="verdictOf(check).color"
            :data-verdict="verdictOf(check).verdict"
          />
        </template>
        <template #trailing>
          <small class="text-muted">
            {{ check.expect === "fail" ? "expected to fail · " : "" }}exit {{ check.exit }} ·
            {{ check.by }}
          </small>
        </template>
      </EvidenceText>
    </section>

    <section v-if="links.length > 0" class="flex flex-col gap-2" data-testid="links">
      <h3 class="font-semibold">Links</h3>
      <LinkCards :links="links" />
    </section>

    <section v-if="sorted.gallery.length > 0" class="flex flex-col gap-2" data-testid="gallery">
      <h3 class="font-semibold">Screenshots</h3>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        <template v-for="shot in shots" :key="`${shot.alone ? 'shot' : 'pair'}:${shot.key}`">
          <div
            v-if="shot.before && shot.after"
            class="col-span-full flex gap-3"
            :data-testid="`pair-${shot.key}`"
          >
            <EvidenceImage :file="shot.before" :installation="installation" :run-id="detail.id" />
            <EvidenceImage :file="shot.after" :installation="installation" :run-id="detail.id" />
          </div>
          <EvidenceImage
            v-else-if="shot.alone"
            :file="shot.alone"
            :installation="installation"
            :run-id="detail.id"
          />
        </template>
      </div>
      <UPagination
        v-if="sorted.gallery.length > PAGE"
        v-model:page="page"
        :total="sorted.gallery.length"
        :items-per-page="PAGE"
        data-testid="gallery-pages"
      />
    </section>

    <section v-if="sorted.videos.length > 0" class="flex flex-col gap-2" data-testid="videos">
      <h3 class="font-semibold">Videos</h3>
      <EvidenceVideo
        v-for="file in sorted.videos"
        :key="file.name"
        :file="file"
        :installation="installation"
        :run-id="detail.id"
      />
    </section>

    <section v-if="sorted.reports.length > 0" class="flex flex-col gap-2" data-testid="reports">
      <h3 class="font-semibold">Reports</h3>
      <EvidenceReport
        v-for="file in sorted.reports"
        :key="file.name"
        :file="file"
        :installation="installation"
        :run-id="detail.id"
      />
    </section>

    <section v-if="sorted.files.length > 0" class="flex flex-col gap-2" data-testid="files">
      <h3 class="font-semibold">Logs and files</h3>
      <EvidenceText
        v-for="file in sorted.files"
        :key="file.name"
        :data-testid="`file-${file.name}`"
        :title="file.name"
        :item="`evidence:${file.name}`"
        :installation="installation"
        :run-id="detail.id"
      >
        <template #trailing>
          <small class="text-muted">{{ file.bytes }} bytes</small>
        </template>
      </EvidenceText>
    </section>

    <section data-testid="metrics">
      <h3 class="mb-2 font-semibold">Metrics</h3>
      <table class="w-full">
        <tr v-for="[name, value] in metrics" :key="name" class="border-b border-default">
          <th class="py-1 pr-4 text-left font-normal text-muted">{{ name }}</th>
          <td class="py-1" :data-testid="`metric-${name}`">{{ value }}</td>
        </tr>
      </table>
    </section>
  </div>
</template>
