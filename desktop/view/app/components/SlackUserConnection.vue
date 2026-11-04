<script setup lang="ts">
import * as Str from "effect/String";
import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import { failureOf, type Failed } from "../../../src/shared/actions";
import { FlockClient, slackUserAtom } from "../flock";

const signIn = useAtomSet(() => FlockClient.mutation("signInSlackUser"), { mode: "promiseExit" });
const signOut = useAtomSet(() => FlockClient.mutation("signOutSlackUser"), {
  mode: "promiseExit",
});
const emit = defineEmits<{ changed: [] }>();
const { value: state } = useHeld(() => slackUserAtom);
const clientId = ref("");
const busy = ref(false);
const refused = ref<string | null>(null);
const done = ref<string | null>(null);
const act = (run: () => Promise<Exit.Exit<string, Failed>>) => {
  busy.value = true;
  refused.value = null;
  done.value = null;
  return run().then((exit) => {
    busy.value = false;
    if (Exit.isFailure(exit)) refused.value = failureOf(exit.cause).reason;
    else {
      done.value = exit.value;
      clientId.value = "";
      emit("changed");
    }
  });
};
const start = () => act(() => Promise.resolve(signIn({ payload: { clientId: clientId.value } })));
const forget = () => act(() => Promise.resolve(signOut({ payload: undefined })));
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="slack-user-connection">
    <p class="text-sm font-medium">Slack as you</p>
    <p v-if="state?.signedIn && !state.trouble" class="text-sm" data-testid="slack-user-identity">
      Posts approval requests as {{ state.signedIn.user }} in {{ state.signedIn.team }}
    </p>
    <p v-if="state?.trouble" class="text-sm text-warning" role="status">{{ state.trouble }}</p>
    <form
      v-if="!state?.signedIn || state.trouble"
      class="flex flex-col gap-2"
      @submit.prevent="start"
    >
      <template v-if="!state?.clientId">
        <label for="slack-client-id" class="text-sm">
          The Collie app's Client ID, from Basic Information › App Credentials
        </label>
        <UInput
          id="slack-client-id"
          v-model="clientId"
          autocomplete="off"
          class="min-w-0"
          data-testid="slack-client-id"
        />
      </template>
      <div>
        <UButton
          type="submit"
          label="Sign in as yourself"
          :loading="busy"
          :disabled="busy || (!state?.clientId && Str.trim(clientId) === '')"
          data-testid="sign-in-slack-user"
        />
      </div>
      <p class="text-xs text-muted">
        Opens Slack in your browser. Release approval requests are then posted as you.
      </p>
    </form>
    <p v-if="refused" class="text-sm text-error" role="alert">{{ refused }}</p>
    <p v-if="done" class="text-sm text-success" role="status">{{ done }}</p>
    <div v-if="state?.signedIn">
      <UButton label="Sign out" variant="ghost" size="sm" :disabled="busy" @click="forget" />
    </div>
  </div>
</template>
