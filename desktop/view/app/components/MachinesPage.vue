<script setup lang="ts">
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { type OnboardRun, routeSaid, SETTLED } from "../../../src/shared/flock";
import { buildOf, type InSync, NOT_LIVE_SAID, syncable } from "../../../src/shared/in-sync";
import { type ScheduleAction, machineSchedules, scheduleAsk } from "../../../src/shared/schedules";

const emit = defineEmits<{ back: [] }>();
const { machines, summary } = useInSync();
const { checkForUpdates, removeMachine, syncNow } = useActions();
const { onboardOn, loginOn } = useOnboarding();
const adding = ref(false);
const cleaning = ref(false);
const scheduled = useSchedules();
onMounted(() => void scheduled.refresh());
const schedulesOf = (row: (typeof machines.value)[number]["row"]) => {
  const read =
    row.state === "live"
      ? Option.getOrUndefined(
          Arr.findFirst(scheduled.machines.value, ({ profile }) => profile === row.profile),
        )
      : {
          installation: "",
          profile: row.profile,
          name: row.name,
          schedules: [],
          problem: row.reason,
          unreachable: true,
        };
  return read === undefined ? null : { installation: read.installation, ...machineSchedules(read) };
};
const rows = computed(() =>
  Arr.map(machines.value, (machine) => ({
    ...machine,
    schedules: schedulesOf(machine.row),
  })),
);
const moving = ref<{ name: string; from: string } | null>(null);
const movingOpen = computed({
  get: () => moving.value !== null,
  set: (open) => {
    if (!open) moving.value = null;
  },
});
const targets = computed(() =>
  Arr.map(
    Arr.filter(
      scheduled.machines.value,
      ({ unreachable, problem, installation }) =>
        !unreachable &&
        problem === null &&
        installation !==
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(moving.value), (present) => present.from),
          ),
    ),
    ({ installation, name }) => ({
      installation,
      name,
    }),
  ),
);
const ACTION = {
  pause: { label: "Pause", icon: "i-lucide-pause" },
  resume: { label: "Resume", icon: "i-lucide-play" },
  remove: { label: "Remove", icon: "i-lucide-trash-2" },
  move: { label: "Move to…", icon: "i-lucide-arrow-right-left" },
} as const satisfies Record<ScheduleAction, { label: string; icon: string }>;
const onAction = (installation: string, name: string, action: ScheduleAction) => {
  const asked = scheduleAsk(installation, name, action);
  if (asked.kind === "move") moving.value = { name: asked.name, from: asked.from };
  else void scheduled.change(asked.payload);
};

const badgeOf = (state: InSync["state"]) =>
  state === "in-sync"
    ? { label: "In sync", color: "success" as const }
    : state === "behind"
      ? { label: "Behind", color: "warning" as const }
      : state === "connecting"
        ? { label: "Connecting", color: "neutral" as const }
        : { label: NOT_LIVE_SAID[state], color: "warning" as const };

const missing = (run: OnboardRun) =>
  Arr.filter(run.steps, ({ status }) => !SETTLED.includes(status));
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
        <div class="flex gap-2">
          <UButton
            icon="i-lucide-plus"
            label="Add Machine"
            data-testid="add-machine"
            @click="adding = true"
          />
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-brush-cleaning"
            label="Clean up…"
            data-testid="clean-up"
            @click="cleaning = true"
          />
        </div>
        <AddMachineDialog v-model:open="adding" />
        <CleanupDialog v-model:open="cleaning" />
        <MoveScheduleDialog
          v-model:open="movingOpen"
          :name="moving?.name ?? ''"
          :from="moving?.from ?? ''"
          :targets="targets"
        />
        <section
          v-for="{ row, verdict, schedules: listed } in rows"
          :key="row.profile"
          :data-testid="`machine-${row.name}`"
          class="flex flex-col gap-2 border-t border-default pt-4"
        >
          <div class="flex items-center gap-2">
            <strong>{{ row.name }}</strong>
            <span class="text-sm text-muted">{{ row.target ?? "this computer" }}</span>
            <span v-if="row.route" class="text-sm text-muted">{{ routeSaid(row) }}</span>
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
          <p
            v-if="row.transportReason !== null"
            class="text-sm text-muted"
            data-testid="transport-reason"
          >
            {{ row.transportReason }}
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
          <section v-if="listed !== null" class="flex flex-col gap-2" data-testid="schedules">
            <h3 class="text-sm font-semibold">Schedules on {{ row.name }}</h3>
            <p
              v-if="listed.said !== null"
              class="text-sm"
              :class="listed.state === 'empty' ? 'text-muted' : 'text-warning'"
              data-testid="schedules-said"
            >
              {{ listed.said }}
            </p>
            <div
              v-for="schedule in listed.rows"
              :key="schedule.name"
              class="flex flex-col gap-1 text-sm"
              :data-testid="`schedule-${schedule.name}`"
            >
              <div class="flex items-center gap-2">
                <strong>{{ schedule.name }}</strong>
                <span class="text-muted">{{ schedule.workflow }} in {{ schedule.checkout }}</span>
              </div>
              <span>{{ schedule.when }} · {{ schedule.next }}</span>
              <span class="text-xs text-muted">last {{ schedule.last }}</span>
              <div class="flex gap-2">
                <UButton
                  v-for="action in schedule.actions"
                  :key="action"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="ACTION[action].icon"
                  :label="ACTION[action].label"
                  :data-testid="`schedule-${action}`"
                  @click="onAction(listed.installation, schedule.name, action)"
                />
              </div>
            </div>
          </section>
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
