<script setup lang="ts">
import type { EvidenceFile } from "../../../../src/board-model";

const props = defineProps<{ file: EvidenceFile; installation: string; runId: string }>();
const { textOf } = useActions();

/**
 * Nothing it may fetch, first in its head so it holds before any of the report's own
 * scripts run; and, sandboxed, an origin of its own, so nothing of Desktop's is in reach.
 */
const POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:";
const confined = (html: string) => {
  const report = new DOMParser().parseFromString(html, "text/html");
  const meta = report.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = POLICY;
  report.head.prepend(meta);
  return `<!doctype html>${report.documentElement.outerHTML}`;
};

const open = ref(false);
const html = ref<string | null>(null);
const failed = ref(false);
let reading = false;
watch(open, (now) => {
  if (!now || html.value !== null || reading) return;
  reading = true;
  failed.value = false;
  void textOf(props.installation, props.runId, `evidence:${props.file.name}`).then((text) => {
    reading = false;
    if (text === null) failed.value = true;
    else html.value = confined(text);
  });
});
</script>

<template>
  <div :data-testid="`report-${file.name}`" class="rounded border border-default">
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm"
      data-testid="report-open"
      @click="open = !open"
    >
      <UIcon :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />
      <code class="flex-1 truncate">{{ file.name }}</code>
      <small class="text-muted">sandboxed</small>
    </button>
    <template v-if="open">
      <iframe
        v-if="html !== null"
        :srcdoc="html"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        class="h-[70vh] w-full border-t border-default bg-white"
        :title="file.name"
      />
      <p v-else class="border-t border-default p-3 text-sm text-muted">
        {{ failed ? "Could not be read." : "Reading…" }}
      </p>
    </template>
  </div>
</template>
