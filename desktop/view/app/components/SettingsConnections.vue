<script setup lang="ts">
import type { ConnectionId } from "../../../../src/connection-model";
import {
  connectionUses,
  type ConnectionWorkflow,
  type connectionCards,
} from "../../../src/shared/connections";

const props = defineProps<{
  cards: ReturnType<typeof connectionCards>;
  workflows: ReadonlyArray<ConnectionWorkflow>;
  reading: boolean;
  trouble: string | null;
}>();
const emit = defineEmits<{ refresh: [] }>();
const { openLink, saveGitlabHost, reuseConnection, githubLogin, linearSetup } = useActions();
const { credentials, trouble: credentialsTrouble } = useCredentials();
const { own, onboarding } = useFlock();
const { job } = useOnboarding();
const opened = ref<ConnectionId | null>(null);
const current = computed(() => props.cards.find((card) => card.id === opened.value));
const uses = computed(() =>
  opened.value === null ? [] : connectionUses(opened.value, props.workflows),
);
const busy = ref<ConnectionId | null>(null);
const done = ref<Partial<Record<ConnectionId, string>>>({});
const host = ref("");
const otherHost = ref(false);
const saveHost = async () => {
  if (await saveGitlabHost(host.value.trim())) {
    host.value = "";
    emit("refresh");
  }
};
const team = (profile: string) =>
  own.value
    .find((row) => row.profile === profile)
    ?.remembered.find((row) => row.key === "linear.team")?.value;
const run = async (card: ReturnType<typeof connectionCards>[number]) => {
  const action = card.primary;
  if (action === null || busy.value !== null) return;
  opened.value = card.id;
  if (action.kind === "connect") {
    if (card.id === "gitlab" && credentials.value !== null)
      await openLink(credentials.value.tokenPage);
    return;
  }
  busy.value = card.id;
  delete done.value[card.id];
  try {
    if (action.kind === "reuse" && (card.id === "gitlab" || card.id === "github")) {
      const said = await reuseConnection(card.id, action.from, action.to);
      if (said !== null) done.value[card.id] = said;
    } else if (action.kind === "login") {
      const said = await githubLogin(action.to[0]!);
      if (said !== null) done.value[card.id] = said;
    } else if (action.kind === "setup") {
      const started = await linearSetup(action.to[0]!);
      if (started !== null) {
        job.value = started;
        done.value[card.id] = "Linear setup started; approve its login in your browser.";
      }
    }
    emit("refresh");
  } finally {
    busy.value = null;
  }
};
watch(
  () =>
    [...onboarding.value.values()]
      .map((one) => `${one.job}:${one.run.at}:${one.run.ready}`)
      .join(","),
  () => emit("refresh"),
);
</script>

<template>
  <section
    id="connections"
    aria-labelledby="connections-title"
    class="flex flex-col gap-4"
    data-testid="connections"
  >
    <div class="flex items-center justify-between gap-3">
      <h3 id="connections-title" class="text-sm font-semibold">Connections</h3>
      <UButton
        label="Refresh"
        size="xs"
        variant="ghost"
        :loading="reading"
        @click="emit('refresh')"
      />
    </div>
    <p class="text-sm text-muted">
      The services your Flock reaches, as which account, and on which Machines. Use a login a
      Machine already has everywhere, or connect where none is found.
    </p>
    <UAlert
      v-if="trouble !== null"
      color="warning"
      title="Connections could not be read"
      :description="trouble"
      :actions="[{ label: 'Retry', onClick: () => emit('refresh') }]"
    />
    <RetryNotice
      v-if="credentialsTrouble !== null"
      title="Desktop could not read its credentials"
      :trouble="credentialsTrouble"
    />
    <div class="grid grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-3">
      <article
        v-for="card in cards"
        :key="card.id"
        class="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
        :class="opened === card.id ? 'border-primary' : 'border-default'"
        :data-testid="`connection-${card.id}`"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="font-semibold">{{ card.name }}</h4>
          <UBadge
            :color="card.needsYou ? 'warning' : 'success'"
            variant="subtle"
            size="sm"
            :label="card.state"
          />
        </div>
        <p class="text-sm text-muted">{{ card.account ?? "No account connected" }}</p>
        <p class="text-xs" :class="card.needsYou ? 'text-warning' : 'text-muted'">
          {{ card.where }}
        </p>
        <p class="text-xs text-muted">
          Used by
          {{
            connectionUses(card.id, workflows)
              .map((row) => row.id)
              .join(", ") || "no declared workflow"
          }}
        </p>
        <p v-if="done[card.id]" class="text-xs text-success" role="status">{{ done[card.id] }}</p>
        <div class="mt-auto flex flex-wrap gap-2 pt-1">
          <UButton
            v-if="card.primary"
            size="xs"
            :label="card.primary.label"
            :loading="busy === card.id"
            :disabled="busy !== null"
            :data-testid="`connect-${card.id}`"
            @click="run(card)"
          />
          <UButton
            size="xs"
            variant="outline"
            :label="opened === card.id ? 'Close' : 'Details'"
            :aria-expanded="opened === card.id"
            aria-controls="connection-details"
            @click="opened = opened === card.id ? null : card.id"
          />
        </div>
      </article>
    </div>
    <div
      v-if="current"
      id="connection-details"
      class="flex flex-col gap-4 rounded-lg border border-default p-4"
      :aria-label="`${current.name} details`"
    >
      <h4 class="font-semibold">{{ current.name }} · {{ current.state }}</h4>
      <div class="overflow-x-auto rounded-md border border-default">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">
            Workflows that declare
            {{
              current.name
            }}
          </caption>
          <thead class="bg-elevated text-xs text-muted">
            <tr>
              <th scope="col" class="p-2">Workflow</th>
              <th scope="col" class="p-2">Declares</th>
              <th scope="col" class="p-2">With it</th>
              <th scope="col" class="p-2">Without it</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in uses" :key="row.id" class="border-t border-default">
              <th scope="row" class="p-2 font-medium">{{ row.id }}</th>
              <td class="p-2">{{ row.declares }}</td>
              <td class="p-2">{{ row.with }}</td>
              <td class="p-2 text-muted">{{ row.without }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul class="flex flex-col gap-2 text-sm">
        <li
          v-for="machine in current.machines"
          :key="machine.profile"
          class="flex flex-wrap justify-between gap-2"
        >
          <span class="font-medium">{{ machine.name }}</span>
          <span class="text-muted"
            >{{ machine.problem ?? machine.reading?.detail ?? "Not read yet"
            }}<template v-if="current.id === 'linear' && team(machine.profile)">
              · team {{ team(machine.profile) }}</template
            ></span
          >
          <span
            v-if="machine.reading && machine.reading.state !== 'ok'"
            class="w-full text-xs text-muted"
            >{{ machine.reading.fix }}</span
          >
        </li>
      </ul>
      <template v-if="current.id === 'gitlab' && credentials">
        <p class="text-sm text-muted">
          {{ credentials.host }} ·
          {{
            credentials.gitlab?.expires
              ? `Token expires ${credentials.gitlab.expires}`
              : credentials.gitlab
                ? "Token kept on this computer"
                : "No token kept yet"
          }}
        </p>
        <div class="flex flex-wrap gap-2">
          <UButton
            label="Make one on GitLab"
            size="xs"
            variant="outline"
            icon="i-lucide-external-link"
            data-testid="token-page"
            @click="openLink(credentials.tokenPage)"
          />
          <UButton
            label="Use another GitLab…"
            size="xs"
            variant="ghost"
            :aria-expanded="otherHost"
            @click="otherHost = !otherHost"
          />
        </div>
        <form
          v-if="otherHost"
          class="flex flex-col gap-2"
          data-testid="gitlab-host-form"
          @submit.prevent="saveHost"
        >
          <label for="connection-gitlab-host" class="text-sm font-medium">GitLab host</label>
          <div class="flex gap-2">
            <UInput
              id="connection-gitlab-host"
              v-model="host"
              class="min-w-0 flex-1"
              :placeholder="credentials.host"
              data-testid="gitlab-host"
            /><UButton
              type="submit"
              size="sm"
              label="Use this GitLab"
              :disabled="host.trim() === ''"
              data-testid="save-gitlab-host"
            />
          </div>
          <p
            v-if="host.trim() !== '' && host.trim() !== credentials.host"
            class="text-sm text-warning"
          >
            Changing GitLab forgets the token made for {{ credentials.host }}. Make one on the new
            host after.
          </p>
        </form>
        <CredentialFields
          which="gitlab"
          :label="credentials.gitlab === null ? 'Save' : 'Renew'"
          @saved="emit('refresh')"
        />
      </template>
      <template v-if="current.id === 'helle'"
        ><p class="text-sm text-muted">
          Paste once. Desktop gives the token to every Machine's credentials file, readable by its
          owner alone.
        </p>
        <CredentialFields which="helle" label="Save" @saved="emit('refresh')"
      /></template>
      <p v-if="current.id === 'github'" class="text-sm text-muted">
        gh keeps the login on each Machine. If gh is missing, install it there, then try again.
        After finishing the browser login, refresh Connections.
      </p>
      <p v-if="current.id === 'linear'" class="text-sm text-muted">
        Setup adds the Linear MCP and opens its browser login. A remembered team belongs to that
        Machine; renovate asks through Linear when it needs one.
      </p>
    </div>
  </section>
</template>
