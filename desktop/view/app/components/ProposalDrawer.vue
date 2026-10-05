<script setup lang="ts">
import type { Proposal } from "../../../../src/board-model";

const props = defineProps<{ proposal: Proposal }>();
const emit = defineEmits<{ confirm: []; decline: [] }>();
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
const decide = (yes: boolean) => {
  open.value = false;
  if (yes) emit("confirm");
  else emit("decline");
};
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
            <span v-if="!action.allowed"> (not allowed)</span>
          </li>
        </ol>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <small v-if="!seen" class="mr-auto text-muted">Read to the end to confirm.</small>
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
