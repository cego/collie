<script setup lang="ts">
import { type OnboardStep, SETTLED } from "../../../src/shared/flock";

/** `ended` once the onboarding has, when a step left unsettled offers to try again. */
defineProps<{ steps: ReadonlyArray<OnboardStep>; ended: boolean }>();
const emit = defineEmits<{ retry: [] }>();
const { openLink } = useActions();

const ICON: Record<OnboardStep["status"], string> = {
  running: "i-lucide-loader-circle",
  done: "i-lucide-circle-check",
  in_place: "i-lucide-circle-check",
  skipped: "i-lucide-circle-minus",
  needs_root: "i-lucide-shield-alert",
  needs_human: "i-lucide-hand",
  failed: "i-lucide-circle-x",
};
const left = ({ status }: OnboardStep) => status !== "running" && !SETTLED.includes(status);
</script>

<template>
  <ul class="flex flex-col gap-2">
    <li
      v-for="one in steps"
      :key="one.step"
      :data-testid="`step-${one.step}`"
      class="flex items-start gap-2"
    >
      <UIcon
        :name="ICON[one.status]"
        class="mt-0.5 size-4 shrink-0"
        :class="{
          'animate-spin': one.status === 'running',
          'text-success': one.status === 'done' || one.status === 'in_place',
          'text-warning': one.status === 'needs_root' || one.status === 'needs_human',
          'text-error': one.status === 'failed',
        }"
      />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="font-medium" data-testid="title">{{ one.title }}</span>
        <span v-if="one.detail" class="text-sm text-muted" data-testid="detail">
          {{ one.detail }}
        </span>
        <code
          v-if="one.command"
          class="rounded bg-elevated px-2 py-1 text-sm break-all"
          data-testid="command"
          >{{ one.command }}</code
        >
        <div class="flex gap-2">
          <UButton
            v-if="one.url"
            size="xs"
            variant="outline"
            icon="i-lucide-external-link"
            label="Open"
            data-testid="open"
            @click="openLink(one.url)"
          />
          <!-- Saving in herdr is not onboarding: a Machine herdr would not save is added again. -->
          <UButton
            v-if="ended && left(one) && one.step !== 'herdr'"
            size="xs"
            icon="i-lucide-rotate-cw"
            label="Retry"
            data-testid="retry"
            @click="emit('retry')"
          />
        </div>
      </div>
    </li>
  </ul>
</template>
