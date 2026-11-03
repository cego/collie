<script setup lang="ts">
import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import { failureOf, type Failed } from "../../../src/shared/actions";
import { FlockClient, slackUserAtom } from "../flock";

defineProps<{ loading: boolean }>();
const signIn = useAtomSet(() => FlockClient.mutation("signInSlackUser"), { mode: "promiseExit" });
const signOut = useAtomSet(() => FlockClient.mutation("signOutSlackUser"), {
  mode: "promiseExit",
});
const emit = defineEmits<{ changed: []; refresh: [] }>();
const { value: state } = useHeld(() => slackUserAtom);
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
      emit("changed");
    }
  });
};
const start = () => act(() => Promise.resolve(signIn({ payload: undefined })));
const forget = () => act(() => Promise.resolve(signOut({ payload: undefined })));
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="slack-user-connection">
    <p v-if="state?.signedIn && !state.trouble" class="text-sm" data-testid="slack-user-identity">
      Posts as {{ state.signedIn.user }} in {{ state.signedIn.team }}
    </p>
    <p v-if="state?.trouble" class="text-sm text-warning" role="status">{{ state.trouble }}</p>
    <div v-if="!state?.signedIn || state.trouble" class="flex flex-col gap-2">
      <div>
        <UButton
          label="Sign in to Slack"
          :loading="busy"
          :disabled="busy"
          data-testid="sign-in-slack-user"
          @click="start"
        />
      </div>
      <p class="text-xs text-muted">
        Opens Slack in your browser. Approval requests and notifications are then posted as you.
      </p>
    </div>
    <p v-if="refused" class="text-sm text-error" role="alert">{{ refused }}</p>
    <p v-if="done" class="text-sm text-success" role="status">{{ done }}</p>
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
        v-if="state?.signedIn"
        label="Sign out"
        variant="ghost"
        size="sm"
        :disabled="busy"
        @click="forget"
      />
    </div>
    <p class="text-sm text-muted">Talking to Collie in Slack is not built.</p>
  </div>
</template>
