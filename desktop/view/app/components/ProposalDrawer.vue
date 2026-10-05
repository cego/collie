<script setup lang="ts">
import type { Proposal } from "../../../../src/board-model";

const props = defineProps<{ proposal: Proposal }>();
const emit = defineEmits<{ confirm: [shown: Proposal]; decline: [shown: Proposal] }>();
const open = defineModel<boolean>("open", { required: true });

const content = ref<HTMLElement | null>(null);
/** A yes is consent to what was read, so it waits until all of it has been on screen. */
const seen = ref(false);
const look = () => {
  const shown = content.value;
  if (shown !== null && shown.scrollTop + shown.clientHeight >= shown.scrollHeight - 2)
    seen.value = true;
};
watch(
  () => [open.value, props.proposal.hash] as const,
  async ([isOpen]) => {
    seen.value = false;
    if (!isOpen) return;
    await nextTick();
    requestAnimationFrame(look);
  },
);
// What the human read, not whatever the card holds by the time the click lands.
const decide = (yes: boolean) => {
  const shown = props.proposal;
  open.value = false;
  if (yes) emit("confirm", shown);
  else emit("decline", shown);
};
// A window made larger can show the rest without a scroll.
let resized: ResizeObserver | undefined;
watch(content, (shown) => {
  resized?.disconnect();
  if (shown === null) return;
  resized = new ResizeObserver(look);
  resized.observe(shown);
});
onBeforeUnmount(() => resized?.disconnect());
</script>

<template>
  <USlideover v-model:open="open" title="What Collie proposes" :ui="{ body: 'flex flex-col' }">
    <template #body>
      <div
        ref="content"
        data-testid="proposal-content"
        class="max-h-[60vh] flex-1 overflow-y-auto pr-2"
        @scroll="look"
      >
        <p class="whitespace-pre-wrap text-sm">{{ proposal.text }}</p>
        <ol class="mt-4 flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li
            v-for="(action, at) in proposal.actions"
            :key="at"
            :class="action.allowed ? '' : 'text-muted'"
          >
            {{ action.text }}
            <span v-if="!action.allowed"> — needs your yes</span>
          </li>
        </ol>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <small class="mr-auto text-muted" data-testid="proposal-id">
          {{ seen ? `${proposal.id} · ${proposal.hash}` : "Read to the end to confirm." }}
        </small>
        <UButton
          color="neutral"
          variant="outline"
          label="Decline"
          data-testid="decline"
          @click="decide(false)"
        />
        <UButton label="Confirm" data-testid="confirm" :disabled="!seen" @click="decide(true)" />
      </div>
    </template>
  </USlideover>
</template>
