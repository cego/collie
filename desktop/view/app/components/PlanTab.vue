<script setup lang="ts">
import type { PlanPanel } from "../../../../src/board-model";
import type { PlanText } from "./PlanFile.vue";

const props = defineProps<{ plan: PlanPanel; installation: string; runId: string }>();
const { fileOf } = useActions();

const SPEC = "SPEC.md";
const ticketFile = (file: string) => `issues/${file}`;

const decoded = (file: { encoding: "utf8" | "base64"; content: string }) =>
  file.encoding === "utf8"
    ? file.content
    : new TextDecoder().decode(Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)));

/** Each plan file asked for, by its path in the plan; null while it is being read. */
const read = ref(new Map<string, PlanText | null>());
const load = (file: string) => {
  if (read.value.has(file)) return;
  read.value.set(file, null);
  void fileOf(props.installation, props.runId, `plan:${file}`).then((found) =>
    read.value.set(
      file,
      found === null ? { failed: `${file} could not be read.` } : { text: decoded(found) },
    ),
  );
};

/** The plan file a link opened, shown above the plan until it is closed. */
const opened = ref<string | null>(null);
provide("openPlanFile", (file: string) => {
  opened.value = file;
  if (file !== SPEC) load(file);
});
const spec = computed<PlanText>(() =>
  props.plan.spec._tag === "Text"
    ? { text: props.plan.spec.text }
    : { failed: props.plan.spec.reason },
);

const tickets = computed(() =>
  props.plan.tickets.map((ticket) => ({
    label: ticket.title,
    value: ticket.file,
    icon: ticket.done ? "i-lucide-circle-check" : "i-lucide-circle",
  })),
);
const expanded = ref<string[]>([]);
watch(expanded, (files) => files.forEach((file) => load(ticketFile(file))));
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
      <PlanFile :file="opened === SPEC ? spec : read.get(opened)" :from="opened" />
    </section>
    <PlanFile :file="spec" :from="SPEC" />
    <UAccordion
      v-if="tickets.length > 0"
      v-model="expanded"
      type="multiple"
      :items="tickets"
      data-testid="tickets"
    >
      <template #body="{ item }">
        <div :data-testid="`ticket-${item.value}`">
          <PlanFile :file="read.get(ticketFile(item.value))" :from="ticketFile(item.value)" />
        </div>
      </template>
    </UAccordion>
  </div>
</template>
