<script setup lang="ts">
import type { PlanPanel } from "../../../../src/board-model";

const props = defineProps<{ plan: PlanPanel; installation: string; runId: string }>();
const { fileOf } = useActions();

const decoded = (file: { encoding: "utf8" | "base64"; content: string }) =>
  file.encoding === "utf8"
    ? file.content
    : new TextDecoder().decode(Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)));

/** Each plan file read so far, by its path in the plan; null while it is being read. */
const read = ref(new Map<string, string | null>());
const load = (file: string) => {
  if (read.value.has(file)) return;
  read.value.set(file, null);
  void fileOf(props.installation, props.runId, `plan:${file}`).then((found) => {
    if (found === null) read.value.delete(file);
    else read.value.set(file, decoded(found));
  });
};

/** The plan file a link opened, shown above the plan until it is closed. */
const opened = ref<string | null>(null);
provide("openPlanFile", (file: string) => {
  opened.value = file;
  if (file !== "SPEC.md") load(file);
});
const openedText = computed(() => {
  if (opened.value === "SPEC.md")
    return props.plan.spec._tag === "Text" ? props.plan.spec.text : props.plan.spec.reason;
  return opened.value === null ? null : read.value.get(opened.value);
});

const tickets = computed(() =>
  props.plan.tickets.map((ticket) => ({
    label: ticket.title,
    value: ticket.file,
    icon: ticket.done ? "i-lucide-circle-check" : "i-lucide-circle",
  })),
);
const expanded = ref<string[]>([]);
watch(expanded, (files) => files.forEach((file) => load(`issues/${file}`)));
</script>

<template>
  <div data-testid="plan" class="flex flex-col gap-4">
    <section
      v-if="opened !== null"
      data-testid="plan-file"
      class="rounded border border-default p-3"
    >
      <div class="mb-2 flex items-center justify-between">
        <code class="text-xs text-muted" data-testid="plan-file-name">{{ opened }}</code>
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-x"
          aria-label="Close"
          data-testid="close-plan-file"
          @click="opened = null"
        />
      </div>
      <RichMarkdown v-if="openedText" :text="openedText" :from="opened" />
      <p v-else class="text-muted text-sm">Reading…</p>
    </section>
    <RichMarkdown v-if="plan.spec._tag === 'Text'" :text="plan.spec.text" from="SPEC.md" />
    <p v-else class="text-muted text-sm">{{ plan.spec.reason }}</p>
    <UAccordion
      v-if="tickets.length > 0"
      v-model="expanded"
      type="multiple"
      :items="tickets"
      data-testid="tickets"
    >
      <template #body="{ item }">
        <div :data-testid="`ticket-${item.value}`">
          <RichMarkdown
            v-if="read.get(`issues/${item.value}`)"
            :text="read.get(`issues/${item.value}`)!"
            :from="`issues/${item.value}`"
          />
          <p v-else class="text-muted text-sm">Reading…</p>
        </div>
      </template>
    </UAccordion>
  </div>
</template>
