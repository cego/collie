<script setup lang="ts">
import { type OnboardRun, SETTLED } from "../../../src/shared/flock";

const open = defineModel<boolean>("open", { required: true });
const { rows } = useFlock();
const { addMachine, removeMachine, openLink, saveGitlabHost } = useActions();
const { job, onboardOn, loginOn } = useOnboarding();
const { credentials } = useCredentials();

const target = ref("");
const label = ref("");
const session = ref("default");
const host = ref("");
const saveHost = async () => {
  if (await saveGitlabHost(host.value.trim())) host.value = "";
};

const STATE = {
  live: { label: "Live", color: "success" },
  connecting: { label: "Connecting", color: "neutral" },
  unreachable: { label: "Out of reach", color: "warning" },
  sso: { label: "Waiting for SSO", color: "warning" },
  "no-collie": { label: "Collie isn't installed", color: "warning" },
  "update-desktop": { label: "Update Desktop", color: "warning" },
} as const;

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
        <DesktopVersion />
        <section v-if="credentials" class="flex flex-col gap-3" data-testid="credentials">
          <h3 class="text-sm font-semibold">Given to every Machine</h3>
          <form class="flex gap-2" data-testid="gitlab-host-form" @submit.prevent="saveHost">
            <UInput
              v-model="host"
              class="flex-1"
              :placeholder="`GitLab host: ${credentials.host}`"
              data-testid="gitlab-host"
            />
            <UButton
              type="submit"
              size="sm"
              label="Use this GitLab"
              data-testid="save-gitlab-host"
              :disabled="host.trim() === ''"
            />
          </form>
          <div class="flex items-center gap-2">
            <span class="font-medium">GitLab token</span>
            <span class="text-sm text-muted" data-testid="gitlab-state">
              {{
                credentials.gitlab === null
                  ? "none yet"
                  : credentials.gitlab.expires === null
                    ? "kept"
                    : `expires ${credentials.gitlab.expires}`
              }}
            </span>
            <UButton
              class="ml-auto"
              size="xs"
              variant="outline"
              icon="i-lucide-external-link"
              label="Make one on GitLab"
              data-testid="token-page"
              @click="openLink(credentials.tokenPage)"
            />
          </div>
          <CredentialFields
            which="gitlab"
            :label="credentials.gitlab === null ? 'Save' : 'Renew'"
          />
          <div class="flex items-center gap-2">
            <span class="font-medium">Helle</span>
            <span class="text-sm text-muted" data-testid="helle-state">
              {{ credentials.helle ? "kept" : "none yet" }}
            </span>
          </div>
          <CredentialFields which="helle" label="Save" />
        </section>
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
          v-for="row in rows"
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
              :color="STATE[row.state].color"
              :label="STATE[row.state].label"
            />
          </div>
          <p
            v-if="row.onboarded?.ready === true"
            class="text-sm text-success"
            data-testid="onboarded"
          >
            Onboarded
          </p>
          <template v-else-if="row.onboarded?.ready === false">
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
