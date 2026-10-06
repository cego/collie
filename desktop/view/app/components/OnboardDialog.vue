<script setup lang="ts">
const { onboarding } = useFlock();
const { answerHerdr } = useActions();
const { job, onboardOn } = useOnboarding();

const current = computed(() => (job.value === null ? undefined : onboarding.value.get(job.value)));
const asked = computed(() => current.value?.run.asked ?? null);
const left = computed(() => {
  const run = current.value?.run;
  return run !== undefined && run.ready === false && run.reason !== null ? run.reason : null;
});
const open = computed({
  get: () => job.value !== null,
  set: (isOpen) => {
    if (isOpen) return;
    // A question nobody can see any more takes herdr's own default.
    if (asked.value !== null) answer(asked.value.yes);
    job.value = null;
  },
});

/** Onboarding again repairs: every step skips what is already in place. */
const retry = () => {
  const profile = current.value?.machine.profile;
  if (profile !== undefined) void onboardOn(profile);
};
const answer = (yes: boolean) => {
  if (job.value !== null) void answerHerdr(job.value, yes);
};
</script>

<template>
  <UModal v-model:open="open" :title="`Onboarding ${current?.machine.name ?? ''}`">
    <template #body>
      <div class="flex flex-col gap-4" data-testid="onboarding">
        <p v-if="current === undefined" class="text-muted">Starting…</p>
        <template v-else>
          <OnboardSteps
            :steps="current.run.steps"
            :ended="current.run.ready !== null"
            @retry="retry"
          />
          <p v-if="current.run.ready === true" class="text-success" data-testid="outcome">
            Onboarded: collie doctor is ready.
          </p>
          <p v-else-if="current.run.ready === false" class="text-warning" data-testid="outcome">
            Not onboarded yet{{ left === null ? "." : `: ${left}` }}
          </p>
        </template>
      </div>
      <!-- herdr's own question; closing it answers herdr's default. -->
      <UModal
        :open="asked !== null"
        title="herdr asks"
        :dismissible="true"
        @update:open="(isOpen) => !isOpen && asked !== null && answer(asked.yes)"
      >
        <template #body>
          <div class="flex flex-col gap-3" data-testid="herdr-question">
            <p class="whitespace-pre-line" data-testid="question">{{ asked?.text }}</p>
            <div class="flex justify-end gap-2">
              <UButton
                label="No"
                data-testid="herdr-no"
                :variant="asked?.yes ? 'outline' : 'solid'"
                :autofocus="!asked?.yes"
                @click="answer(false)"
              />
              <UButton
                label="Yes"
                data-testid="herdr-yes"
                :variant="asked?.yes ? 'solid' : 'outline'"
                :autofocus="asked?.yes"
                @click="answer(true)"
              />
            </div>
          </div>
        </template>
      </UModal>
    </template>
  </UModal>
</template>
