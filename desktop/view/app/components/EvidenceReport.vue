<script setup lang="ts">
import type { EvidenceFile } from "../../../../src/board-model";

const props = defineProps<{ file: EvidenceFile; installation: string; runId: string }>();
const { textOf } = useActions();

/**
 * Nothing it may fetch, and nothing of Desktop's it may reach: scripts run, as a report
 * needs them to, in an origin of their own.
 */
const POLICY =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; ` +
  `font-src data:; media-src data: blob:">`;
const confined = (html: string) =>
  /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => head + POLICY) : POLICY + html;

const open = ref(false);
const html = ref<string | null>(null);
watch(open, async (now) => {
  if (!now || html.value !== null) return;
  const text = await textOf(props.installation, props.runId, `evidence:${props.file.name}`);
  if (text !== null) html.value = confined(text);
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
      <p v-else class="border-t border-default p-3 text-sm text-muted">Reading…</p>
    </template>
  </div>
</template>
