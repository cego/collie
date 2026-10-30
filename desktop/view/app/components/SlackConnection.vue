<script setup lang="ts">
import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { SlackChoices } from "../../../../src/slack";
import { SLACK_MANIFEST_URL } from "../../../src/shared/slack";
import { failureOf } from "../../../src/shared/actions";
import { FlockClient } from "../flock";

defineProps<{ choices: SlackChoices | null; trouble: string | null; loading: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const { openLink } = useActions();
const save = useAtomSet(() => FlockClient.mutation("saveSlack"), { mode: "promiseExit" });
const disconnect = useAtomSet(() => FlockClient.mutation("disconnectSlack"), {
  mode: "promiseExit",
});
const token = ref("");
const busy = ref(false);
const refused = ref<string | null>(null);
const done = ref<string | null>(null);
watch(token, () => {
  refused.value = null;
});
const keep = async () => {
  busy.value = true;
  refused.value = null;
  const exit = await save({ payload: { token: token.value } });
  busy.value = false;
  if (Exit.isFailure(exit)) {
    refused.value = failureOf(exit.cause).reason;
    return;
  }
  token.value = "";
  done.value = exit.value;
  emit("refresh");
};
const forget = async () => {
  busy.value = true;
  const exit = await disconnect({ payload: undefined });
  busy.value = false;
  if (Exit.isFailure(exit)) refused.value = failureOf(exit.cause).reason;
  else {
    done.value = exit.value;
    emit("refresh");
  }
};
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="slack-connection">
    <p class="text-sm text-muted">
      One Collie app per Slack workspace, shared by everyone in it. Nothing to host.
    </p>
    <p v-if="choices" class="text-sm font-medium" data-testid="slack-identity">
      Posts as {{ choices.identity.user }} in {{ choices.identity.team }}
    </p>
    <ol v-if="!choices" class="flex flex-col gap-2 text-sm">
      <li>
        1.
        <UButton
          label="Add Collie to your Slack"
          variant="link"
          icon="i-lucide-external-link"
          @click="openLink(SLACK_MANIFEST_URL)"
        />
        installs the app with everything filled in. Skip this if a teammate already installed it.
      </li>
      <li>2. Under OAuth &amp; Permissions, copy the Bot User OAuth Token and paste it here.</li>
    </ol>
    <form v-if="!choices" class="flex flex-col gap-2" @submit.prevent="keep">
      <label for="slack-bot-token" class="text-sm font-medium">Bot token</label>
      <div class="flex gap-2">
        <UInput
          id="slack-bot-token"
          v-model="token"
          type="password"
          autocomplete="off"
          placeholder="xoxb-…"
          class="min-w-0 flex-1"
          :aria-invalid="refused !== null"
          aria-describedby="slack-token-error slack-token-hint"
          data-testid="slack-token"
        />
        <UButton
          type="submit"
          label="Connect"
          :loading="busy"
          :disabled="busy || token.trim() === ''"
          data-testid="save-slack"
        />
      </div>
      <p id="slack-token-hint" class="text-xs text-muted">
        Checked with Slack, kept in a credentials file readable by you alone, and given to your
        Machines.
      </p>
    </form>
    <p v-if="refused" id="slack-token-error" class="text-sm text-error" role="alert">
      {{ refused }}
    </p>
    <p v-if="choices" class="text-xs text-muted">
      Checked with Slack. The token is kept in a file only you can read.
    </p>
    <p v-if="done" class="text-sm text-success" role="status">{{ done }}</p>
    <p v-if="trouble" class="text-sm text-muted" role="status">{{ trouble }}</p>
    <div v-if="choices" class="flex flex-col gap-2">
      <p class="text-sm text-muted">
        Channels Collie is in. Add it to another with <code>/invite @Collie</code>, then refresh.
      </p>
      <div class="flex flex-wrap gap-2">
        <UBadge
          v-for="channel in choices.channels"
          :key="channel.id"
          variant="subtle"
          color="neutral"
          :label="`#${channel.name}`"
        />
      </div>
      <p v-if="choices.channels.length === 0" class="text-sm text-muted">
        Collie has not joined any channels yet.
      </p>
    </div>
    <slot />
    <div class="flex gap-2">
      <UButton
        label="Refresh Slack"
        variant="outline"
        size="sm"
        :loading="loading"
        @click="emit('refresh')"
      />
      <UButton
        v-if="choices"
        label="Disconnect"
        variant="ghost"
        size="sm"
        :disabled="busy"
        @click="forget"
      />
    </div>
    <p class="text-sm text-muted">Talking to Collie in Slack is not built.</p>
  </div>
</template>
