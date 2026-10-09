<script setup lang="ts">
import { type OnboardRun, SETTLED } from "../../../src/shared/flock";
import { buildOf, type InSync, NOT_LIVE_SAID, syncable } from "../../../src/shared/in-sync";

const emit = defineEmits<{ back: [] }>();
const { machines, summary } = useInSync();
const { checkForUpdates, removeMachine, syncNow } = useActions();
const { onboardOn, loginOn } = useOnboarding();
const adding = ref(false);

const badgeOf = (state: InSync["state"]) =>
  state === "in-sync"
    ? { label: "In sync", color: "success" as const }
    : state === "behind"
      ? { label: "Behind", color: "warning" as const }
      : state === "connecting"
        ? { label: "Connecting", color: "neutral" as const }
        : { label: NOT_LIVE_SAID[state], color: "warning" as const };

const missing = (run: OnboardRun) => run.steps.filter(({ status }) => !SETTLED.includes(status));
</script>

<template>
  <section data-testid="machines-page" class="flex flex-col bg-default">
    <PageHeader title="Machines" @back="emit('back')" />
    <div class="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
      <div class="flex flex-col gap-6" :class="columnClass('machines')">
        <p
          v-if="summary !== null"
          class="text-sm font-medium"
          :class="summary.count === 0 ? 'text-success' : 'text-warning'"
          data-testid="in-sync"
        >
          {{ summary.said }}
        </p>
        <UButton
          class="self-start"
          icon="i-lucide-plus"
          label="Add Machine"
          data-testid="add-machine"
          @click="adding = true"
        />
        <AddMachineDialog v-model:open="adding" />
        <section
          v-for="{ row, verdict } in machines"
          :key="row.profile"
          :data-testid="`machine-${row.name}`"
          class="flex flex-col gap-2 border-t border-default pt-4"
        >
          <div class="flex items-center gap-2">
            <strong>{{ row.name }}</strong>
            <span class="text-sm text-muted">{{ row.target ?? "this computer" }}</span>
            <UBadge
              class="ml-auto"
              variant="subtle"
              data-testid="state"
              :color="badgeOf(verdict.state).color"
              :label="badgeOf(verdict.state).label"
            />
          </div>
          <p v-if="row.reason !== null" class="text-sm text-warning" data-testid="reason">
            {{ row.reason }}
          </p>
          <p class="text-sm text-muted" data-testid="build">{{ buildOf(row) }}</p>
          <template v-for="lag in verdict.behind" :key="lag.said">
            <p class="text-sm text-warning" :data-testid="`behind-${lag.part}`">{{ lag.said }}</p>
            <OnboardSteps
              v-if="lag.part === 'onboarding'"
              data-testid="missing"
              :steps="lag.steps"
              :ended="true"
              @retry="onboardOn(row.profile)"
              @login="loginOn(row.profile)"
              @skip="(step) => onboardOn(row.profile, [step])"
            />
          </template>
          <p
            v-if="row.onboarded?.ready === true"
            class="text-sm text-success"
            data-testid="onboarded"
          >
            Onboarded
          </p>
          <template v-else-if="row.onboarded?.ready === false && verdict.state !== 'behind'">
            <p class="text-sm text-warning">Not onboarded yet:</p>
            <OnboardSteps
              data-testid="missing"
              :steps="missing(row.onboarded)"
              :ended="true"
              @retry="onboardOn(row.profile)"
              @login="loginOn(row.profile)"
              @skip="(step) => onboardOn(row.profile, [step])"
            />
          </template>
          <div class="flex justify-end gap-2">
            <UButton
              v-if="syncable(verdict)"
              color="warning"
              icon="i-lucide-refresh-cw"
              label="Sync now"
              data-testid="sync-now"
              @click="syncNow(row.profile)"
            />
            <UButton
              v-if="row.state === 'update-desktop'"
              color="neutral"
              variant="outline"
              icon="i-lucide-circle-arrow-up"
              label="Check for updates"
              data-testid="check-updates"
              @click="checkForUpdates()"
            />
            <UButton
              v-if="row.target !== null"
              color="neutral"
              variant="outline"
              label="Remove"
              data-testid="remove"
              @click="removeMachine(row.profile)"
            />
            <UButton label="Onboard" data-testid="onboard" @click="onboardOn(row.profile)" />
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
