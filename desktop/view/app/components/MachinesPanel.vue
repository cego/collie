<script setup lang="ts">
import { type MachineRow, type OnboardRun, SETTLED } from "../../../src/shared/flock";
import { type InSync, NOT_LIVE_SAID } from "../../../src/shared/in-sync";

const open = defineModel<boolean>("open", { required: true });
const { machines, summary } = useInSync();
const { addMachine, removeMachine } = useActions();
const { job, onboardOn, loginOn } = useOnboarding();

const target = ref("");
const label = ref("");
const session = ref("default");

const STATE = {
  "in-sync": { label: "In sync", color: "success" },
  behind: { label: "Behind", color: "warning" },
  live: { label: "Live", color: "success" },
  connecting: { label: "Connecting", color: "neutral" },
  unreachable: { label: NOT_LIVE_SAID.unreachable, color: "warning" },
  sso: { label: NOT_LIVE_SAID.sso, color: "warning" },
  "no-collie": { label: NOT_LIVE_SAID["no-collie"], color: "warning" },
  "update-desktop": { label: NOT_LIVE_SAID["update-desktop"], color: "warning" },
} as const;
const stateOf = (row: MachineRow, verdict: InSync | null) => STATE[verdict?.state ?? row.state];
const buildOf = ({ build, development }: MachineRow) =>
  development !== null
    ? `development build ${development}`
    : build !== null
      ? `Collie ${build}`
      : "Build not known yet";

const missing = (run: OnboardRun) => run.steps.filter(({ status }) => !SETTLED.includes(status));
const add = async () => {
  const started = await addMachine(target.value.trim(), label.value.trim(), session.value.trim());
  if (started !== null) job.value = started;
  target.value = "";
  label.value = "";
};
</script>

<template>
  <USlideover v-model:open="open" title="Machines">
    <template #body>
      <div class="flex flex-col gap-6">
        <p
          v-if="summary !== null"
          class="text-sm font-medium"
          :class="summary.count === 0 ? 'text-success' : 'text-warning'"
          data-testid="in-sync"
        >
          {{ summary.said }}
        </p>
        <form class="flex flex-col gap-2" data-testid="add-form" @submit.prevent="add">
          <UFormField label="SSH target" help="As ssh reaches it, such as mk@vm-mk.example">
            <UInput v-model="target" class="w-full" data-testid="add-target" />
          </UFormField>
          <div class="flex gap-2">
            <UFormField label="Label" class="flex-1">
              <UInput v-model="label" class="w-full" data-testid="add-label" />
            </UFormField>
            <UFormField label="herdr session" class="flex-1">
              <UInput v-model="session" class="w-full" data-testid="add-session" />
            </UFormField>
          </div>
          <UButton
            type="submit"
            class="self-end"
            icon="i-lucide-plus"
            label="Add Machine"
            data-testid="add-machine"
            :disabled="target.trim() === '' || label.trim() === '' || session.trim() === ''"
          />
        </form>
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
              :color="stateOf(row, verdict).color"
              :label="stateOf(row, verdict).label"
            />
          </div>
          <p class="text-sm text-muted" data-testid="build">{{ buildOf(row) }}</p>
          <p
            v-for="lag in verdict?.behind.filter(({ part }) => part !== 'onboarding') ?? []"
            :key="lag.part"
            class="text-sm text-warning"
            :data-testid="`behind-${lag.part}`"
          >
            {{ lag.said }}
          </p>
          <p
            v-if="row.onboarded?.ready === true"
            class="text-sm text-success"
            data-testid="onboarded"
          >
            Onboarded
          </p>
          <template v-else-if="row.onboarded?.ready === false">
            <p class="text-sm text-warning" data-testid="behind-onboarding">Not onboarded yet:</p>
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
    </template>
  </USlideover>
</template>
