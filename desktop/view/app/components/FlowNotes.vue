<script setup lang="ts">
import type { FlowRun } from "../../../../src/board-model";
import type { FlowActionView } from "../../../src/shared/flow-actions";
import { stepSteering } from "../../../src/shared/step-steering";
const props = defineProps<{ node: FlowRun; run: string; installation: string; live: boolean }>();
const emit = defineEmits<{ act: [action: FlowActionView] }>();
const info = computed(() => stepSteering(props.node));
const edit = (note: NonNullable<FlowRun["notes"]>[number]) =>
  emit("act", {
    label: `Edit note for ${props.node.title}`,
    icon: "i-lucide-pencil",
    color: "neutral",
    effect: {
      kind: "text",
      installation: props.installation,
      write: { _tag: "Deliver", runId: props.run, step: props.node.id, text: "" },
      initial: note.text,
      withdraw: note.id,
    },
  });
const remove = (note: string) =>
  emit("act", {
    label: "Remove note",
    icon: "i-lucide-trash",
    color: "neutral",
    effect: {
      kind: "write",
      installation: props.installation,
      write: { _tag: "WithdrawNote", runId: props.run, note },
    },
  });
</script>
<template>
  <section
    v-if="info.pause !== null || info.notes.length > 0"
    class="flex flex-col gap-3 border-t border-default pt-3"
  >
    <p v-if="info.pause !== null" class="text-sm">
      <UIcon name="i-lucide-pause" class="mr-1" />{{ info.pause }}
    </p>
    <h4 v-if="info.notes.length > 0" class="text-sm font-semibold">Notes for {{ node.title }}</h4>
    <article
      v-for="note in info.notes"
      :key="note.id"
      class="rounded border border-default p-3 text-sm"
    >
      <p class="whitespace-pre-wrap">{{ note.text }}</p>
      <p class="mt-2 text-xs text-muted">
        {{ note.by }} · {{ note.at }} · {{ note.read === null ? "Unread" : `Read ${note.read}` }}
      </p>
      <div v-if="note.read === null && live" class="mt-2 flex gap-2">
        <UButton label="Edit" variant="link" size="xs" @click="edit(note)" />
        <UButton label="Remove" variant="link" size="xs" @click="remove(note.id)" />
      </div>
    </article>
  </section>
</template>
